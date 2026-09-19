export const MAX_FALLBACK_ATTEMPTS = 2;

export const ROUTE_CANDIDATE_FIELDS = Object.freeze([
  'providerId', 'modelId', 'supported', 'enabled', 'configured', 'verified',
  'healthy', 'score', 'latencyMs', 'estimatedCost', 'rejectionReasons'
]);

export const ROUTE_DECISION_FIELDS = Object.freeze([
  'capability', 'selectedProvider', 'selectedModel', 'score', 'reason',
  'routeConfidence', 'candidates', 'rejectedCandidates', 'fallbackPolicy', 'decidedAt'
]);

export const FALLBACK_ATTEMPT_FIELDS = Object.freeze([
  'attempt', 'providerId', 'modelId', 'startedAt', 'durationMs', 'success',
  'errorCode', 'retryable', 'reason'
]);

export const DEFAULT_FALLBACK_POLICY = Object.freeze({
  maxAttempts: MAX_FALLBACK_ATTEMPTS,
  allowRepeatedCandidate: false,
  developmentDiagnosticMode: false
});

export const ROUTE_DECISION_SCHEMA_V1 = Object.freeze({
  schemaVersion: 'v1',
  fields: ROUTE_DECISION_FIELDS,
  candidateFields: ROUTE_CANDIDATE_FIELDS,
  fallbackAttemptFields: FALLBACK_ATTEMPT_FIELDS,
  defaultFallbackPolicy: DEFAULT_FALLBACK_POLICY
});
