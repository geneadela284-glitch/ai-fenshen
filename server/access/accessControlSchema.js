import { BUILTIN_QUOTA_PROFILES } from './accessControlConfig.js';

function profileValues(profile) {
  return [
    profile.id,
    profile.requestsPerMinute,
    profile.maxConcurrentRequests,
    profile.providerCallsPerDay,
    profile.inputTokensPerDay,
    profile.outputTokensPerDay,
    profile.dailyCostMicros,
    profile.monthlyCostMicros,
    profile.lifetimeCostMicros,
    profile.builtin ? 1 : 0,
    profile.enabled ? 1 : 0
  ];
}

export function initializeAccessControlSchema(database, {
  nowIso = () => new Date().toISOString()
} = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS quota_profiles (
      id TEXT PRIMARY KEY,
      requests_per_minute INTEGER NOT NULL CHECK(requests_per_minute > 0),
      max_concurrent_requests INTEGER NOT NULL CHECK(max_concurrent_requests > 0),
      provider_calls_per_day INTEGER NOT NULL CHECK(provider_calls_per_day > 0),
      input_tokens_per_day INTEGER NOT NULL CHECK(input_tokens_per_day > 0),
      output_tokens_per_day INTEGER NOT NULL CHECK(output_tokens_per_day > 0),
      daily_cost_micros INTEGER NOT NULL CHECK(daily_cost_micros > 0),
      monthly_cost_micros INTEGER NOT NULL CHECK(monthly_cost_micros > 0),
      lifetime_cost_micros INTEGER NOT NULL CHECK(lifetime_cost_micros > 0),
      builtin INTEGER NOT NULL CHECK(builtin IN (0, 1)),
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_access (
      account_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
      session_epoch INTEGER NOT NULL DEFAULT 1 CHECK(session_epoch > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(profile_id) REFERENCES quota_profiles(id)
    );

    CREATE TABLE IF NOT EXISTS request_leases (
      account_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      minute_bucket TEXT NOT NULL,
      started_at TEXT NOT NULL,
      lease_expires_at TEXT NOT NULL,
      completed_at TEXT,
      PRIMARY KEY(account_id, request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_request_leases_active
      ON request_leases(account_id, lease_expires_at, completed_at);
    CREATE INDEX IF NOT EXISTS idx_request_leases_minute
      ON request_leases(account_id, minute_bucket);

    CREATE TABLE IF NOT EXISTS usage_buckets (
      account_id TEXT NOT NULL,
      bucket_type TEXT NOT NULL CHECK(bucket_type IN ('day', 'month', 'lifetime')),
      bucket_key TEXT NOT NULL,
      provider_calls INTEGER NOT NULL DEFAULT 0 CHECK(provider_calls >= 0),
      input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
      output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
      cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(cost_micros >= 0),
      cost_unavailable_count INTEGER NOT NULL DEFAULT 0 CHECK(cost_unavailable_count >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(account_id, bucket_type, bucket_key)
    );

    CREATE TABLE IF NOT EXISTS provider_attempts (
      attempt_key TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      attempt_type TEXT NOT NULL,
      attempt_number INTEGER NOT NULL CHECK(attempt_number > 0),
      provider_ref TEXT NOT NULL,
      model_ref TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved', 'settled', 'failed')),
      reserved_input_tokens INTEGER NOT NULL CHECK(reserved_input_tokens >= 0),
      reserved_output_tokens INTEGER NOT NULL CHECK(reserved_output_tokens >= 0),
      settled_input_tokens INTEGER CHECK(settled_input_tokens >= 0),
      settled_output_tokens INTEGER CHECK(settled_output_tokens >= 0),
      cost_micros INTEGER NOT NULL DEFAULT 0 CHECK(cost_micros >= 0),
      cost_status TEXT NOT NULL CHECK(cost_status IN ('reserved', 'calculated', 'unavailable')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_attempts_account_request
      ON provider_attempts(account_id, request_id);

    CREATE TABLE IF NOT EXISTS login_account_state (
      account_key TEXT PRIMARY KEY,
      window_started_at TEXT NOT NULL,
      window_failures INTEGER NOT NULL CHECK(window_failures >= 0),
      consecutive_failures INTEGER NOT NULL CHECK(consecutive_failures >= 0),
      cooldown_until TEXT,
      locked_until TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS login_ip_state (
      ip_key TEXT PRIMARY KEY,
      window_started_at TEXT NOT NULL,
      window_failures INTEGER NOT NULL CHECK(window_failures >= 0),
      locked_until TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_bindings (
      session_ref TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      epoch INTEGER NOT NULL CHECK(epoch > 0),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_bindings_account
      ON session_bindings(account_id, epoch, revoked_at);

    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      account_ref TEXT,
      subject_ref TEXT,
      request_ref TEXT,
      outcome TEXT NOT NULL,
      reason_code TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_security_events_created
      ON security_events(created_at);
  `);

  const timestamp = nowIso();
  const upsert = database.prepare(`
    INSERT INTO quota_profiles (
      id, requests_per_minute, max_concurrent_requests,
      provider_calls_per_day, input_tokens_per_day, output_tokens_per_day,
      daily_cost_micros, monthly_cost_micros, lifetime_cost_micros,
      builtin, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      requests_per_minute = excluded.requests_per_minute,
      max_concurrent_requests = excluded.max_concurrent_requests,
      provider_calls_per_day = excluded.provider_calls_per_day,
      input_tokens_per_day = excluded.input_tokens_per_day,
      output_tokens_per_day = excluded.output_tokens_per_day,
      daily_cost_micros = excluded.daily_cost_micros,
      monthly_cost_micros = excluded.monthly_cost_micros,
      lifetime_cost_micros = excluded.lifetime_cost_micros,
      builtin = 1,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `);
  for (const profile of Object.values(BUILTIN_QUOTA_PROFILES)) {
    upsert.run(...profileValues(profile), timestamp, timestamp);
  }
}
