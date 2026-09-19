import { createHash, randomUUID } from 'node:crypto';

function safeId(prefix, value) {
  const normalized = String(value || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 160);
  return normalized || `${prefix}_${randomUUID()}`;
}

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

export function createRouterExecutionContext({
  requestId,
  executionId,
  idempotencyKey,
  clientRequestId,
  ownerId,
  domain,
  businessExecutionStarted = false,
  businessWriteStarted = false
} = {}) {
  const request = safeId('req', requestId);
  const execution = safeId('exec', executionId);
  const idempotencySeed = [ownerId, clientRequestId || request, domain].join('\u0000');
  const stableIdempotencyKey = String(idempotencyKey || '').trim() || `idem_${digest(idempotencySeed)}`;
  return Object.freeze({
    requestId: request,
    executionId: execution.startsWith('exec_') ? execution : `exec_${execution}`,
    idempotencyKey: stableIdempotencyKey,
    domain: String(domain || ''),
    businessExecutionStarted: Boolean(businessExecutionStarted),
    businessWriteStarted: Boolean(businessWriteStarted),
    attempt(attemptNumber, candidate, attemptType = 'planning') {
      return Object.freeze({
        requestId: request,
        executionId: execution.startsWith('exec_') ? execution : `exec_${execution}`,
        attemptId: `attempt_${randomUUID()}`,
        attemptNumber,
        attemptType: String(attemptType || 'planning'),
        providerId: candidate?.providerId || '',
        modelId: candidate?.modelId || ''
      });
    }
  });
}
