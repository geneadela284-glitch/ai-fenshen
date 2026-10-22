import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { BUILTIN_QUOTA_PROFILES } from './accessControlConfig.js';
import { codedAccessError } from './accessErrors.js';
import { initializeAccessControlSchema } from './accessControlSchema.js';

const PROFILE_FIELDS = Object.freeze([
  'requestsPerMinute',
  'maxConcurrentRequests',
  'providerCallsPerDay',
  'inputTokensPerDay',
  'outputTokensPerDay',
  'dailyCostMicros',
  'monthlyCostMicros',
  'lifetimeCostMicros'
]);

function profileFromRow(row = null) {
  if (!row) return null;
  return {
    id: row.id,
    requestsPerMinute: row.requests_per_minute,
    maxConcurrentRequests: row.max_concurrent_requests,
    providerCallsPerDay: row.provider_calls_per_day,
    inputTokensPerDay: row.input_tokens_per_day,
    outputTokensPerDay: row.output_tokens_per_day,
    dailyCostMicros: row.daily_cost_micros,
    monthlyCostMicros: row.monthly_cost_micros,
    lifetimeCostMicros: row.lifetime_cost_micros,
    builtin: row.builtin === 1,
    enabled: row.enabled === 1
  };
}

function accountAccessFromRow(row = null) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    profileId: row.profile_id,
    enabled: row.enabled === 1,
    sessionEpoch: row.session_epoch,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function assertCustomProfile(profile = {}) {
  const id = String(profile.id || '').trim();
  if (!/^[a-z0-9][a-z0-9_.-]{2,79}$/.test(id) ||
      PROFILE_FIELDS.some((field) => !Number.isSafeInteger(profile[field]) || profile[field] <= 0) ||
      typeof profile.enabled !== 'boolean') {
    throw codedAccessError('QUOTA_PROFILE_INVALID');
  }
  if (Object.hasOwn(BUILTIN_QUOTA_PROFILES, id)) {
    throw codedAccessError('BUILTIN_QUOTA_PROFILE_IMMUTABLE');
  }
  return { ...profile, id, builtin: false };
}

function usageBucketFromRow(row = null) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    bucketType: row.bucket_type,
    bucketKey: row.bucket_key,
    providerCalls: row.provider_calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costMicros: row.cost_micros,
    costUnavailableCount: row.cost_unavailable_count,
    updatedAt: row.updated_at
  };
}

function accountLoginStateFromRow(row = null) {
  if (!row) return null;
  return {
    accountKey: row.account_key,
    windowStartedAt: row.window_started_at,
    windowFailures: row.window_failures,
    consecutiveFailures: row.consecutive_failures,
    cooldownUntil: row.cooldown_until,
    lockedUntil: row.locked_until,
    updatedAt: row.updated_at
  };
}

function ipLoginStateFromRow(row = null) {
  if (!row) return null;
  return {
    ipKey: row.ip_key,
    windowStartedAt: row.window_started_at,
    windowFailures: row.window_failures,
    lockedUntil: row.locked_until,
    updatedAt: row.updated_at
  };
}

export class AccessControlStore {
  constructor({
    dbPath,
    clock = () => new Date()
  } = {}) {
    if (!dbPath || !path.isAbsolute(dbPath)) {
      throw new TypeError('AccessControlStore requires an absolute dbPath.');
    }
    this.dbPath = path.normalize(dbPath);
    this.clock = clock;
    this.database = null;
  }

  nowIso() {
    const value = new Date(this.clock());
    if (!Number.isFinite(value.getTime())) throw new Error('Access control clock returned an invalid date.');
    return value.toISOString();
  }

  secureFiles() {
    for (const file of [this.dbPath, `${this.dbPath}-wal`, `${this.dbPath}-shm`, `${this.dbPath}-journal`]) {
      if (existsSync(file)) chmodSync(file, 0o600);
    }
  }

  initialize() {
    mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    chmodSync(path.dirname(this.dbPath), 0o700);
    this.database = new DatabaseSync(this.dbPath);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.database.exec('PRAGMA journal_mode = WAL');
    initializeAccessControlSchema(this.database, { nowIso: () => this.nowIso() });
    this.secureFiles();
    return this;
  }

  close() {
    if (!this.database) return;
    this.secureFiles();
    this.database.close();
    this.database = null;
    this.secureFiles();
  }

  transaction(callback) {
    if (!this.database) throw new Error('ACCESS_CONTROL_STORE_CLOSED');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    } finally {
      this.secureFiles();
    }
  }

  getProfile(profileId) {
    return profileFromRow(this.database.prepare(
      'SELECT * FROM quota_profiles WHERE id = ?'
    ).get(String(profileId || '').trim()));
  }

  listProfiles() {
    return this.database.prepare('SELECT * FROM quota_profiles ORDER BY id ASC').all().map(profileFromRow);
  }

  putCustomProfile(input) {
    const profile = assertCustomProfile(input);
    const timestamp = this.nowIso();
    this.database.prepare(`
      INSERT INTO quota_profiles (
        id, requests_per_minute, max_concurrent_requests,
        provider_calls_per_day, input_tokens_per_day, output_tokens_per_day,
        daily_cost_micros, monthly_cost_micros, lifetime_cost_micros,
        builtin, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        requests_per_minute = excluded.requests_per_minute,
        max_concurrent_requests = excluded.max_concurrent_requests,
        provider_calls_per_day = excluded.provider_calls_per_day,
        input_tokens_per_day = excluded.input_tokens_per_day,
        output_tokens_per_day = excluded.output_tokens_per_day,
        daily_cost_micros = excluded.daily_cost_micros,
        monthly_cost_micros = excluded.monthly_cost_micros,
        lifetime_cost_micros = excluded.lifetime_cost_micros,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      profile.id,
      profile.requestsPerMinute,
      profile.maxConcurrentRequests,
      profile.providerCallsPerDay,
      profile.inputTokensPerDay,
      profile.outputTokensPerDay,
      profile.dailyCostMicros,
      profile.monthlyCostMicros,
      profile.lifetimeCostMicros,
      profile.enabled ? 1 : 0,
      timestamp,
      timestamp
    );
    this.secureFiles();
    return this.getProfile(profile.id);
  }

  bindAccount({ accountId, profileId, enabled = true } = {}) {
    const account = String(accountId || '').trim();
    const profile = this.getProfile(profileId);
    if (!account || !profile || !profile.enabled || typeof enabled !== 'boolean') {
      throw codedAccessError('ACCOUNT_ACCESS_BINDING_INVALID');
    }
    const timestamp = this.nowIso();
    this.database.prepare(`
      INSERT INTO account_access (
        account_id, profile_id, enabled, session_epoch, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        profile_id = excluded.profile_id,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(account, profile.id, enabled ? 1 : 0, timestamp, timestamp);
    this.secureFiles();
    return this.getAccountAccess(account);
  }

  getAccountAccess(accountId) {
    return accountAccessFromRow(this.database.prepare(
      'SELECT * FROM account_access WHERE account_id = ?'
    ).get(String(accountId || '').trim()));
  }

  setAccountEnabled({ accountId, enabled, updatedAt = this.nowIso() } = {}) {
    if (typeof enabled !== 'boolean') throw codedAccessError('ACCOUNT_ACCESS_BINDING_INVALID');
    const result = this.database.prepare(`
      UPDATE account_access SET enabled = ?, updated_at = ? WHERE account_id = ?
    `).run(enabled ? 1 : 0, updatedAt, String(accountId || '').trim());
    if (result.changes !== 1) throw codedAccessError('ACCOUNT_QUOTA_NOT_CONFIGURED');
    this.secureFiles();
    return this.getAccountAccess(accountId);
  }

  admitRequest({
    accountId,
    requestId,
    minuteBucket,
    startedAt,
    leaseExpiresAt
  } = {}) {
    return this.transaction(() => {
      const account = this.database.prepare(`
        SELECT
          a.account_id,
          a.profile_id,
          a.enabled AS account_enabled,
          p.enabled AS profile_enabled,
          p.requests_per_minute,
          p.max_concurrent_requests
        FROM account_access a
        JOIN quota_profiles p ON p.id = a.profile_id
        WHERE a.account_id = ?
      `).get(accountId);
      if (!account) throw codedAccessError('ACCOUNT_QUOTA_NOT_CONFIGURED');
      if (account.account_enabled !== 1 || account.profile_enabled !== 1) {
        throw codedAccessError('ACCOUNT_ACCESS_DISABLED');
      }

      const existing = this.database.prepare(`
        SELECT * FROM request_leases
        WHERE account_id = ? AND request_id = ?
      `).get(accountId, requestId);
      if (existing) return existing;

      const minuteCount = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM request_leases
        WHERE account_id = ? AND minute_bucket = ?
      `).get(accountId, minuteBucket).count;
      if (minuteCount >= account.requests_per_minute) {
        throw codedAccessError('ACCOUNT_REQUEST_RATE_LIMITED');
      }

      const activeCount = this.database.prepare(`
        SELECT COUNT(*) AS count
        FROM request_leases
        WHERE account_id = ?
          AND completed_at IS NULL
          AND lease_expires_at > ?
      `).get(accountId, startedAt).count;
      if (activeCount >= account.max_concurrent_requests) {
        throw codedAccessError('ACCOUNT_CONCURRENCY_LIMITED');
      }

      this.database.prepare(`
        INSERT INTO request_leases (
          account_id, request_id, minute_bucket,
          started_at, lease_expires_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
      `).run(accountId, requestId, minuteBucket, startedAt, leaseExpiresAt);
      return this.database.prepare(`
        SELECT * FROM request_leases
        WHERE account_id = ? AND request_id = ?
      `).get(accountId, requestId);
    });
  }

  releaseRequest({ accountId, requestId, completedAt = this.nowIso() } = {}) {
    const result = this.database.prepare(`
      UPDATE request_leases
      SET completed_at = COALESCE(completed_at, ?)
      WHERE account_id = ? AND request_id = ?
    `).run(completedAt, accountId, requestId);
    this.secureFiles();
    return result.changes > 0;
  }

  getUsageBucket({ accountId, bucketType, bucketKey } = {}) {
    return usageBucketFromRow(this.database.prepare(`
      SELECT * FROM usage_buckets
      WHERE account_id = ? AND bucket_type = ? AND bucket_key = ?
    `).get(accountId, bucketType, bucketKey));
  }

  reserveAttempt({
    attemptKey,
    accountId,
    requestId,
    executionId,
    attemptType,
    attemptNumber,
    providerRef,
    modelRef,
    reservedInputTokens,
    requestedOutputTokens,
    pricing,
    now,
    dayKey,
    monthKey
  } = {}) {
    return this.transaction(() => {
      const duplicate = this.database.prepare(
        'SELECT attempt_key FROM provider_attempts WHERE attempt_key = ?'
      ).get(attemptKey);
      if (duplicate) throw codedAccessError('DUPLICATE_PROVIDER_ATTEMPT');

      const account = this.database.prepare(`
        SELECT
          a.account_id,
          a.profile_id,
          a.enabled AS account_enabled,
          p.enabled AS profile_enabled,
          p.provider_calls_per_day,
          p.input_tokens_per_day,
          p.output_tokens_per_day,
          p.daily_cost_micros,
          p.monthly_cost_micros,
          p.lifetime_cost_micros
        FROM account_access a
        JOIN quota_profiles p ON p.id = a.profile_id
        WHERE a.account_id = ?
      `).get(accountId);
      if (!account) throw codedAccessError('ACCOUNT_QUOTA_NOT_CONFIGURED');
      if (account.account_enabled !== 1 || account.profile_enabled !== 1) {
        throw codedAccessError('ACCOUNT_ACCESS_DISABLED');
      }
      const lease = this.database.prepare(`
        SELECT * FROM request_leases
        WHERE account_id = ? AND request_id = ?
          AND completed_at IS NULL AND lease_expires_at > ?
      `).get(accountId, requestId, now);
      if (!lease) throw codedAccessError('REQUEST_LEASE_INVALID');

      const bucketDefinitions = [
        ['day', dayKey],
        ['month', monthKey],
        ['lifetime', 'lifetime']
      ];
      const ensureBucket = this.database.prepare(`
        INSERT OR IGNORE INTO usage_buckets (
          account_id, bucket_type, bucket_key,
          provider_calls, input_tokens, output_tokens,
          cost_micros, cost_unavailable_count, updated_at
        ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, ?)
      `);
      for (const [bucketType, bucketKey] of bucketDefinitions) {
        ensureBucket.run(accountId, bucketType, bucketKey, now);
      }
      const daily = this.getUsageBucket({ accountId, bucketType: 'day', bucketKey: dayKey });
      const monthly = this.getUsageBucket({ accountId, bucketType: 'month', bucketKey: monthKey });
      const lifetime = this.getUsageBucket({ accountId, bucketType: 'lifetime', bucketKey: 'lifetime' });
      const remainingOutput = account.output_tokens_per_day - daily.outputTokens;
      const reservedOutputTokens = Math.min(requestedOutputTokens, remainingOutput);
      if (daily.providerCalls + 1 > account.provider_calls_per_day ||
          daily.inputTokens + reservedInputTokens > account.input_tokens_per_day ||
          remainingOutput <= 0 ||
          reservedOutputTokens <= 0) {
        throw codedAccessError('ACCOUNT_USAGE_LIMIT_REACHED');
      }

      const pricingAvailable = pricing?.available === true;
      const reservedCostMicros = pricingAvailable
        ? Math.ceil(
            reservedInputTokens * pricing.inputPerMillion +
            reservedOutputTokens * pricing.outputPerMillion
          )
        : 0;
      if (pricingAvailable && (
        daily.costMicros + reservedCostMicros > account.daily_cost_micros ||
        monthly.costMicros + reservedCostMicros > account.monthly_cost_micros ||
        lifetime.costMicros + reservedCostMicros > account.lifetime_cost_micros
      )) {
        throw codedAccessError('ACCOUNT_USAGE_LIMIT_REACHED');
      }

      this.database.prepare(`
        INSERT INTO provider_attempts (
          attempt_key, account_id, request_id, execution_id,
          attempt_type, attempt_number, provider_ref, model_ref, status,
          reserved_input_tokens, reserved_output_tokens,
          settled_input_tokens, settled_output_tokens,
          cost_micros, cost_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, NULL, NULL, ?, ?, ?, ?)
      `).run(
        attemptKey,
        accountId,
        requestId,
        executionId,
        attemptType,
        attemptNumber,
        providerRef,
        modelRef,
        reservedInputTokens,
        reservedOutputTokens,
        reservedCostMicros,
        pricingAvailable ? 'reserved' : 'unavailable',
        now,
        now
      );
      const addUsage = this.database.prepare(`
        UPDATE usage_buckets SET
          provider_calls = provider_calls + 1,
          input_tokens = input_tokens + ?,
          output_tokens = output_tokens + ?,
          cost_micros = cost_micros + ?,
          cost_unavailable_count = cost_unavailable_count + ?,
          updated_at = ?
        WHERE account_id = ? AND bucket_type = ? AND bucket_key = ?
      `);
      for (const [bucketType, bucketKey] of bucketDefinitions) {
        addUsage.run(
          reservedInputTokens,
          reservedOutputTokens,
          reservedCostMicros,
          pricingAvailable ? 0 : 1,
          now,
          accountId,
          bucketType,
          bucketKey
        );
      }
      return {
        attemptKey,
        accountId,
        requestId,
        executionId,
        attemptType,
        attemptNumber,
        reservedInputTokens,
        reservedOutputTokens,
        reservedCostMicros,
        pricingAvailable,
        dayKey,
        monthKey
      };
    });
  }

  settleAttempt({
    attemptKey,
    settledInputTokens,
    settledOutputTokens,
    settledCostMicros,
    outcome,
    now,
    dayKey,
    monthKey
  } = {}) {
    return this.transaction(() => {
      const row = this.database.prepare(
        'SELECT * FROM provider_attempts WHERE attempt_key = ?'
      ).get(attemptKey);
      if (!row) throw codedAccessError('PROVIDER_ATTEMPT_NOT_FOUND');
      if (row.status !== 'reserved') return row;

      const finalInput = Number.isFinite(settledInputTokens)
        ? Math.max(0, settledInputTokens)
        : row.reserved_input_tokens;
      const finalOutput = Number.isFinite(settledOutputTokens)
        ? Math.max(0, settledOutputTokens)
        : row.reserved_output_tokens;
      const finalCost = Number.isFinite(settledCostMicros)
        ? Math.max(0, settledCostMicros)
        : row.cost_micros;
      const inputDelta = finalInput - row.reserved_input_tokens;
      const outputDelta = finalOutput - row.reserved_output_tokens;
      const costDelta = finalCost - row.cost_micros;
      const bucketDefinitions = [
        ['day', dayKey],
        ['month', monthKey],
        ['lifetime', 'lifetime']
      ];
      const addDelta = this.database.prepare(`
        UPDATE usage_buckets SET
          input_tokens = input_tokens + ?,
          output_tokens = output_tokens + ?,
          cost_micros = cost_micros + ?,
          updated_at = ?
        WHERE account_id = ? AND bucket_type = ? AND bucket_key = ?
      `);
      for (const [bucketType, bucketKey] of bucketDefinitions) {
        addDelta.run(
          inputDelta,
          outputDelta,
          costDelta,
          now,
          row.account_id,
          bucketType,
          bucketKey
        );
      }
      this.database.prepare(`
        UPDATE provider_attempts SET
          status = ?,
          settled_input_tokens = ?,
          settled_output_tokens = ?,
          cost_micros = ?,
          cost_status = CASE WHEN cost_status = 'unavailable' THEN 'unavailable' ELSE 'calculated' END,
          updated_at = ?
        WHERE attempt_key = ?
      `).run(
        outcome === 'success' ? 'settled' : 'failed',
        finalInput,
        finalOutput,
        finalCost,
        now,
        attemptKey
      );
      return this.database.prepare(
        'SELECT * FROM provider_attempts WHERE attempt_key = ?'
      ).get(attemptKey);
    });
  }

  getAccountLoginState(accountKey) {
    return accountLoginStateFromRow(this.database.prepare(`
      SELECT * FROM login_account_state WHERE account_key = ?
    `).get(accountKey));
  }

  getIpLoginState(ipKey) {
    return ipLoginStateFromRow(this.database.prepare(`
      SELECT * FROM login_ip_state WHERE ip_key = ?
    `).get(ipKey));
  }

  recordLoginFailure({
    accountKey,
    ipKey,
    now,
    cooldownFailureCount,
    cooldownMs,
    accountWindowFailureCount,
    ipWindowFailureCount,
    windowMs,
    lockMs
  } = {}) {
    return this.transaction(() => {
      const nowMs = new Date(now).getTime();
      const currentAccount = this.getAccountLoginState(accountKey);
      const accountWindowExpired = !currentAccount ||
        nowMs - new Date(currentAccount.windowStartedAt).getTime() >= windowMs;
      const accountWindowStartedAt = accountWindowExpired ? now : currentAccount.windowStartedAt;
      const accountWindowFailures = (accountWindowExpired ? 0 : currentAccount.windowFailures) + 1;
      const consecutiveFailures = (accountWindowExpired ? 0 : currentAccount.consecutiveFailures) + 1;
      const accountLockedUntil = accountWindowFailures >= accountWindowFailureCount
        ? new Date(nowMs + lockMs).toISOString()
        : currentAccount?.lockedUntil && new Date(currentAccount.lockedUntil).getTime() > nowMs
          ? currentAccount.lockedUntil
          : null;
      const cooldownUntil = !accountLockedUntil && consecutiveFailures >= cooldownFailureCount
        ? new Date(nowMs + cooldownMs).toISOString()
        : null;
      this.database.prepare(`
        INSERT INTO login_account_state (
          account_key, window_started_at, window_failures,
          consecutive_failures, cooldown_until, locked_until, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET
          window_started_at = excluded.window_started_at,
          window_failures = excluded.window_failures,
          consecutive_failures = excluded.consecutive_failures,
          cooldown_until = excluded.cooldown_until,
          locked_until = excluded.locked_until,
          updated_at = excluded.updated_at
      `).run(
        accountKey,
        accountWindowStartedAt,
        accountWindowFailures,
        consecutiveFailures,
        cooldownUntil,
        accountLockedUntil,
        now
      );

      const currentIp = this.getIpLoginState(ipKey);
      const ipWindowExpired = !currentIp ||
        nowMs - new Date(currentIp.windowStartedAt).getTime() >= windowMs;
      const ipWindowStartedAt = ipWindowExpired ? now : currentIp.windowStartedAt;
      const ipWindowFailures = (ipWindowExpired ? 0 : currentIp.windowFailures) + 1;
      const ipLockedUntil = ipWindowFailures >= ipWindowFailureCount
        ? new Date(nowMs + lockMs).toISOString()
        : currentIp?.lockedUntil && new Date(currentIp.lockedUntil).getTime() > nowMs
          ? currentIp.lockedUntil
          : null;
      this.database.prepare(`
        INSERT INTO login_ip_state (
          ip_key, window_started_at, window_failures,
          locked_until, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(ip_key) DO UPDATE SET
          window_started_at = excluded.window_started_at,
          window_failures = excluded.window_failures,
          locked_until = excluded.locked_until,
          updated_at = excluded.updated_at
      `).run(ipKey, ipWindowStartedAt, ipWindowFailures, ipLockedUntil, now);
      return {
        account: this.getAccountLoginState(accountKey),
        ip: this.getIpLoginState(ipKey)
      };
    });
  }

  clearAccountLoginSuccess({ accountKey, now } = {}) {
    this.database.prepare(`
      UPDATE login_account_state SET
        consecutive_failures = 0,
        cooldown_until = NULL,
        locked_until = CASE WHEN locked_until > ? THEN locked_until ELSE NULL END,
        updated_at = ?
      WHERE account_key = ?
    `).run(now, now, accountKey);
    this.secureFiles();
    return this.getAccountLoginState(accountKey);
  }

  registerSession({ sessionRef, accountId, createdAt } = {}) {
    return this.transaction(() => {
      const access = this.getAccountAccess(accountId);
      if (!access) throw codedAccessError('ACCOUNT_QUOTA_NOT_CONFIGURED');
      if (!access.enabled) throw codedAccessError('ACCOUNT_ACCESS_DISABLED');
      this.database.prepare(`
        INSERT INTO session_bindings (
          session_ref, account_id, epoch, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, NULL)
      `).run(sessionRef, accountId, access.sessionEpoch, createdAt);
      return {
        sessionRef,
        accountId,
        epoch: access.sessionEpoch,
        createdAt,
        revokedAt: null
      };
    });
  }

  validateSession({ sessionRef, accountId } = {}) {
    const row = this.database.prepare(`
      SELECT s.*, a.enabled AS account_enabled, a.session_epoch
      FROM session_bindings s
      JOIN account_access a ON a.account_id = s.account_id
      WHERE s.session_ref = ?
        AND s.account_id = ?
        AND s.revoked_at IS NULL
        AND a.enabled = 1
        AND s.epoch = a.session_epoch
    `).get(sessionRef, accountId);
    return row ? {
      sessionRef: row.session_ref,
      accountId: row.account_id,
      epoch: row.epoch,
      createdAt: row.created_at
    } : null;
  }

  revokeSession({ sessionRef, revokedAt } = {}) {
    const result = this.database.prepare(`
      UPDATE session_bindings
      SET revoked_at = COALESCE(revoked_at, ?)
      WHERE session_ref = ?
    `).run(revokedAt, sessionRef);
    this.secureFiles();
    return result.changes > 0;
  }

  bumpSessionEpoch({
    accountId,
    enabled,
    revokedAt
  } = {}) {
    return this.transaction(() => {
      const current = this.getAccountAccess(accountId);
      if (!current) throw codedAccessError('ACCOUNT_QUOTA_NOT_CONFIGURED');
      const nextEnabled = typeof enabled === 'boolean' ? enabled : current.enabled;
      this.database.prepare(`
        UPDATE account_access SET
          enabled = ?,
          session_epoch = session_epoch + 1,
          updated_at = ?
        WHERE account_id = ?
      `).run(nextEnabled ? 1 : 0, revokedAt, accountId);
      this.database.prepare(`
        UPDATE session_bindings
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE account_id = ?
      `).run(revokedAt, accountId);
      return this.getAccountAccess(accountId);
    });
  }

  recordSecurityEvent({
    id,
    eventType,
    accountRef,
    subjectRef,
    requestRef,
    outcome,
    reasonCode,
    createdAt
  } = {}) {
    this.database.prepare(`
      INSERT INTO security_events (
        id, event_type, account_ref, subject_ref, request_ref,
        outcome, reason_code, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      eventType,
      accountRef || null,
      subjectRef || null,
      requestRef || null,
      outcome,
      reasonCode || null,
      createdAt
    );
    this.secureFiles();
    return true;
  }

  getAccountUsageSummary(accountId) {
    const account = this.getAccountAccess(accountId);
    if (!account) return null;
    const profile = this.getProfile(account.profileId);
    const buckets = this.database.prepare(`
      SELECT * FROM usage_buckets
      WHERE account_id = ?
      ORDER BY bucket_type ASC, bucket_key ASC
    `).all(account.accountId).map(usageBucketFromRow);
    return { account, profile, buckets };
  }

  deleteAccountData({ accountId, accountKey } = {}) {
    const account = String(accountId || '').trim();
    if (!account) throw codedAccessError('ACCOUNT_ACCESS_BINDING_INVALID');
    return this.transaction(() => {
      const counts = {};
      for (const [name, sql, value] of [
        ['providerAttempts', 'DELETE FROM provider_attempts WHERE account_id = ?', account],
        ['usageBuckets', 'DELETE FROM usage_buckets WHERE account_id = ?', account],
        ['requestLeases', 'DELETE FROM request_leases WHERE account_id = ?', account],
        ['sessionBindings', 'DELETE FROM session_bindings WHERE account_id = ?', account],
        ['accountAccess', 'DELETE FROM account_access WHERE account_id = ?', account],
        ['loginAccountState', 'DELETE FROM login_account_state WHERE account_key = ?', String(accountKey || '')]
      ]) {
        counts[name] = Number(this.database.prepare(sql).run(value).changes);
      }
      return counts;
    });
  }
}
