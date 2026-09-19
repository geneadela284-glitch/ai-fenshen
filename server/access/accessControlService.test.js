import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { AccessControlService } from './accessControlService.js';
import { AccessControlStore } from './accessControlStore.js';

function harness(start = '2026-07-28T08:00:00.000Z') {
  const directory = mkdtempSync(path.join(tmpdir(), 'aiwc-access-service-'));
  const dbPath = path.join(directory, 'access-control.sqlite');
  let nowMs = new Date(start).getTime();
  const clock = () => new Date(nowMs);
  let store = new AccessControlStore({ dbPath, clock }).initialize();
  let service = new AccessControlService({
    store,
    hmacSecret: 'access-control-test-hmac-secret-32',
    clock,
    leaseTtlMs: 120000
  });
  return {
    directory,
    dbPath,
    clock,
    get nowMs() { return nowMs; },
    set nowMs(value) { nowMs = value; },
    get store() { return store; },
    get service() { return service; },
    reopen() {
      store.close();
      store = new AccessControlStore({ dbPath, clock }).initialize();
      service = new AccessControlService({
        store,
        hmacSecret: 'access-control-test-hmac-secret-32',
        clock,
        leaseTtlMs: 120000
      });
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function bind(service, accountId, profileId = 'closed_beta_user_v1', role = 'beta_user') {
  service.bindAccountProfile({ accountId, profileId, enabled: true });
  return service.createAuthenticatedSubject({ accountId, role });
}

function attempt(overrides = {}) {
  return {
    requestId: 'req-a-1',
    executionId: 'exec-a-1',
    attemptType: 'planning',
    attemptNumber: 1,
    providerId: 'deepseek',
    modelId: 'deepseek-v4-flash',
    ...overrides
  };
}

test('request admission is account-isolated, persists crash leases, and expires them deterministically', () => {
  const h = harness();
  try {
    const subjectA = bind(h.service, 'account-a');
    const subjectB = bind(h.service, 'account-b');
    const leaseA1 = h.service.beginRequest({ subject: subjectA, requestId: 'req-a-1' });
    const leaseA2 = h.service.beginRequest({ subject: subjectA, requestId: 'req-a-2' });
    assert.equal(leaseA1.accountId, 'account-a');
    assert.equal(leaseA2.accountId, 'account-a');
    assert.throws(
      () => h.service.beginRequest({ subject: subjectA, requestId: 'req-a-3' }),
      { code: 'ACCOUNT_CONCURRENCY_LIMITED' }
    );
    assert.doesNotThrow(
      () => h.service.beginRequest({ subject: subjectB, requestId: 'req-b-1' })
    );

    h.reopen();
    const reopenedA = h.service.createAuthenticatedSubject({ accountId: 'account-a', role: 'beta_user' });
    assert.throws(
      () => h.service.beginRequest({ subject: reopenedA, requestId: 'req-a-3' }),
      { code: 'ACCOUNT_CONCURRENCY_LIMITED' }
    );
    h.nowMs += 120001;
    const recovered = h.service.beginRequest({ subject: reopenedA, requestId: 'req-a-3' });
    assert.equal(recovered.requestId, 'req-a-3');
  } finally {
    h.close();
  }
});

test('request rate, profile binding, enabled state, and storage failure are fail closed', () => {
  const h = harness();
  try {
    const unbound = h.service.createAuthenticatedSubject({ accountId: 'unbound', role: 'beta_user' });
    assert.throws(
      () => h.service.beginRequest({ subject: unbound, requestId: 'req-unbound' }),
      { code: 'ACCOUNT_QUOTA_NOT_CONFIGURED' }
    );

    h.store.putCustomProfile({
      id: 'request_rate_test_v1',
      requestsPerMinute: 2,
      maxConcurrentRequests: 5,
      providerCallsPerDay: 20,
      inputTokensPerDay: 10000,
      outputTokensPerDay: 10000,
      dailyCostMicros: 1000000,
      monthlyCostMicros: 5000000,
      lifetimeCostMicros: 10000000,
      enabled: true
    });
    const subject = bind(h.service, 'rate-account', 'request_rate_test_v1');
    h.service.beginRequest({ subject, requestId: 'rate-1' });
    h.service.beginRequest({ subject, requestId: 'rate-2' });
    assert.throws(
      () => h.service.beginRequest({ subject, requestId: 'rate-3' }),
      { code: 'ACCOUNT_REQUEST_RATE_LIMITED' }
    );

    h.service.setAccountEnabled({
      accountId: 'rate-account',
      enabled: false,
      reasonCode: 'TEST_DISABLE'
    });
    assert.throws(
      () => h.service.beginRequest({ subject, requestId: 'rate-disabled' }),
      { code: 'ACCOUNT_ACCESS_DISABLED' }
    );

    h.store.close();
    assert.throws(
      () => h.service.beginRequest({ subject, requestId: 'store-closed' }),
      { code: 'ACCESS_CONTROL_UNAVAILABLE' }
    );
  } finally {
    h.close();
  }
});

test('Provider attempts reserve atomically, count fallback and repair, and reject duplicate or over-limit calls', () => {
  const h = harness();
  try {
    h.store.putCustomProfile({
      id: 'attempt_test_v1',
      requestsPerMinute: 10,
      maxConcurrentRequests: 2,
      providerCallsPerDay: 3,
      inputTokensPerDay: 2000,
      outputTokensPerDay: 30,
      dailyCostMicros: 1000000,
      monthlyCostMicros: 5000000,
      lifetimeCostMicros: 10000000,
      enabled: true
    });
    const subject = bind(h.service, 'account-a', 'attempt_test_v1');
    const requestLease = h.service.beginRequest({ subject, requestId: 'req-a-1' });
    const providerRequest = {
      input: 'hello',
      messages: [{ role: 'user', content: 'hello' }],
      options: { maxTokens: 10 }
    };
    const primary = h.service.reserveProviderAttempt({
      subject,
      requestLease,
      attempt: attempt(),
      request: providerRequest,
      pricing: {
        version: '2026-07-28',
        currency: 'CNY',
        input_per_million: 1,
        output_per_million: 2
      }
    });
    assert.notEqual(primary.request, providerRequest);
    assert.equal(primary.request.options.maxTokens, 10);
    h.service.settleProviderAttempt({
      reservation: primary,
      usage: { input_tokens: 5, output_tokens: 4 },
      outcome: 'success'
    });

    assert.throws(
      () => h.service.reserveProviderAttempt({
        subject,
        requestLease,
        attempt: attempt(),
        request: providerRequest
      }),
      { code: 'DUPLICATE_PROVIDER_ATTEMPT' }
    );

    const fallback = h.service.reserveProviderAttempt({
      subject,
      requestLease,
      attempt: attempt({
        attemptType: 'fallback',
        attemptNumber: 2,
        providerId: 'qwen',
        modelId: 'qwen-max'
      }),
      request: providerRequest
    });
    h.service.settleProviderAttempt({
      reservation: fallback,
      usage: null,
      outcome: 'failed'
    });

    const repair = h.service.reserveProviderAttempt({
      subject,
      requestLease,
      attempt: attempt({
        attemptType: 'schema_repair',
        attemptNumber: 2
      }),
      request: providerRequest
    });
    h.service.settleProviderAttempt({
      reservation: repair,
      usage: { inputTokens: 3, outputTokens: 2 },
      outcome: 'success'
    });

    assert.throws(
      () => h.service.reserveProviderAttempt({
        subject,
        requestLease,
        attempt: attempt({
          executionId: 'exec-a-2',
          attemptNumber: 3
        }),
        request: providerRequest
      }),
      { code: 'ACCOUNT_USAGE_LIMIT_REACHED' }
    );

    const daily = h.store.getUsageBucket({
      accountId: 'account-a',
      bucketType: 'day',
      bucketKey: '2026-07-28'
    });
    assert.equal(daily.providerCalls, 3);
    assert.equal(daily.inputTokens, 5 + fallback.reservedInputTokens + 3);
    assert.equal(daily.outputTokens, 4 + fallback.reservedOutputTokens + 2);
    assert.equal(daily.costUnavailableCount, 2);
    assert.equal(daily.costMicros, 13);
    const monthly = h.store.getUsageBucket({
      accountId: 'account-a',
      bucketType: 'month',
      bucketKey: '2026-07'
    });
    const lifetime = h.store.getUsageBucket({
      accountId: 'account-a',
      bucketType: 'lifetime',
      bucketKey: 'lifetime'
    });
    assert.equal(monthly.costMicros, daily.costMicros);
    assert.equal(lifetime.costMicros, daily.costMicros);
    assert.equal(monthly.providerCalls, 3);
    assert.equal(lifetime.providerCalls, 3);
  } finally {
    h.close();
  }
});

test('multimodal quota reservation ignores image Base64 length while preserving the legacy text estimate', () => {
  const h = harness();
  try {
    h.store.putCustomProfile({
      id: 'multimodal_quota_v1',
      requestsPerMinute: 10,
      maxConcurrentRequests: 4,
      providerCallsPerDay: 10,
      inputTokensPerDay: 2000000,
      outputTokensPerDay: 100000,
      dailyCostMicros: 1000000,
      monthlyCostMicros: 5000000,
      lifetimeCostMicros: 10000000,
      enabled: true
    });
    const subject = bind(h.service, 'photo-account', 'multimodal_quota_v1');
    const textRequest = {
      input: 'hello',
      messages: [{ role: 'user', content: 'hello' }],
      options: { maxTokens: 10 }
    };
    const textLease = h.service.beginRequest({ subject, requestId: 'text-request' });
    const textReservation = h.service.reserveProviderAttempt({
      subject,
      requestLease: textLease,
      attempt: attempt({
        requestId: 'text-request',
        executionId: 'text-execution'
      }),
      request: textRequest
    });
    assert.equal(
      textReservation.reservedInputTokens,
      Buffer.byteLength(JSON.stringify({
        input: textRequest.input,
        messages: textRequest.messages
      }), 'utf8')
    );
    h.service.settleProviderAttempt({
      reservation: textReservation,
      usage: { input_tokens: 5, output_tokens: 2 },
      outcome: 'success'
    });
    h.service.releaseRequest(textLease);

    const jpegBase64 = 'A'.repeat(4_623_016);
    const reservations = [];
    for (const imageCount of [1, 2, 3]) {
      const requestId = `photo-request-${imageCount}`;
      const requestLease = h.service.beginRequest({ subject, requestId });
      const content = Array.from({ length: imageCount }, () => ({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${jpegBase64}` }
      }));
      content.push({ type: 'text', text: '这张照片里有什么？' });
      const reservation = h.service.reserveProviderAttempt({
        subject,
        requestLease,
        attempt: attempt({
          requestId,
          executionId: `photo-execution-${imageCount}`,
          attemptType: 'attachment_vision',
          providerId: 'qwen',
          modelId: 'qwen3-vl-plus'
        }),
        request: { messages: [{ role: 'user', content }], options: { maxTokens: 10 } }
      });
      reservations.push(reservation.reservedInputTokens);
      h.service.settleProviderAttempt({
        reservation,
        usage: { input_tokens: 3000 * imageCount, output_tokens: 100 },
        outcome: 'success'
      });
      h.service.releaseRequest(requestLease);
    }
    assert.equal(reservations[0] < 2000000, true);
    assert.equal(reservations[1] > reservations[0], true);
    assert.equal(reservations[2] > reservations[1], true);
    assert.equal(reservations[2] - reservations[1], reservations[1] - reservations[0]);
  } finally {
    h.close();
  }
});

test('missing Provider usage remains explicitly estimated and duplicate attempts stay blocked', () => {
  const h = harness();
  try {
    const subject = bind(h.service, 'estimated-account');
    const requestLease = h.service.beginRequest({ subject, requestId: 'estimated-request' });
    const providerAttempt = attempt({
      requestId: 'estimated-request',
      executionId: 'estimated-execution',
      attemptType: 'attachment_ocr',
      providerId: 'qwen',
      modelId: 'qwen3.5-ocr'
    });
    const reservation = h.service.reserveProviderAttempt({
      subject,
      requestLease,
      attempt: providerAttempt,
      request: { messages: [{ role: 'user', content: 'OCR' }], options: { maxTokens: 10 } }
    });
    h.service.settleProviderAttempt({ reservation, usage: null, outcome: 'success' });
    const event = h.store.database.prepare(`
      SELECT event_type, outcome, reason_code
      FROM security_events
      WHERE event_type = 'provider_usage_settlement'
      ORDER BY created_at DESC LIMIT 1
    `).get();
    assert.equal(event.event_type, 'provider_usage_settlement');
    assert.equal(event.outcome, 'estimated');
    assert.equal(event.reason_code, 'PROVIDER_USAGE_UNAVAILABLE');
    assert.throws(
      () => h.service.reserveProviderAttempt({
        subject,
        requestLease,
        attempt: providerAttempt,
        request: { input: 'retry', options: { maxTokens: 10 } }
      }),
      { code: 'DUPLICATE_PROVIDER_ATTEMPT' }
    );
  } finally {
    h.close();
  }
});

test('security persistence contains no complete content or credential material', () => {
  const h = harness();
  try {
    const subject = bind(h.service, 'redaction-account');
    const requestLease = h.service.beginRequest({ subject, requestId: 'req-private' });
    const reservation = h.service.reserveProviderAttempt({
      subject,
      requestLease,
      attempt: attempt({
        requestId: 'req-private',
        executionId: 'exec-private'
      }),
      request: {
        input: 'complete prompt private PasswordPrivate1! sk-private',
        messages: [{
          role: 'user',
          content: 'ai_secretary_session=private complete response private'
        }],
        options: { maxTokens: 5 }
      }
    });
    h.service.settleProviderAttempt({
      reservation,
      usage: { inputTokens: 2, outputTokens: 1 },
      outcome: 'success'
    });

    const tables = h.store.database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    `).all().map((row) => row.name);
    const serialized = tables.flatMap((table) =>
      h.store.database.prepare(`SELECT * FROM "${table}"`).all())
      .map((row) => JSON.stringify(row))
      .join('\n');
    assert.doesNotMatch(
      serialized,
      /complete prompt private|complete response private|PasswordPrivate1!|ai_secretary_session=private|sk-private/
    );
  } finally {
    h.close();
  }
});
