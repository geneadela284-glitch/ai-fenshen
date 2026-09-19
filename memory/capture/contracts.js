export const CaptureIntent = Object.freeze({
  NOT_MEMORY: 'not_memory',
  CONTEXT_ONLY: 'context_only',
  LONG_TERM_MEMORY: 'long_term_memory',
  EXPLICIT_REMEMBER: 'explicit_remember',
  FORGET: 'forget'
});

export const CaptureOutcome = Object.freeze({
  REJECTED: 'rejected',
  CONTEXT_ONLY: 'context_only',
  CANDIDATE: 'candidate',
  STORED: 'stored',
  FORGOTTEN: 'forgotten'
});

export const CaptureReasonCode = Object.freeze({
  NOT_MEMORY: 'CAPTURE_NOT_MEMORY',
  USER_OPTED_OUT: 'CAPTURE_USER_OPTED_OUT',
  INVALID_INPUT: 'CAPTURE_INVALID_INPUT',
  INVALID_CONTEXT: 'CAPTURE_INVALID_CONTEXT',
  SOURCE_REQUIRED: 'CAPTURE_SOURCE_REQUIRED',
  LONG_TERM_SIGNAL: 'CAPTURE_LONG_TERM_SIGNAL',
  PROACTIVE_HIGH_VALUE_SIGNAL: 'CAPTURE_PROACTIVE_HIGH_VALUE_SIGNAL',
  PROACTIVE_HIGH_VALUE_AUTHORIZED: 'CAPTURE_PROACTIVE_HIGH_VALUE_AUTHORIZED',
  UNCERTAIN_USER_STATEMENT: 'CAPTURE_UNCERTAIN_USER_STATEMENT',
  EXPLICIT_REMEMBER: 'CAPTURE_EXPLICIT_REMEMBER',
  EXPLICIT_REMEMBER_AUTHORIZED: 'CAPTURE_EXPLICIT_REMEMBER_AUTHORIZED',
  CONTEXT_ONLY: 'CAPTURE_CONTEXT_ONLY',
  CONFIRMATION_REQUIRED: 'CAPTURE_CONFIRMATION_REQUIRED',
  SENSITIVE_CONFIRMATION_REQUIRED: 'CAPTURE_SENSITIVE_CONFIRMATION_REQUIRED',
  PROHIBITED_SECRET: 'CAPTURE_PROHIBITED_SECRET',
  USER_CONFIRMED: 'CAPTURE_USER_CONFIRMED',
  INVALID_CANDIDATE: 'CAPTURE_INVALID_CANDIDATE',
  CANDIDATE_INTEGRITY_FAILED: 'CAPTURE_CANDIDATE_INTEGRITY_FAILED',
  FORGET_INTENT: 'CAPTURE_FORGET_INTENT',
  TARGET_MEMORY_REQUIRED: 'CAPTURE_TARGET_MEMORY_REQUIRED',
  EXPECTED_VERSION_REQUIRED: 'CAPTURE_EXPECTED_VERSION_REQUIRED',
  MOVED_TO_RECYCLE_BIN: 'CAPTURE_MOVED_TO_RECYCLE_BIN',
  CONFLICT_CONFIRMATION_REQUIRED: 'CAPTURE_CONFLICT_CONFIRMATION_REQUIRED',
  CONFLICT_SUPERSEDED: 'CAPTURE_CONFLICT_SUPERSEDED',
  ASSISTANT_CANDIDATE_ONLY: 'CAPTURE_ASSISTANT_CANDIDATE_ONLY',
  ASSISTANT_SENSITIVE_REJECTED: 'CAPTURE_ASSISTANT_SENSITIVE_REJECTED'
});

export const ConfirmationDecision = Object.freeze({
  AUTHORIZED: 'authorized',
  REQUIRED: 'required',
  REJECTED: 'rejected'
});

export const CaptureResult = Object.freeze({
  name: 'CaptureResult',
  fields: Object.freeze([
    'ok', 'outcome', 'reasonCode', 'intent', 'candidate', 'memory',
    'context', 'requiresConfirmation', 'audit', 'error'
  ])
});

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

export function createCaptureResult({
  outcome,
  reasonCode,
  intent,
  candidate = null,
  memory = null,
  context = null,
  requiresConfirmation = false,
  audit = null,
  error = null
}) {
  return deepFreeze(structuredClone({
    ok: outcome !== CaptureOutcome.REJECTED,
    outcome,
    reasonCode,
    intent,
    candidate,
    memory,
    context,
    requiresConfirmation,
    audit,
    error
  }));
}
