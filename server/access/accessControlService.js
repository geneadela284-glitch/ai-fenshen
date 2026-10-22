import { createHash, createHmac, randomUUID } from 'node:crypto';

import { codedAccessError, publicAccessError } from './accessErrors.js';
import { LOGIN_PROTECTION } from './accessControlConfig.js';

const SUBJECT = Symbol('authenticated-access-subject');
const REQUEST_LEASE = Symbol('access-request-lease');
const RESERVATION = Symbol('provider-attempt-reservation');
const DEFAULT_IMAGE_INPUT_TOKEN_RESERVATION = 16_384;
const PUBLIC_ACCESS_CODES = new Set([
  'ACCOUNT_ACCESS_DISABLED',
  'ACCOUNT_QUOTA_NOT_CONFIGURED',
  'ACCOUNT_REQUEST_RATE_LIMITED',
  'ACCOUNT_CONCURRENCY_LIMITED',
  'ACCOUNT_USAGE_LIMIT_REACHED',
  'ACCESS_CONTROL_UNAVAILABLE'
]);

function safeDate(clock) {
  const value = new Date(clock());
  if (!Number.isFinite(value.getTime())) throw new Error('Access control clock returned an invalid date.');
  return value;
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0
    ? Number(value)
    : fallback;
}

function normalizeUsage(usage = null) {
  const input = usage?.inputTokens ?? usage?.input_tokens ?? usage?.prompt_tokens;
  const output = usage?.outputTokens ?? usage?.output_tokens ?? usage?.completion_tokens;
  const inputAvailable = Number.isFinite(Number(input)) && Number(input) >= 0;
  const outputAvailable = Number.isFinite(Number(output)) && Number(output) >= 0;
  return {
    inputAvailable,
    outputAvailable,
    inputTokens: inputAvailable ? Math.ceil(Number(input)) : null,
    outputTokens: outputAvailable ? Math.ceil(Number(output)) : null
  };
}

function pricingContract(pricing = null) {
  const input = Number(pricing?.input_per_million);
  const output = Number(pricing?.output_per_million);
  const available = Boolean(
    pricing?.version &&
    pricing?.currency === 'CNY' &&
    Number.isFinite(input) &&
    input >= 0 &&
    Number.isFinite(output) &&
    output >= 0
  );
  return {
    available,
    inputPerMillion: available ? input : 0,
    outputPerMillion: available ? output : 0
  };
}

function conservativeInputTokens(request = {}, imageInputTokenReservation = DEFAULT_IMAGE_INPUT_TOKEN_RESERVATION) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  let imageCount = 0;
  const textOnlyMessages = messages.map((message) => {
    if (!Array.isArray(message?.content)) return message;
    return {
      ...message,
      content: message.content.filter((part) => {
        if (part?.type !== 'image_url') return true;
        imageCount += 1;
        return false;
      })
    };
  });
  if (imageCount === 0) {
    return Math.max(1, Buffer.byteLength(JSON.stringify({
      input: String(request.input || ''),
      messages
    }), 'utf8'));
  }
  const textBytes = Buffer.byteLength(JSON.stringify({
    input: String(request.input || ''),
    messages: textOnlyMessages
  }), 'utf8');
  return Math.max(1, textBytes + imageCount * imageInputTokenReservation);
}

function rethrowAccess(error) {
  if (PUBLIC_ACCESS_CODES.has(error?.code)) {
    if (error.code === 'ACCOUNT_REQUEST_RATE_LIMITED') {
      throw publicAccessError(error.code, { retryAfterSeconds: 60 });
    }
    if (error.code === 'ACCOUNT_CONCURRENCY_LIMITED') {
      throw publicAccessError(error.code, { retryAfterSeconds: 120 });
    }
    throw publicAccessError(error.code);
  }
  if ([
    'DUPLICATE_PROVIDER_ATTEMPT',
    'REQUEST_LEASE_INVALID',
    'PROVIDER_ATTEMPT_NOT_FOUND',
    'QUOTA_PROFILE_INVALID',
    'BUILTIN_QUOTA_PROFILE_IMMUTABLE',
    'ACCOUNT_ACCESS_BINDING_INVALID'
  ].includes(error?.code)) throw error;
  throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
}

export class AccessControlService {
  constructor({
    store,
    hmacSecret,
    clock = () => new Date(),
    leaseTtlMs = 120000,
    defaultMaxOutputTokens = 4096,
    imageInputTokenReservation = DEFAULT_IMAGE_INPUT_TOKEN_RESERVATION
  } = {}) {
    if (!store) throw new TypeError('AccessControlService requires a store.');
    if (typeof hmacSecret !== 'string' || hmacSecret.length < 24) {
      throw new TypeError('AccessControlService hmacSecret must be at least 24 characters.');
    }
    this.store = store;
    this.hmacSecret = hmacSecret;
    this.clock = clock;
    this.leaseTtlMs = positiveInteger(leaseTtlMs, 120000);
    this.defaultMaxOutputTokens = positiveInteger(defaultMaxOutputTokens, 4096);
    this.imageInputTokenReservation = positiveInteger(
      imageInputTokenReservation,
      DEFAULT_IMAGE_INPUT_TOKEN_RESERVATION
    );
    this.brand = Object.freeze({});
  }

  digest(value) {
    return createHmac('sha256', this.hmacSecret).update(String(value || '')).digest('hex');
  }

  createAuthenticatedSubject({ accountId, role } = {}) {
    const id = String(accountId || '').trim();
    if (!id) throw codedAccessError('AUTHENTICATED_SUBJECT_INVALID');
    const subject = {
      accountId: id,
      role: ['admin', 'user', 'beta_user'].includes(role) ? role : 'user'
    };
    Object.defineProperty(subject, SUBJECT, { value: this.brand });
    return Object.freeze(subject);
  }

  assertAuthenticatedSubject(subject) {
    if (!subject || subject[SUBJECT] !== this.brand || !subject.accountId) {
      throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
    }
    return subject;
  }

  bindAccountProfile({ accountId, profileId, enabled = true } = {}) {
    try {
      return this.store.bindAccount({ accountId, profileId, enabled });
    } catch (error) {
      rethrowAccess(error);
    }
  }

  listQuotaProfiles() {
    try {
      return this.store.listProfiles();
    } catch {
      throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
    }
  }

  putCustomQuotaProfile(profile = {}) {
    try {
      return this.store.putCustomProfile(profile);
    } catch (error) {
      rethrowAccess(error);
    }
  }

  setAccountEnabled({ accountId, enabled } = {}) {
    try {
      return this.store.setAccountEnabled({ accountId, enabled });
    } catch (error) {
      rethrowAccess(error);
    }
  }

  getAccountAccess(accountId) {
    try {
      return this.store.getAccountAccess(String(accountId || '').trim());
    } catch (error) {
      rethrowAccess(error);
    }
  }

  getAccountUsageSummary(accountId) {
    try {
      return this.store.getAccountUsageSummary(String(accountId || '').trim());
    } catch (error) {
      rethrowAccess(error);
    }
  }

  deleteAccountData({ accountId, username } = {}) {
    try {
      return this.store.deleteAccountData({
        accountId: String(accountId || '').trim(),
        accountKey: this.loginKeys({ username, accountId }).accountKey
      });
    } catch (error) {
      rethrowAccess(error);
    }
  }

  beginRequest({ subject, requestId } = {}) {
    const actor = this.assertAuthenticatedSubject(subject);
    const id = String(requestId || '').trim();
    if (!id || id.length > 200) throw codedAccessError('REQUEST_ID_INVALID');
    const now = safeDate(this.clock);
    const startedAt = now.toISOString();
    const minuteBucket = startedAt.slice(0, 16);
    const leaseExpiresAt = new Date(now.getTime() + this.leaseTtlMs).toISOString();
    try {
      const row = this.store.admitRequest({
        accountId: actor.accountId,
        requestId: id,
        minuteBucket,
        startedAt,
        leaseExpiresAt
      });
      const lease = {
        accountId: actor.accountId,
        requestId: id,
        startedAt: row.started_at,
        leaseExpiresAt: row.lease_expires_at
      };
      Object.defineProperty(lease, REQUEST_LEASE, { value: this.brand });
      return Object.freeze(lease);
    } catch (error) {
      rethrowAccess(error);
    }
  }

  assertRequestLease(subject, requestLease) {
    const actor = this.assertAuthenticatedSubject(subject);
    if (!requestLease ||
        requestLease[REQUEST_LEASE] !== this.brand ||
        requestLease.accountId !== actor.accountId) {
      throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
    }
    return requestLease;
  }

  releaseRequest(requestLease) {
    if (!requestLease || requestLease[REQUEST_LEASE] !== this.brand) return false;
    try {
      return this.store.releaseRequest({
        accountId: requestLease.accountId,
        requestId: requestLease.requestId,
        completedAt: safeDate(this.clock).toISOString()
      });
    } catch (error) {
      rethrowAccess(error);
    }
  }

  reserveProviderAttempt({
    subject,
    requestLease,
    attempt = {},
    request = {},
    pricing = null
  } = {}) {
    const actor = this.assertAuthenticatedSubject(subject);
    const lease = this.assertRequestLease(actor, requestLease);
    const requestId = String(attempt.requestId || '').trim();
    const executionId = String(attempt.executionId || '').trim();
    const attemptType = String(attempt.attemptType || '').trim();
    const attemptNumber = Number(attempt.attemptNumber);
    const providerId = String(attempt.providerId || '').trim();
    const modelId = String(attempt.modelId || '').trim();
    if (requestId !== lease.requestId ||
        !executionId ||
        !attemptType ||
        !Number.isSafeInteger(attemptNumber) ||
        attemptNumber <= 0 ||
        !providerId ||
        !modelId) {
      throw codedAccessError('PROVIDER_ATTEMPT_IDENTITY_INVALID');
    }
    const attemptKey = createHash('sha256').update([
      actor.accountId,
      requestId,
      executionId,
      attemptType,
      attemptNumber,
      providerId,
      modelId
    ].join('\u0000')).digest('hex');
    const now = safeDate(this.clock);
    const nowIso = now.toISOString();
    const dayKey = nowIso.slice(0, 10);
    const monthKey = nowIso.slice(0, 7);
    const reservedInputTokens = conservativeInputTokens(
      request,
      this.imageInputTokenReservation
    );
    const requestedOutputTokens = positiveInteger(
      request.options?.maxTokens ??
      request.options?.max_tokens ??
      request.options?.maxOutputTokens,
      this.defaultMaxOutputTokens
    );
    const price = pricingContract(pricing);
    try {
      const stored = this.store.reserveAttempt({
        attemptKey,
        accountId: actor.accountId,
        requestId,
        executionId,
        attemptType,
        attemptNumber,
        providerRef: this.digest(`provider:${providerId}`),
        modelRef: this.digest(`model:${modelId}`),
        reservedInputTokens,
        requestedOutputTokens,
        pricing: price,
        now: nowIso,
        dayKey,
        monthKey
      });
      const nextRequest = {
        ...request,
        options: {
          ...(request.options || {}),
          maxTokens: stored.reservedOutputTokens
        }
      };
      const reservation = {
        ...stored,
        pricing: price,
        request: nextRequest
      };
      Object.defineProperty(reservation, RESERVATION, { value: this.brand });
      return Object.freeze(reservation);
    } catch (error) {
      rethrowAccess(error);
    }
  }

  settleProviderAttempt({
    reservation,
    usage = null,
    outcome = 'failed'
  } = {}) {
    if (!reservation || reservation[RESERVATION] !== this.brand) {
      throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
    }
    const normalized = normalizeUsage(usage);
    const settledCostMicros = reservation.pricing.available &&
      normalized.inputAvailable &&
      normalized.outputAvailable
      ? Math.ceil(
          normalized.inputTokens * reservation.pricing.inputPerMillion +
          normalized.outputTokens * reservation.pricing.outputPerMillion
        )
      : null;
    try {
      const settled = this.store.settleAttempt({
        attemptKey: reservation.attemptKey,
        settledInputTokens: normalized.inputTokens,
        settledOutputTokens: normalized.outputTokens,
        settledCostMicros,
        outcome,
        now: safeDate(this.clock).toISOString(),
        dayKey: reservation.dayKey,
        monthKey: reservation.monthKey
      });
      if (!normalized.inputAvailable || !normalized.outputAvailable) {
        this.recordSecurityEvent({
          eventType: 'provider_usage_settlement',
          accountId: reservation.accountId,
          requestId: reservation.requestId,
          outcome: 'estimated',
          reasonCode: 'PROVIDER_USAGE_UNAVAILABLE'
        });
      }
      return settled;
    } catch (error) {
      rethrowAccess(error);
    }
  }

  loginKeys({ username, accountId, clientIp } = {}) {
    const normalizedUsername = String(username || '').trim().toLowerCase();
    const accountKey = accountId
      ? this.digest(`account:${accountId}`)
      : this.digest(`username:${normalizedUsername}`);
    return {
      accountKey,
      ipKey: this.digest(`ip:${String(clientIp || 'unknown')}`)
    };
  }

  loginDecisionFromState({ account, ip }, now) {
    const nowMs = now.getTime();
    if (ip?.lockedUntil && new Date(ip.lockedUntil).getTime() > nowMs) {
      return {
        allowed: false,
        reasonCode: 'IP_LOGIN_LOCKED',
        retryAfterSeconds: Math.ceil((new Date(ip.lockedUntil).getTime() - nowMs) / 1000)
      };
    }
    if (account?.lockedUntil && new Date(account.lockedUntil).getTime() > nowMs) {
      return {
        allowed: false,
        reasonCode: 'ACCOUNT_LOGIN_LOCKED',
        retryAfterSeconds: Math.ceil((new Date(account.lockedUntil).getTime() - nowMs) / 1000)
      };
    }
    if (account?.cooldownUntil && new Date(account.cooldownUntil).getTime() > nowMs) {
      return {
        allowed: false,
        reasonCode: 'ACCOUNT_LOGIN_COOLDOWN',
        retryAfterSeconds: Math.ceil((new Date(account.cooldownUntil).getTime() - nowMs) / 1000)
      };
    }
    return { allowed: true, reasonCode: null, retryAfterSeconds: 0 };
  }

  getLoginState(input = {}) {
    const { accountKey, ipKey } = this.loginKeys(input);
    try {
      return {
        account: this.store.getAccountLoginState(accountKey),
        ip: this.store.getIpLoginState(ipKey)
      };
    } catch {
      throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
    }
  }

  getLoginDecision(input = {}) {
    const now = safeDate(this.clock);
    return this.loginDecisionFromState(this.getLoginState(input), now);
  }

  recordLoginFailure(input = {}) {
    const { accountKey, ipKey } = this.loginKeys(input);
    const now = safeDate(this.clock);
    try {
      const state = this.store.recordLoginFailure({
        accountKey,
        ipKey,
        now: now.toISOString(),
        ...LOGIN_PROTECTION
      });
      return {
        ...this.loginDecisionFromState(state, now),
        state
      };
    } catch {
      throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
    }
  }

  clearSuccessfulAccountLogin(input = {}) {
    const { accountKey } = this.loginKeys(input);
    try {
      return this.store.clearAccountLoginSuccess({
        accountKey,
        now: safeDate(this.clock).toISOString()
      });
    } catch {
      throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
    }
  }

  registerSession({ subject, token } = {}) {
    const actor = this.assertAuthenticatedSubject(subject);
    if (!String(token || '')) throw codedAccessError('SESSION_BINDING_INVALID');
    try {
      return this.store.registerSession({
        sessionRef: this.digest(`session:${token}`),
        accountId: actor.accountId,
        createdAt: safeDate(this.clock).toISOString()
      });
    } catch (error) {
      rethrowAccess(error);
    }
  }

  validateSession({ accountId, token } = {}) {
    try {
      return this.store.validateSession({
        sessionRef: this.digest(`session:${token}`),
        accountId: String(accountId || '').trim()
      });
    } catch {
      throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
    }
  }

  revokeSession({ token } = {}) {
    try {
      return this.store.revokeSession({
        sessionRef: this.digest(`session:${token}`),
        revokedAt: safeDate(this.clock).toISOString()
      });
    } catch {
      throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
    }
  }

  revokeAllSessions({
    accountId,
    reasonCode,
    enabled
  } = {}) {
    try {
      const access = this.store.bumpSessionEpoch({
        accountId: String(accountId || '').trim(),
        enabled,
        revokedAt: safeDate(this.clock).toISOString()
      });
      this.recordSecurityEvent({
        eventType: 'session_revoke_all',
        accountId,
        outcome: 'applied',
        reasonCode
      });
      return access;
    } catch (error) {
      rethrowAccess(error);
    }
  }

  recordSecurityEvent({
    eventType,
    accountId = '',
    subject = '',
    requestId = '',
    outcome,
    reasonCode = ''
  } = {}) {
    try {
      return this.store.recordSecurityEvent?.({
        id: `sec_${randomUUID()}`,
        eventType: String(eventType || ''),
        accountRef: accountId ? this.digest(`account:${accountId}`) : null,
        subjectRef: subject ? this.digest(`subject:${subject}`) : null,
        requestRef: requestId ? this.digest(`request:${requestId}`) : null,
        outcome: String(outcome || ''),
        reasonCode: String(reasonCode || ''),
        createdAt: safeDate(this.clock).toISOString()
      }) || null;
    } catch {
      throw publicAccessError('ACCESS_CONTROL_UNAVAILABLE');
    }
  }
}
