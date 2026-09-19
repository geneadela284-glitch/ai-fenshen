import assert from 'node:assert/strict';
import test from 'node:test';
import { getProviderAdapter } from '../../providers/providerAdapters.js';
import providerRegistry from '../../providers/providerRegistry.js';

const protocol = await import('./index.js').catch(() => ({}));

const {
  AI_CAPABILITIES,
  DETERMINISTIC_SYSTEM_CAPABILITIES,
  ERROR_CODES,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_FALLBACK_ATTEMPTS,
  createAIRequest,
  createAIResponse,
  createGatewayError,
  createToolProposal,
  legacyErrorToGatewayError,
  legacyInputToAIRequest,
  legacyProviderResponseToAIResponse,
  sanitizeTrace,
  validateAIRequest,
  validateAIResponse,
  validateAttachment,
  validateProviderAdapter,
  validateRouteDecision,
  validateToolProposal,
  validateTrace
} = protocol;

function validAttachment(overrides = {}) {
  return {
    id: 'attachment-1',
    type: 'document',
    mimeType: 'application/pdf',
    fileName: 'quote.pdf',
    sizeBytes: 1024,
    storageRef: 'upload:attachment-1',
    checksum: 'sha256:abc123',
    width: null,
    height: null,
    durationMs: null,
    metadata: {},
    ...overrides
  };
}

function validRequest(overrides = {}) {
  return {
    schemaVersion: 'v1',
    requestId: 'request-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    conversationId: 'conversation-1',
    input: '整理这份报价',
    attachments: [],
    intent: 'prepare_quote',
    capability: 'writing',
    context: {},
    locale: 'zh-CN',
    timezone: 'Asia/Shanghai',
    privacyLevel: 'private',
    maxLatencyMs: 30000,
    maxCost: null,
    preferredPolicy: 'balanced',
    metadata: {},
    createdAt: '2026-07-14T08:00:00.000Z',
    ...overrides
  };
}

function validError(overrides = {}) {
  return {
    code: 'TIMEOUT',
    message: 'AI 服务响应超时，请稍后重试。',
    retryable: true,
    providerId: null,
    modelId: null,
    details: null,
    cause: null,
    occurredAt: '2026-07-14T08:00:01.000Z',
    ...overrides
  };
}

function validResponse(overrides = {}) {
  return {
    schemaVersion: 'v1',
    requestId: 'request-1',
    success: true,
    content: '已整理完成。',
    structuredOutput: null,
    deterministicResult: null,
    capability: 'writing',
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    routeReason: '能力匹配且已验证',
    fallbackChain: [],
    durationMs: 1200,
    tokenUsage: null,
    estimatedCost: null,
    error: null,
    traceId: 'trace-1',
    warnings: [],
    createdAt: '2026-07-14T08:00:01.000Z',
    ...overrides
  };
}

function validCandidate(overrides = {}) {
  return {
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    supported: true,
    enabled: true,
    configured: true,
    verified: true,
    healthy: true,
    score: 90,
    latencyMs: 500,
    estimatedCost: null,
    rejectionReasons: [],
    ...overrides
  };
}

function validRouteDecision(overrides = {}) {
  return {
    capability: 'writing',
    selectedProvider: 'deepseek',
    selectedModel: 'deepseek-chat',
    score: 90,
    reason: '能力匹配且已验证',
    routeConfidence: 0.9,
    candidates: [validCandidate()],
    rejectedCandidates: [],
    fallbackPolicy: { maxAttempts: 2, developmentDiagnosticMode: false },
    decidedAt: '2026-07-14T08:00:00.100Z',
    ...overrides
  };
}

test('exports the frozen v1 capability groups and excludes deterministic system capabilities from model capabilities', () => {
  assert.equal(Array.isArray(AI_CAPABILITIES), true);
  assert.deepEqual(AI_CAPABILITIES, [
    'chat', 'writing', 'reasoning', 'summarization', 'structured_extraction',
    'data_explanation', 'vision', 'ocr', 'translation', 'meeting_transcription',
    'meeting_summary', 'tool_call', 'knowledge_query', 'memory_query'
  ]);
  assert.deepEqual(DETERMINISTIC_SYSTEM_CAPABILITIES, [
    'current_date', 'current_time', 'expense_calculation', 'income_calculation',
    'balance_calculation', 'schedule_lookup'
  ]);
  assert.equal(AI_CAPABILITIES.includes('current_date'), false);
});

test('accepts a valid AIRequest without mutating it', () => {
  const request = validRequest();
  const snapshot = structuredClone(request);
  assert.deepEqual(validateAIRequest(request), { valid: true, errors: [], warnings: [] });
  assert.deepEqual(request, snapshot);
});

test('rejects AIRequest without requestId', () => {
  const result = validateAIRequest(validRequest({ requestId: '' }));
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.path === 'requestId'), true);
});

test('rejects a requestId already present in the caller request scope', () => {
  const result = validateAIRequest(validRequest(), { seenRequestIds: new Set(['request-1']) });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.code === 'DUPLICATE_REQUEST_ID'), true);
});

test('rejects AIRequest without userId', () => {
  const result = validateAIRequest(validRequest({ userId: '' }));
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.path === 'userId'), true);
});

test('rejects AIRequest when both input and attachments are empty', () => {
  const result = validateAIRequest(validRequest({ input: '  ', attachments: [] }));
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.code === 'INPUT_OR_ATTACHMENT_REQUIRED'), true);
});

test('rejects unknown fields, invalid capabilities, oversized context and sensitive metadata', () => {
  const result = validateAIRequest(validRequest({
    capability: 'current_date',
    context: { text: 'x'.repeat(70_000) },
    metadata: { apiKey: 'secret', nested: { password: 'secret' } },
    unexpected: true
  }));
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.path === 'capability'), true);
  assert.equal(result.errors.some((error) => error.path === 'context'), true);
  assert.equal(result.errors.some((error) => error.code === 'SENSITIVE_FIELD_FORBIDDEN'), true);
  assert.equal(result.errors.some((error) => error.code === 'UNKNOWN_FIELD'), true);
});

test('accepts a complete attachment and rejects filename-only visual claims', () => {
  assert.equal(validateAttachment(validAttachment()).valid, true);
  const result = validateAttachment({ fileName: 'image.png' });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.path === 'storageRef'), true);
});

test('rejects oversized attachments, large Base64 payloads, MIME mismatches and absolute paths', () => {
  assert.equal(validateAttachment(validAttachment({ sizeBytes: MAX_ATTACHMENT_SIZE_BYTES + 1 })).valid, false);
  assert.equal(validateAttachment(validAttachment({ data: `data:image/png;base64,${'a'.repeat(200_000)}` })).valid, false);
  assert.equal(validateAttachment(validAttachment({ type: 'image', mimeType: 'application/pdf' })).valid, false);
  assert.equal(validateAttachment(validAttachment({ storageRef: '/Users/example/private/quote.pdf' })).valid, false);
});

test('requires a standard error when AIResponse success is false', () => {
  const result = validateAIResponse(validResponse({ success: false, content: null, error: null }));
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.path === 'error'), true);
});

test('locks deterministicResult separately from generated content', () => {
  const response = createAIResponse({
    ...validResponse(),
    content: '模型声称总额是 999 元',
    deterministicResult: { total: 100, source: 'DataTrustService' }
  });
  assert.equal(response.deterministicResult.total, 100);
  assert.equal(response.deterministicResult.immutable, true);
  assert.equal(Object.isFrozen(response.deterministicResult), true);
  assert.equal(validateAIResponse(response).valid, true);
});

test('freezes the complete standard error code list and classifies retryability conservatively', () => {
  assert.deepEqual(ERROR_CODES, [
    'INVALID_REQUEST', 'AUTH_FAILED', 'MODEL_NOT_FOUND', 'PROVIDER_UNAVAILABLE',
    'RATE_LIMITED', 'TIMEOUT', 'INVALID_RESPONSE', 'CAPABILITY_NOT_SUPPORTED',
    'SAFETY_BLOCKED', 'ATTACHMENT_NOT_SUPPORTED', 'STRUCTURED_OUTPUT_INVALID',
    'TOOL_VALIDATION_FAILED', 'TOOL_CONFIRMATION_REQUIRED', 'ALL_PROVIDERS_FAILED',
    'INTERNAL_ERROR'
  ]);
  assert.equal(createGatewayError({ code: 'TIMEOUT' }).retryable, true);
  assert.equal(createGatewayError({ code: 'RATE_LIMITED' }).retryable, true);
  assert.equal(createGatewayError({ code: 'AUTH_FAILED' }).retryable, false);
  assert.equal(createGatewayError({ code: 'SAFETY_BLOCKED' }).retryable, false);
});

test('sanitizes unsafe Gateway error messages and diagnostic fields', () => {
  const error = createGatewayError({
    code: 'INTERNAL_ERROR',
    message: 'API Key sk-example failed at /Users/private/server.js:1',
    details: { password: 'secret', safeCode: 'UPSTREAM_FAILURE' },
    cause: { stack: '/Users/private/server.js:1', status: 500 },
    occurredAt: '2026-07-14T08:00:01.000Z'
  });
  const serialized = JSON.stringify(error).toLowerCase();
  assert.equal(serialized.includes('sk-example'), false);
  assert.equal(serialized.includes('/users/private'), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('stack'), false);
  assert.equal(error.details.safeCode, 'UPSTREAM_FAILURE');
});

test('rejects manually supplied unsafe Gateway error diagnostics', () => {
  const response = validResponse({
    success: false,
    content: null,
    error: validError({
      message: 'failed at /Users/private/server.js:1',
      details: { stack: '/Users/private/server.js:1' }
    })
  });
  const validation = validateAIResponse(response);
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((error) => error.code === 'UNSAFE_ERROR_DIAGNOSTIC'), true);
});

test('rejects an unverified selected model outside development diagnostic mode', () => {
  const result = validateRouteDecision(validRouteDecision({
    candidates: [validCandidate({ verified: false, healthy: false })]
  }));
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.code === 'UNVERIFIED_SELECTION'), true);
});

test('rejects disabled or unconfigured selected candidates even when health flags are stale', () => {
  const result = validateRouteDecision(validRouteDecision({
    candidates: [validCandidate({ enabled: false, configured: false })]
  }));
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.code === 'INELIGIBLE_SELECTION'), true);
});

test('requires capability-mismatched candidates to be explicitly rejected', () => {
  const candidate = validCandidate({ supported: false, score: 0, rejectionReasons: [] });
  const result = validateRouteDecision(validRouteDecision({
    selectedProvider: null,
    selectedModel: null,
    score: 0,
    candidates: [],
    rejectedCandidates: [candidate]
  }));
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.code === 'MISSING_REJECTION_REASON'), true);
});

test('limits fallback chain to two unique Provider and Model attempts', () => {
  assert.equal(MAX_FALLBACK_ATTEMPTS, 2);
  const attempt = {
    attempt: 1,
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    startedAt: '2026-07-14T08:00:00.000Z',
    durationMs: 100,
    success: false,
    errorCode: 'TIMEOUT',
    retryable: true,
    reason: 'timeout'
  };
  assert.equal(validateAIResponse(validResponse({ fallbackChain: [attempt, { ...attempt, attempt: 2 }] })).valid, false);
  assert.equal(validateAIResponse(validResponse({
    fallbackChain: [
      attempt,
      { ...attempt, attempt: 2, providerId: 'qwen', modelId: 'qwen-plus' },
      { ...attempt, attempt: 3, providerId: 'zhipu', modelId: 'glm-4' }
    ]
  })).valid, false);
});

test('sanitizes API keys, cookies, passwords, full input and absolute paths from invocation trace', () => {
  const sanitized = sanitizeTrace({
    traceId: 'trace-1',
    requestId: 'request-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    capability: 'writing',
    providerId: 'deepseek',
    modelId: 'deepseek-chat',
    routeReason: 'verified',
    attempts: [{ apiKey: 'secret-key', cookie: 'session=secret', password: 'secret', path: '/Users/private/file.txt' }],
    input: '完整敏感用户输入',
    startedAt: '2026-07-14T08:00:00.000Z',
    completedAt: '2026-07-14T08:00:01.000Z',
    durationMs: 1000,
    success: true,
    errorCode: null,
    tokenUsage: null,
    estimatedCost: null,
    warnings: []
  });
  const serialized = JSON.stringify(sanitized).toLowerCase();
  assert.equal(serialized.includes('secret-key'), false);
  assert.equal(serialized.includes('session=secret'), false);
  assert.equal(serialized.includes('password'), false);
  assert.equal(serialized.includes('完整敏感用户输入'), false);
  assert.equal(serialized.includes('/users/private'), false);
  assert.match(sanitized.userIdHash, /^ref_/);
  assert.equal(validateTrace(sanitized).valid, true);
});

test('enforces tool proposal risk for money writes, deletion and external side effects', () => {
  const money = createToolProposal({
    proposalId: 'proposal-money', requestId: 'request-1', toolName: 'expense.create',
    arguments: { amount: 100 }, reason: '记录支出', confidence: 0.95,
    createdAt: '2026-07-14T08:00:00.000Z'
  });
  const deletion = createToolProposal({
    proposalId: 'proposal-delete', requestId: 'request-1', toolName: 'memory.delete',
    arguments: { id: 'memory-1' }, reason: '删除记忆', confidence: 0.95,
    createdAt: '2026-07-14T08:00:00.000Z'
  });
  const email = createToolProposal({
    proposalId: 'proposal-email', requestId: 'request-1', toolName: 'email.send',
    arguments: { recipient: 'client@example.com' }, reason: '发送邮件', confidence: 0.95,
    createdAt: '2026-07-14T08:00:00.000Z'
  });
  assert.equal(money.riskLevel, 'confirm_required');
  assert.equal(money.confirmationRequired, true);
  assert.equal(deletion.riskLevel, 'destructive');
  assert.equal(email.riskLevel, 'external_side_effect');
  assert.equal(validateToolProposal(money).valid, true);
});

test('rejects proposals that downgrade risk or try to alter a deterministic result', () => {
  const downgraded = {
    proposalId: 'proposal-1', requestId: 'request-1', toolName: 'memory.delete',
    arguments: {}, riskLevel: 'read_only', confirmationRequired: false,
    idempotencyKey: 'idem-1', reason: 'delete', confidence: 0.9,
    createdAt: '2026-07-14T08:00:00.000Z'
  };
  assert.equal(validateToolProposal(downgraded).valid, false);
  assert.equal(validateToolProposal({ ...downgraded, toolName: 'expense.create', arguments: { deterministicResult: { total: 999 } } }).valid, false);
});

test('fails Provider Adapter compatibility when required methods are missing', () => {
  const result = validateProviderAdapter({
    providerId: 'legacy',
    validateConfig() {},
    invoke() {},
    normalizeError() {}
  });
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.path === 'healthCheck'), true);
  assert.equal(result.errors.some((error) => error.path === 'normalizeUsage'), true);
});

test('accepts a complete Provider Adapter and treats vision and structured invocation as optional', () => {
  const adapter = {
    providerId: 'complete',
    validateConfig() {}, healthCheck() {}, listModels() {}, supportsCapability() {},
    invoke() {}, normalizeResponse() {}, normalizeError() {}, normalizeUsage() {}, estimateCost() {}
  };
  assert.deepEqual(validateProviderAdapter(adapter), {
    valid: true,
    errors: [],
    warnings: [
      { path: 'invokeVision', code: 'OPTIONAL_METHOD_MISSING', message: 'Optional Provider Adapter method invokeVision() is not implemented.' },
      { path: 'invokeStructured', code: 'OPTIONAL_METHOD_MISSING', message: 'Optional Provider Adapter method invokeStructured() is not implemented.' }
    ]
  });
});

test('reports the five migrated domestic Provider Adapters as V1 compatible', () => {
  const definitions = providerRegistry.list();
  const report = definitions.map((definition) => ({
    providerId: definition.id,
    compatibility: validateProviderAdapter(getProviderAdapter(definition))
  }));
  const migratedIds = ['deepseek', 'qwen', 'kimi', 'zhipu', 'doubao'];
  const migrated = report.filter((entry) => migratedIds.includes(entry.providerId));
  const legacy = report.filter((entry) => !migratedIds.includes(entry.providerId));
  assert.equal(migrated.length, 5);
  assert.equal(migrated.every((entry) => entry.compatibility.valid === true), true);
  assert.equal(legacy.every((entry) => entry.compatibility.valid === false), true);

  const currentAdapter = getProviderAdapter(providerRegistry.get('deepseek'));
  const compatibility = validateProviderAdapter(currentAdapter);
  assert.equal(compatibility.valid, true);
  assert.deepEqual(compatibility.errors, []);
  assert.deepEqual(compatibility.warnings, []);
  assert.equal(typeof currentAdapter.validateConfig, 'function');
  assert.equal(typeof currentAdapter.invoke, 'function');
  assert.equal(typeof currentAdapter.normalizeError, 'function');
});

test('converts legacy input to AIRequest without modifying the source object', () => {
  const legacy = { id: 'legacy-task-1', prompt: '写一封邮件', taskType: 'write', attachments: [] };
  const snapshot = structuredClone(legacy);
  const result = legacyInputToAIRequest(legacy, {
    userId: 'user-1', workspaceId: 'workspace-1', conversationId: 'conversation-1',
    createdAt: '2026-07-14T08:00:00.000Z'
  });
  assert.equal(result.schemaVersion, 'v1');
  assert.equal(result.requestId, 'legacy-task-1');
  assert.equal(result.input, '写一封邮件');
  assert.equal(result.capability, 'writing');
  assert.deepEqual(legacy, snapshot);
});

test('converts legacy Provider response to AIResponse without modifying it', () => {
  const legacy = { provider: 'deepseek', model: 'deepseek-chat', content: '完成', usage: { total_tokens: 10 } };
  const snapshot = structuredClone(legacy);
  const result = legacyProviderResponseToAIResponse(legacy, {
    requestId: 'request-1', capability: 'writing', traceId: 'trace-1',
    createdAt: '2026-07-14T08:00:01.000Z'
  });
  assert.equal(result.success, true);
  assert.equal(result.content, '完成');
  assert.equal(result.tokenUsage.totalTokens, 10);
  assert.deepEqual(legacy, snapshot);
});

test('normalizes legacy errors to safe Gateway errors without leaking stack or secrets', () => {
  const legacy = new Error('API Key secret failed');
  legacy.code = 'INVALID_API_KEY';
  legacy.stack = '/Users/private/server.js:1 secret';
  const result = legacyErrorToGatewayError(legacy, { occurredAt: '2026-07-14T08:00:01.000Z' });
  assert.equal(result.code, 'AUTH_FAILED');
  assert.equal(result.retryable, false);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  assert.equal(JSON.stringify(result).includes('/Users/private'), false);
});

test('createAIRequest returns a serializable v1 object and never carries API keys', () => {
  const result = createAIRequest(validRequest({ metadata: { source: 'compat' } }));
  assert.equal(validateAIRequest(result).valid, true);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(JSON.stringify(result).toLowerCase().includes('apikey'), false);
});

test('createAIRequest fails closed on unknown or sensitive fields', () => {
  assert.throws(() => createAIRequest(validRequest({ unexpected: true })), /Unknown AIRequest field/);
  assert.throws(() => createAIRequest(validRequest({ metadata: { apiKey: 'secret' } })), /Sensitive AIRequest field/);
});

test('all validators return standardized results instead of throwing', () => {
  for (const validator of [
    validateAIRequest, validateAIResponse, validateAttachment, validateRouteDecision,
    validateTrace, validateToolProposal, validateProviderAdapter
  ]) {
    assert.doesNotThrow(() => validator(null));
    const result = validator(null);
    assert.equal(typeof result.valid, 'boolean');
    assert.equal(Array.isArray(result.errors), true);
    assert.equal(Array.isArray(result.warnings), true);
  }
});
