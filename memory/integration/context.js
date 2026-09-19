import { randomUUID } from 'node:crypto';

const FORGED_IDENTITY_FIELDS = new Set([
  'userId', 'authenticatedUserId', 'actorId', 'role', 'sessionUserId',
  'accountId', 'ownerId', 'tenantUserId', 'requestedUserId', 'urlUserId'
]);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validSession(user) {
  return user && !Array.isArray(user) && typeof user === 'object' &&
    typeof user.id === 'string' && user.id.trim() &&
    typeof user.username === 'string' && user.username.trim() &&
    user.status === 'active';
}

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

export class AuthenticatedMemoryContextFactory {
  constructor({ clock = () => new Date(), idFactory = randomUUID, policyVersion = 'memory-real-user-v1' } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.policyVersion = policyVersion;
  }

  _base(user, request = {}) {
    if (!validSession(user)) fail('MEMORY_AUTH_REQUIRED', 'Authentication is required.');
    if (Object.keys(request).some((field) => FORGED_IDENTITY_FIELDS.has(field))) {
      fail('MEMORY_AUTH_FORGED_IDENTITY', 'Client identity fields are not accepted.');
    }
    const value = this.clock();
    const timestamp = (value instanceof Date ? value : new Date(value)).toISOString();
    const requestId = String(request.requestId || this.idFactory());
    return {
      authenticatedUserId: user.id,
      actorType: 'user',
      actorId: user.id,
      requestId,
      correlationId: String(request.correlationId || requestId),
      timestamp,
      timezone: String(request.timezone || 'Asia/Shanghai'),
      locale: String(request.locale || 'zh-CN'),
      policyVersion: this.policyVersion,
      metadata: {}
    };
  }

  repository(user, request = {}) {
    const base = this._base(user, request);
    return freeze({
      authenticatedUserId: base.authenticatedUserId,
      actorType: base.actorType,
      actorId: base.actorId,
      requestId: base.requestId,
      correlationId: base.correlationId,
      timestamp: base.timestamp,
      policyVersion: base.policyVersion,
      transactionId: null,
      metadata: {}
    });
  }

  recall(user, request = {}) {
    const base = this._base(user, request);
    return freeze({
      ...base,
      taskType: String(request.taskType || 'conversation'),
      purpose: String(request.purpose || 'assistant'),
      sensitivityAllowance: request.sensitivityAllowance || 'medium',
      contextBudget: {
        maxItems: 8,
        maxCharacters: 4000,
        maxEstimatedTokens: 1000,
        maxSensitiveItems: 0,
        perTypeLimit: 4,
        reserveForCurrentTask: 200,
        reserveForSystemInstructions: 200,
        ...(request.contextBudget || {})
      }
    });
  }

  governance(user, request = {}) {
    const base = this._base(user, request);
    return freeze({
      ...base,
      purpose: String(request.purpose || 'memory_governance'),
      operation: String(request.operation || 'view'),
      confirmationToken: request.confirmationToken || null,
      expectedVersion: request.expectedVersion ?? null
    });
  }

  timeline(user, request = {}) {
    const base = this._base(user, request);
    return freeze({ ...base, purpose: String(request.purpose || 'timeline_view') });
  }
}
