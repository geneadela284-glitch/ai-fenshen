import { AI_CAPABILITIES, isAICapability } from './capability.js';
import {
  ATTACHMENT_FIELDS,
  ATTACHMENT_TYPES,
  MAX_ATTACHMENTS_PER_REQUEST,
  MAX_ATTACHMENT_SIZE_BYTES
} from './attachment.js';
import {
  AI_GATEWAY_SCHEMA_VERSION,
  AI_REQUEST_FIELDS,
  MAX_CONTEXT_BYTES,
  MAX_METADATA_BYTES
} from './aiRequest.js';
import { AI_RESPONSE_FIELDS } from './aiResponse.js';
import { ERROR_CODES, ERROR_RETRYABILITY, isGatewayErrorCode } from './errorCodes.js';
import {
  FALLBACK_ATTEMPT_FIELDS,
  MAX_FALLBACK_ATTEMPTS,
  ROUTE_CANDIDATE_FIELDS,
  ROUTE_DECISION_FIELDS
} from './routeDecision.js';
import {
  OPTIONAL_PROVIDER_ADAPTER_METHODS,
  REQUIRED_PROVIDER_ADAPTER_METHODS
} from './providerAdapterContract.js';
import { inferToolRiskLevel, TOOL_PROPOSAL_FIELDS, TOOL_RISK_LEVELS } from './toolProposal.js';

const TRACE_FIELDS = new Set([
  'traceId', 'requestId', 'userIdHash', 'workspaceIdHash', 'capability',
  'providerId', 'modelId', 'routeReason', 'attempts', 'startedAt', 'completedAt',
  'durationMs', 'success', 'errorCode', 'tokenUsage', 'estimatedCost', 'warnings'
]);
const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|password|passwd|secret|session[-_]?cookie)/i;
const UNSAFE_DIAGNOSTIC_KEY = /(stack|absolute[-_]?path|full[-_]?input|prompt|attachment[-_]?content)/i;
const UNSAFE_DIAGNOSTIC_VALUE = /(api[-_\s]?key|authorization|cookie|password|passwd|secret|bearer\s+|sk-[\w-]+|\/Users\/|\/home\/|\/root\/|[A-Za-z]:[\\/])/i;
const BASE64_PATTERN = /^(?:data:[^;]+;base64,)?[A-Za-z0-9+/]{1024,}={0,2}$/;

function issue(path, code, message) {
  return { path, code, message };
}

function result(errors = [], warnings = []) {
  return { valid: errors.length === 0, errors, warnings };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIsoDate(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function byteSize(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validateUnknownFields(value, allowedFields, errors, prefix = '') {
  if (!isObject(value)) return;
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(issue(prefix ? `${prefix}.${key}` : key, 'UNKNOWN_FIELD', `Unknown field: ${key}`));
  }
}

function findSensitiveKeys(value, path = '') {
  if (!value || typeof value !== 'object') return [];
  const findings = [];
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (SENSITIVE_KEY.test(key)) findings.push(nestedPath);
    findings.push(...findSensitiveKeys(nested, nestedPath));
  }
  return findings;
}

function containsUnsafeDiagnostic(value) {
  if (typeof value === 'string') return UNSAFE_DIAGNOSTIC_VALUE.test(value);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => UNSAFE_DIAGNOSTIC_KEY.test(key) || containsUnsafeDiagnostic(nested));
}

function validateTokenUsage(value, errors, path = 'tokenUsage') {
  if (value === null) return;
  if (!isObject(value)) {
    errors.push(issue(path, 'INVALID_TYPE', `${path} must be an object or null.`));
    return;
  }
  for (const [key, count] of Object.entries(value)) {
    if (!Number.isFinite(count) || count < 0) errors.push(issue(`${path}.${key}`, 'INVALID_USAGE', 'Token usage values must be non-negative numbers.'));
  }
}

function validateEstimatedCost(value, errors, path = 'estimatedCost') {
  if (value === null) return;
  if (!isObject(value) || !Number.isFinite(value.amount) || value.amount < 0 || !isNonEmptyString(value.currency)) {
    errors.push(issue(path, 'INVALID_COST', 'estimatedCost must contain a non-negative amount and currency, or be null.'));
  }
}

function validateGatewayError(value, errors, path = 'error') {
  if (!isObject(value)) {
    errors.push(issue(path, 'INVALID_ERROR', 'A standard Gateway error object is required.'));
    return;
  }
  if (!isGatewayErrorCode(value.code)) errors.push(issue(`${path}.code`, 'INVALID_ERROR_CODE', 'Unknown Gateway error code.'));
  if (!isNonEmptyString(value.message)) errors.push(issue(`${path}.message`, 'REQUIRED', 'Error message is required.'));
  if (typeof value.retryable !== 'boolean') {
    errors.push(issue(`${path}.retryable`, 'INVALID_TYPE', 'retryable must be boolean.'));
  } else if (isGatewayErrorCode(value.code) && value.retryable !== ERROR_RETRYABILITY[value.code]) {
    errors.push(issue(`${path}.retryable`, 'INVALID_RETRYABILITY', 'retryable does not match the frozen error classification.'));
  }
  if (!isIsoDate(value.occurredAt)) errors.push(issue(`${path}.occurredAt`, 'INVALID_DATE', 'occurredAt must be an ISO date.'));
  for (const sensitivePath of findSensitiveKeys(value)) {
    errors.push(issue(`${path}.${sensitivePath}`, 'SENSITIVE_FIELD_FORBIDDEN', 'Gateway errors cannot include secrets.'));
  }
  if (containsUnsafeDiagnostic(value)) {
    errors.push(issue(path, 'UNSAFE_ERROR_DIAGNOSTIC', 'Gateway errors cannot include secrets, stack traces, or internal paths.'));
  }
}

function validateFallbackChain(chain, errors, path = 'fallbackChain') {
  if (!Array.isArray(chain)) {
    errors.push(issue(path, 'INVALID_TYPE', 'fallbackChain must be an array.'));
    return;
  }
  if (chain.length > MAX_FALLBACK_ATTEMPTS) errors.push(issue(path, 'MAX_ATTEMPTS_EXCEEDED', `fallbackChain cannot exceed ${MAX_FALLBACK_ATTEMPTS} attempts.`));
  const seen = new Set();
  chain.forEach((attempt, index) => {
    const attemptPath = `${path}[${index}]`;
    if (!isObject(attempt)) {
      errors.push(issue(attemptPath, 'INVALID_TYPE', 'Fallback attempt must be an object.'));
      return;
    }
    validateUnknownFields(attempt, FALLBACK_ATTEMPT_FIELDS, errors, attemptPath);
    if (!Number.isInteger(attempt.attempt) || attempt.attempt !== index + 1) errors.push(issue(`${attemptPath}.attempt`, 'INVALID_ATTEMPT', 'Attempts must be sequential and one-based.'));
    if (!isNonEmptyString(attempt.providerId)) errors.push(issue(`${attemptPath}.providerId`, 'REQUIRED', 'providerId is required.'));
    if (!isNonEmptyString(attempt.modelId)) errors.push(issue(`${attemptPath}.modelId`, 'REQUIRED', 'modelId is required.'));
    const key = `${attempt.providerId || ''}::${attempt.modelId || ''}`;
    if (seen.has(key)) errors.push(issue(attemptPath, 'DUPLICATE_ATTEMPT', 'The same Provider and Model cannot be attempted twice.'));
    seen.add(key);
    if (!isIsoDate(attempt.startedAt)) errors.push(issue(`${attemptPath}.startedAt`, 'INVALID_DATE', 'startedAt must be an ISO date.'));
    if (!Number.isFinite(attempt.durationMs) || attempt.durationMs < 0) errors.push(issue(`${attemptPath}.durationMs`, 'INVALID_DURATION', 'durationMs must be non-negative.'));
    if (typeof attempt.success !== 'boolean') errors.push(issue(`${attemptPath}.success`, 'INVALID_TYPE', 'success must be boolean.'));
    if (attempt.errorCode !== null && attempt.errorCode !== undefined && !ERROR_CODES.includes(attempt.errorCode)) errors.push(issue(`${attemptPath}.errorCode`, 'INVALID_ERROR_CODE', 'Unknown fallback error code.'));
    if (typeof attempt.retryable !== 'boolean') errors.push(issue(`${attemptPath}.retryable`, 'INVALID_TYPE', 'retryable must be boolean.'));
  });
}

export function validateAttachment(attachment) {
  try {
    const errors = [];
    const warnings = [];
    if (!isObject(attachment)) return result([issue('', 'INVALID_ATTACHMENT', 'Attachment must be an object.')], warnings);
    validateUnknownFields(attachment, ATTACHMENT_FIELDS, errors);
    for (const field of ['id', 'type', 'mimeType', 'fileName', 'storageRef']) {
      if (!isNonEmptyString(attachment[field])) errors.push(issue(field, 'REQUIRED', `${field} is required.`));
    }
    if (!ATTACHMENT_TYPES.includes(attachment.type)) errors.push(issue('type', 'INVALID_ATTACHMENT_TYPE', 'Attachment type must be image, audio, or document.'));
    if (!Number.isInteger(attachment.sizeBytes) || attachment.sizeBytes < 0) errors.push(issue('sizeBytes', 'INVALID_SIZE', 'sizeBytes must be a non-negative integer.'));
    if (attachment.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES) errors.push(issue('sizeBytes', 'ATTACHMENT_TOO_LARGE', `Attachment exceeds ${MAX_ATTACHMENT_SIZE_BYTES} bytes.`));
    if (isNonEmptyString(attachment.mimeType) && !/^[\w.+-]+\/[\w.+-]+$/i.test(attachment.mimeType)) errors.push(issue('mimeType', 'INVALID_MIME_TYPE', 'mimeType is invalid.'));
    if (attachment.type === 'image' && !String(attachment.mimeType || '').startsWith('image/')) errors.push(issue('mimeType', 'MIME_TYPE_MISMATCH', 'Image attachments require an image MIME type.'));
    if (attachment.type === 'audio' && !String(attachment.mimeType || '').startsWith('audio/')) errors.push(issue('mimeType', 'MIME_TYPE_MISMATCH', 'Audio attachments require an audio MIME type.'));
    if (attachment.type === 'document' && /^(image|audio)\//.test(String(attachment.mimeType || ''))) errors.push(issue('mimeType', 'MIME_TYPE_MISMATCH', 'Document attachments cannot use image or audio MIME types.'));
    if (/^(?:\/|[A-Za-z]:[\\/]|file:\/\/)/.test(String(attachment.storageRef || ''))) errors.push(issue('storageRef', 'ABSOLUTE_PATH_FORBIDDEN', 'storageRef cannot expose an absolute local path.'));
    for (const [key, value] of Object.entries(attachment)) {
      if ((key.toLowerCase().includes('base64') || key === 'data' || key === 'content') && typeof value === 'string' && BASE64_PATTERN.test(value.replace(/^data:[^,]+,/, ''))) {
        errors.push(issue(key, 'INLINE_BINARY_FORBIDDEN', 'Binary Base64 content must use storageRef instead.'));
      }
    }
    for (const sensitivePath of findSensitiveKeys(attachment.metadata)) errors.push(issue(`metadata.${sensitivePath}`, 'SENSITIVE_FIELD_FORBIDDEN', 'Attachment metadata cannot contain secrets.'));
    return result(errors, warnings);
  } catch {
    return result([issue('', 'VALIDATION_FAILED', 'Attachment validation could not be completed.')]);
  }
}

export function validateAIRequest(request, { seenRequestIds = null } = {}) {
  try {
    const errors = [];
    const warnings = [];
    if (!isObject(request)) return result([issue('', 'INVALID_REQUEST', 'AIRequest must be an object.')], warnings);
    validateUnknownFields(request, AI_REQUEST_FIELDS, errors);
    if (request.schemaVersion !== AI_GATEWAY_SCHEMA_VERSION) errors.push(issue('schemaVersion', 'UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion must be v1.'));
    for (const field of ['requestId', 'userId', 'workspaceId']) {
      if (!isNonEmptyString(request[field])) errors.push(issue(field, 'REQUIRED', `${field} is required.`));
    }
    if (isNonEmptyString(request.requestId) && seenRequestIds?.has?.(request.requestId)) {
      errors.push(issue('requestId', 'DUPLICATE_REQUEST_ID', 'requestId already exists in the current request scope.'));
    }
    if (request.conversationId !== null && request.conversationId !== undefined && !isNonEmptyString(request.conversationId)) errors.push(issue('conversationId', 'INVALID_TYPE', 'conversationId must be a non-empty string or null.'));
    if (typeof request.input !== 'string') errors.push(issue('input', 'INVALID_TYPE', 'input must be a string.'));
    if (!Array.isArray(request.attachments)) {
      errors.push(issue('attachments', 'INVALID_TYPE', 'attachments must be an array.'));
    } else {
      if (request.attachments.length > MAX_ATTACHMENTS_PER_REQUEST) errors.push(issue('attachments', 'TOO_MANY_ATTACHMENTS', `No more than ${MAX_ATTACHMENTS_PER_REQUEST} attachments are allowed.`));
      request.attachments.forEach((attachment, index) => {
        const validation = validateAttachment(attachment);
        validation.errors.forEach((error) => errors.push({ ...error, path: `attachments[${index}]${error.path ? `.${error.path}` : ''}` }));
        validation.warnings.forEach((warning) => warnings.push({ ...warning, path: `attachments[${index}]${warning.path ? `.${warning.path}` : ''}` }));
      });
    }
    const hasInput = typeof request.input === 'string' && request.input.trim().length > 0;
    const hasAttachments = Array.isArray(request.attachments) && request.attachments.length > 0;
    if (!hasInput && !hasAttachments) errors.push(issue('input', 'INPUT_OR_ATTACHMENT_REQUIRED', 'input and attachments cannot both be empty.'));
    if (!isAICapability(request.capability)) errors.push(issue('capability', 'INVALID_CAPABILITY', `capability must be one of: ${AI_CAPABILITIES.join(', ')}.`));
    if (!isObject(request.context)) errors.push(issue('context', 'INVALID_TYPE', 'context must be an object.'));
    else if (byteSize(request.context) > MAX_CONTEXT_BYTES) errors.push(issue('context', 'CONTEXT_TOO_LARGE', `context cannot exceed ${MAX_CONTEXT_BYTES} bytes.`));
    if (!isObject(request.metadata)) errors.push(issue('metadata', 'INVALID_TYPE', 'metadata must be an object.'));
    else if (byteSize(request.metadata) > MAX_METADATA_BYTES) errors.push(issue('metadata', 'METADATA_TOO_LARGE', `metadata cannot exceed ${MAX_METADATA_BYTES} bytes.`));
    for (const sensitivePath of findSensitiveKeys(request.metadata)) errors.push(issue(`metadata.${sensitivePath}`, 'SENSITIVE_FIELD_FORBIDDEN', 'AIRequest metadata cannot contain secrets.'));
    for (const sensitivePath of findSensitiveKeys(request.context)) errors.push(issue(`context.${sensitivePath}`, 'SENSITIVE_FIELD_FORBIDDEN', 'AIRequest context cannot contain secrets.'));
    if (!isIsoDate(request.createdAt)) errors.push(issue('createdAt', 'INVALID_DATE', 'createdAt must be an ISO date.'));
    if (!Number.isFinite(request.maxLatencyMs) || request.maxLatencyMs <= 0) errors.push(issue('maxLatencyMs', 'INVALID_LATENCY', 'maxLatencyMs must be a positive number.'));
    return result(errors, warnings);
  } catch {
    return result([issue('', 'VALIDATION_FAILED', 'AIRequest validation could not be completed.')]);
  }
}

export function validateAIResponse(response) {
  try {
    const errors = [];
    const warnings = [];
    if (!isObject(response)) return result([issue('', 'INVALID_RESPONSE', 'AIResponse must be an object.')], warnings);
    validateUnknownFields(response, AI_RESPONSE_FIELDS, errors);
    if (response.schemaVersion !== AI_GATEWAY_SCHEMA_VERSION) errors.push(issue('schemaVersion', 'UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion must be v1.'));
    if (!isNonEmptyString(response.requestId)) errors.push(issue('requestId', 'REQUIRED', 'requestId is required.'));
    if (typeof response.success !== 'boolean') errors.push(issue('success', 'INVALID_TYPE', 'success must be boolean.'));
    if (response.content !== null && typeof response.content !== 'string') errors.push(issue('content', 'INVALID_TYPE', 'content must be a string or null.'));
    if (!isAICapability(response.capability)) errors.push(issue('capability', 'INVALID_CAPABILITY', 'Response capability is invalid.'));
    if (response.deterministicResult !== null) {
      if (!isObject(response.deterministicResult) || response.deterministicResult.immutable !== true) errors.push(issue('deterministicResult.immutable', 'DETERMINISTIC_RESULT_NOT_LOCKED', 'deterministicResult must be marked immutable.'));
    }
    if (response.success === false) validateGatewayError(response.error, errors);
    if (response.success === true && response.error !== null) warnings.push(issue('error', 'ERROR_ON_SUCCESS', 'Successful responses should not include an error.'));
    validateFallbackChain(response.fallbackChain, errors);
    if (!Number.isFinite(response.durationMs) || response.durationMs < 0) errors.push(issue('durationMs', 'INVALID_DURATION', 'durationMs must be non-negative.'));
    validateTokenUsage(response.tokenUsage, errors);
    validateEstimatedCost(response.estimatedCost, errors);
    if (!Array.isArray(response.warnings)) errors.push(issue('warnings', 'INVALID_TYPE', 'warnings must be an array.'));
    if (!isIsoDate(response.createdAt)) errors.push(issue('createdAt', 'INVALID_DATE', 'createdAt must be an ISO date.'));
    return result(errors, warnings);
  } catch {
    return result([issue('', 'VALIDATION_FAILED', 'AIResponse validation could not be completed.')]);
  }
}

function validateCandidate(candidate, errors, path) {
  if (!isObject(candidate)) {
    errors.push(issue(path, 'INVALID_TYPE', 'Route candidate must be an object.'));
    return;
  }
  validateUnknownFields(candidate, ROUTE_CANDIDATE_FIELDS, errors, path);
  for (const field of ['providerId', 'modelId']) if (!isNonEmptyString(candidate[field])) errors.push(issue(`${path}.${field}`, 'REQUIRED', `${field} is required.`));
  for (const field of ['supported', 'enabled', 'configured', 'verified', 'healthy']) if (typeof candidate[field] !== 'boolean') errors.push(issue(`${path}.${field}`, 'INVALID_TYPE', `${field} must be boolean.`));
  if (!Number.isFinite(candidate.score)) errors.push(issue(`${path}.score`, 'INVALID_SCORE', 'score must be a number.'));
  if (candidate.latencyMs !== null && candidate.latencyMs !== undefined && (!Number.isFinite(candidate.latencyMs) || candidate.latencyMs < 0)) errors.push(issue(`${path}.latencyMs`, 'INVALID_LATENCY', 'latencyMs must be non-negative or null.'));
  if (!Array.isArray(candidate.rejectionReasons)) errors.push(issue(`${path}.rejectionReasons`, 'INVALID_TYPE', 'rejectionReasons must be an array.'));
  if (candidate.supported === false && (!Array.isArray(candidate.rejectionReasons) || candidate.rejectionReasons.length === 0)) errors.push(issue(`${path}.rejectionReasons`, 'MISSING_REJECTION_REASON', 'Capability mismatch must have an explicit rejection reason.'));
}

export function validateRouteDecision(decision) {
  try {
    const errors = [];
    const warnings = [];
    if (!isObject(decision)) return result([issue('', 'INVALID_ROUTE_DECISION', 'RouteDecision must be an object.')], warnings);
    validateUnknownFields(decision, ROUTE_DECISION_FIELDS, errors);
    if (!isAICapability(decision.capability)) errors.push(issue('capability', 'INVALID_CAPABILITY', 'Route capability is invalid.'));
    if (!Array.isArray(decision.candidates)) errors.push(issue('candidates', 'INVALID_TYPE', 'candidates must be an array.'));
    else decision.candidates.forEach((candidate, index) => validateCandidate(candidate, errors, `candidates[${index}]`));
    if (!Array.isArray(decision.rejectedCandidates)) errors.push(issue('rejectedCandidates', 'INVALID_TYPE', 'rejectedCandidates must be an array.'));
    else decision.rejectedCandidates.forEach((candidate, index) => validateCandidate(candidate, errors, `rejectedCandidates[${index}]`));
    if (!Number.isFinite(decision.routeConfidence) || decision.routeConfidence < 0 || decision.routeConfidence > 1) errors.push(issue('routeConfidence', 'INVALID_CONFIDENCE', 'routeConfidence must be between 0 and 1.'));
    if (!isIsoDate(decision.decidedAt)) errors.push(issue('decidedAt', 'INVALID_DATE', 'decidedAt must be an ISO date.'));
    const maxAttempts = decision.fallbackPolicy?.maxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_FALLBACK_ATTEMPTS) errors.push(issue('fallbackPolicy.maxAttempts', 'INVALID_MAX_ATTEMPTS', `maxAttempts must be between 1 and ${MAX_FALLBACK_ATTEMPTS}.`));
    if (decision.selectedProvider || decision.selectedModel) {
      const selected = Array.isArray(decision.candidates)
        ? decision.candidates.find((candidate) => candidate.providerId === decision.selectedProvider && candidate.modelId === decision.selectedModel)
        : null;
      if (!selected) errors.push(issue('selectedProvider', 'SELECTION_NOT_IN_CANDIDATES', 'Selected Provider and Model must exist in candidates.'));
      else {
        if (!selected.supported) errors.push(issue('selectedModel', 'CAPABILITY_NOT_SUPPORTED', 'Selected candidate does not support the capability.'));
        if (!selected.enabled || !selected.configured) errors.push(issue('selectedModel', 'INELIGIBLE_SELECTION', 'Disabled or unconfigured candidates cannot be selected.'));
        if ((!selected.verified || !selected.healthy) && decision.fallbackPolicy?.developmentDiagnosticMode !== true) errors.push(issue('selectedModel', 'UNVERIFIED_SELECTION', 'Unverified or unhealthy models cannot be selected by default.'));
      }
    }
    return result(errors, warnings);
  } catch {
    return result([issue('', 'VALIDATION_FAILED', 'RouteDecision validation could not be completed.')]);
  }
}

export function validateTrace(trace) {
  try {
    const errors = [];
    const warnings = [];
    if (!isObject(trace)) return result([issue('', 'INVALID_TRACE', 'Trace must be an object.')], warnings);
    validateUnknownFields(trace, TRACE_FIELDS, errors);
    for (const field of ['traceId', 'requestId', 'userIdHash', 'workspaceIdHash']) if (!isNonEmptyString(trace[field])) errors.push(issue(field, 'REQUIRED', `${field} is required.`));
    if (!isAICapability(trace.capability)) errors.push(issue('capability', 'INVALID_CAPABILITY', 'Trace capability is invalid.'));
    if (!Array.isArray(trace.attempts)) errors.push(issue('attempts', 'INVALID_TYPE', 'attempts must be an array.'));
    else if (trace.attempts.length > MAX_FALLBACK_ATTEMPTS) errors.push(issue('attempts', 'MAX_ATTEMPTS_EXCEEDED', `Trace cannot contain more than ${MAX_FALLBACK_ATTEMPTS} attempts.`));
    if (!isIsoDate(trace.startedAt)) errors.push(issue('startedAt', 'INVALID_DATE', 'startedAt must be an ISO date.'));
    if (!isIsoDate(trace.completedAt)) errors.push(issue('completedAt', 'INVALID_DATE', 'completedAt must be an ISO date.'));
    if (!Number.isFinite(trace.durationMs) || trace.durationMs < 0) errors.push(issue('durationMs', 'INVALID_DURATION', 'durationMs must be non-negative.'));
    if (typeof trace.success !== 'boolean') errors.push(issue('success', 'INVALID_TYPE', 'success must be boolean.'));
    if (trace.errorCode !== null && trace.errorCode !== undefined && !isGatewayErrorCode(trace.errorCode)) errors.push(issue('errorCode', 'INVALID_ERROR_CODE', 'Unknown Trace error code.'));
    validateTokenUsage(trace.tokenUsage, errors);
    validateEstimatedCost(trace.estimatedCost, errors);
    if (!Array.isArray(trace.warnings)) errors.push(issue('warnings', 'INVALID_TYPE', 'warnings must be an array.'));
    for (const sensitivePath of findSensitiveKeys(trace)) errors.push(issue(sensitivePath, 'SENSITIVE_FIELD_FORBIDDEN', 'Trace cannot contain secrets.'));
    return result(errors, warnings);
  } catch {
    return result([issue('', 'VALIDATION_FAILED', 'Trace validation could not be completed.')]);
  }
}

function containsDeterministicResult(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => /^(deterministicResult|dataTrustResult)$/i.test(key) || containsDeterministicResult(nested));
}

export function validateToolProposal(proposal) {
  try {
    const errors = [];
    const warnings = [];
    if (!isObject(proposal)) return result([issue('', 'INVALID_TOOL_PROPOSAL', 'ToolProposal must be an object.')], warnings);
    validateUnknownFields(proposal, TOOL_PROPOSAL_FIELDS, errors);
    for (const field of ['proposalId', 'requestId', 'toolName', 'idempotencyKey', 'reason']) if (!isNonEmptyString(proposal[field])) errors.push(issue(field, 'REQUIRED', `${field} is required.`));
    if (!isObject(proposal.arguments)) errors.push(issue('arguments', 'INVALID_TYPE', 'arguments must be an object.'));
    if (!TOOL_RISK_LEVELS.includes(proposal.riskLevel)) errors.push(issue('riskLevel', 'INVALID_RISK_LEVEL', 'Unknown tool risk level.'));
    const minimumRisk = inferToolRiskLevel(proposal.toolName, proposal.arguments);
    if (proposal.riskLevel !== minimumRisk) errors.push(issue('riskLevel', 'RISK_DOWNGRADE_FORBIDDEN', `Tool risk must be ${minimumRisk}.`));
    const requiresConfirmation = !['read_only', 'draft'].includes(minimumRisk);
    if (proposal.confirmationRequired !== requiresConfirmation) errors.push(issue('confirmationRequired', 'INVALID_CONFIRMATION_POLICY', 'confirmationRequired does not match the tool risk.'));
    if (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1) errors.push(issue('confidence', 'INVALID_CONFIDENCE', 'confidence must be between 0 and 1.'));
    if (!isIsoDate(proposal.createdAt)) errors.push(issue('createdAt', 'INVALID_DATE', 'createdAt must be an ISO date.'));
    if (containsDeterministicResult(proposal.arguments)) errors.push(issue('arguments', 'DETERMINISTIC_RESULT_IMMUTABLE', 'Tool proposals cannot modify DataTrustService deterministic results.'));
    for (const sensitivePath of findSensitiveKeys(proposal.arguments)) errors.push(issue(`arguments.${sensitivePath}`, 'SENSITIVE_FIELD_FORBIDDEN', 'Tool arguments cannot contain secrets.'));
    return result(errors, warnings);
  } catch {
    return result([issue('', 'VALIDATION_FAILED', 'ToolProposal validation could not be completed.')]);
  }
}

export function validateProviderAdapter(adapter) {
  try {
    const errors = [];
    const warnings = [];
    if (!isObject(adapter)) return result([issue('', 'INVALID_PROVIDER_ADAPTER', 'Provider Adapter must be an object.')], warnings);
    if (!isNonEmptyString(adapter.providerId)) errors.push(issue('providerId', 'REQUIRED', 'providerId is required.'));
    for (const method of REQUIRED_PROVIDER_ADAPTER_METHODS) {
      if (typeof adapter[method] !== 'function') errors.push(issue(method, 'REQUIRED_METHOD_MISSING', `Required Provider Adapter method ${method}() is not implemented.`));
    }
    for (const method of OPTIONAL_PROVIDER_ADAPTER_METHODS) {
      if (typeof adapter[method] !== 'function') warnings.push(issue(method, 'OPTIONAL_METHOD_MISSING', `Optional Provider Adapter method ${method}() is not implemented.`));
    }
    return result(errors, warnings);
  } catch {
    return result([issue('', 'VALIDATION_FAILED', 'Provider Adapter validation could not be completed.')]);
  }
}
