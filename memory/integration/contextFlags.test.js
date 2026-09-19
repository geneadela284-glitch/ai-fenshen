import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AuthenticatedMemoryContextFactory,
  MemoryFeatureFlags,
  MemoryIntegrationAudit
} from './index.js';

const NOW = '2026-07-16T08:00:00.000Z';
const session = (overrides = {}) => ({
  id: 'fake-user-a', username: 'fake-user-a', role: 'user', status: 'active', ...overrides
});

for (let index = 1; index <= 20; index += 1) {
  test(`authenticated context binds trusted session user ${index}`, () => {
    const factory = new AuthenticatedMemoryContextFactory({
      clock: () => new Date(NOW), idFactory: () => `request-${index}`
    });
    const context = factory.repository(session({ id: `fake-user-${index}` }), {
      timezone: index % 2 ? 'Asia/Shanghai' : 'UTC', locale: index % 2 ? 'zh-CN' : 'en-US'
    });
    assert.equal(context.authenticatedUserId, `fake-user-${index}`);
    assert.equal(context.actorId, `fake-user-${index}`);
    assert.equal(context.actorType, 'user');
    assert.equal(context.timestamp, NOW);
    assert.equal(context.requestId, `request-${index}`);
    assert.equal(context.transactionId, null);
    assert.deepEqual(context.metadata, {});
  });
}

for (const [index, forged] of [
  ['userId', { userId: 'victim' }],
  ['authenticatedUserId', { authenticatedUserId: 'victim' }],
  ['actorId', { actorId: 'victim' }],
  ['role', { role: 'admin' }],
  ['sessionUserId', { sessionUserId: 'victim' }],
  ['accountId', { accountId: 'victim' }],
  ['ownerId', { ownerId: 'victim' }],
  ['tenantUserId', { tenantUserId: 'victim' }],
  ['requestedUserId', { requestedUserId: 'victim' }],
  ['urlUserId', { urlUserId: 'victim' }]
]) {
  test(`authenticated context rejects forged identity field ${index}`, () => {
    const factory = new AuthenticatedMemoryContextFactory();
    assert.throws(() => factory.repository(session(), forged), (error) => error?.code === 'MEMORY_AUTH_FORGED_IDENTITY');
  });
}

for (const [name, invalidSession] of [
  ['null', null],
  ['undefined', undefined],
  ['empty object', {}],
  ['blank id', session({ id: '' })],
  ['disabled', session({ status: 'disabled' })],
  ['missing status', { id: 'fake-user-a', username: 'fake-user-a', role: 'user' }],
  ['missing username', { id: 'fake-user-a', status: 'active', role: 'user' }],
  ['array', []],
  ['string', 'fake-user-a'],
  ['numeric id', session({ id: 7 })]
]) {
  test(`authenticated context rejects unauthenticated session: ${name}`, () => {
    const factory = new AuthenticatedMemoryContextFactory();
    assert.throws(() => factory.repository(invalidSession), (error) => error?.code === 'MEMORY_AUTH_REQUIRED');
  });
}

test('recall context uses bounded default purpose and budget', () => {
  const context = new AuthenticatedMemoryContextFactory({ clock: () => new Date(NOW) }).recall(session(), {});
  assert.equal(context.purpose, 'assistant');
  assert.equal(context.sensitivityAllowance, 'medium');
  assert.equal(context.contextBudget.maxItems, 8);
  assert.equal(context.contextBudget.maxSensitiveItems, 0);
});

test('governance context carries expected version and confirmation token only from operation payload', () => {
  const context = new AuthenticatedMemoryContextFactory({ clock: () => new Date(NOW) }).governance(session(), {
    operation: 'delete', expectedVersion: 3, confirmationToken: 'fake-confirmation'
  });
  assert.equal(context.expectedVersion, 3);
  assert.equal(context.confirmationToken, 'fake-confirmation');
  assert.equal(context.authenticatedUserId, 'fake-user-a');
});

test('timeline context is read-only and session-bound', () => {
  const context = new AuthenticatedMemoryContextFactory({ clock: () => new Date(NOW) }).timeline(session(), {});
  assert.equal(context.purpose, 'timeline_view');
  assert.equal(context.authenticatedUserId, 'fake-user-a');
  assert.equal('expectedVersion' in context, false);
});

const flagNames = [
  'MEMORY_REAL_USER_ENABLED', 'MEMORY_CAPTURE_ENABLED', 'MEMORY_RECALL_ENABLED',
  'MEMORY_GOVERNANCE_ENABLED', 'MEMORY_TIMELINE_ENABLED', 'MEMORY_INTELLIGENCE_ENABLED'
];

for (const flag of flagNames) {
  test(`${flag} is fail-closed when omitted`, () => {
    const flags = new MemoryFeatureFlags({ env: {}, whitelist: ['fake-user-a'] });
    assert.equal(flags.isEnabled(flag, session()), false);
  });

  test(`${flag} obeys the master flag`, () => {
    const flags = new MemoryFeatureFlags({ env: { [flag]: 'true' }, whitelist: ['fake-user-a'] });
    assert.equal(flags.isEnabled(flag, session()), flag === 'MEMORY_REAL_USER_ENABLED');
  });

  test(`${flag} requires a whitelisted account`, () => {
    const flags = new MemoryFeatureFlags({
      env: { MEMORY_REAL_USER_ENABLED: 'true', [flag]: 'true' }, whitelist: ['huage']
    });
    assert.equal(flags.isEnabled(flag, session()), false);
  });

  test(`${flag} enables only for an active whitelisted account`, () => {
    const flags = new MemoryFeatureFlags({
      env: { MEMORY_REAL_USER_ENABLED: 'true', [flag]: 'true' }, whitelist: ['fake-user-a']
    });
    assert.equal(flags.isEnabled(flag, session()), true);
    assert.equal(flags.isEnabled(flag, session({ status: 'disabled' })), false);
  });
}

test('feature flags accept the first server-side huage whitelist without exposing a mutation API', () => {
  const flags = new MemoryFeatureFlags({ env: { MEMORY_REAL_USER_ENABLED: 'true' } });
  assert.equal(flags.isEnabled('MEMORY_CAPTURE_ENABLED', session({ id: 'acct-huage', username: 'huage', role: 'admin' })), true);
  assert.equal(typeof flags.set, 'undefined');
});

test('admin role cannot bypass the whitelist', () => {
  const flags = new MemoryFeatureFlags({ env: { MEMORY_REAL_USER_ENABLED: 'true' }, whitelist: ['huage'] });
  assert.equal(flags.isEnabled('MEMORY_RECALL_ENABLED', session({ role: 'admin' })), false);
});

test('feature evaluation audit contains flags but no memory body', () => {
  const flags = new MemoryFeatureFlags({ env: { MEMORY_REAL_USER_ENABLED: 'true' }, whitelist: ['fake-user-a'] });
  flags.evaluate(session());
  const [event] = flags.listAuditEvents('fake-user-a');
  assert.equal(event.userId, 'fake-user-a');
  assert.equal(event.action, 'memory_feature_flags_evaluated');
  assert.equal(JSON.stringify(event).includes('memory body'), false);
});

for (let index = 1; index <= 10; index += 1) {
  test(`integration audit stores only safe references ${index}`, () => {
    const audit = new MemoryIntegrationAudit({ clock: () => new Date(NOW), idFactory: () => `audit-${index}` });
    const event = audit.record({
      userId: `fake-user-${index}`,
      action: 'memory_integration_checked',
      result: 'completed',
      reasonCode: `SAFE_REASON_${index}`,
      memoryId: `fake-memory-${index}`,
      requestId: `fake-request-${index}`,
      metadata: { selectedCount: index }
    });
    assert.deepEqual(Object.keys(event).sort(), [
      'action', 'eventId', 'memoryId', 'metadata', 'occurredAt', 'reasonCode', 'requestId', 'result', 'userId'
    ]);
    assert.equal(audit.list(`fake-user-${index}`).length, 1);
    assert.equal(audit.list('fake-user-other').length, 0);
  });
}

for (const [name, metadata] of [
  ['password', { password: 'not-allowed' }],
  ['token', { accessToken: 'not-allowed' }],
  ['cookie', { cookie: 'not-allowed' }],
  ['api key', { apiKey: 'not-allowed' }],
  ['memory body', { body: 'complete memory body' }]
]) {
  test(`integration audit rejects unsafe ${name} metadata`, () => {
    const audit = new MemoryIntegrationAudit();
    assert.throws(() => audit.record({
      userId: 'fake-user-a', action: 'test', result: 'failed', reasonCode: 'TEST', requestId: 'request', metadata
    }), (error) => error?.code === 'MEMORY_AUDIT_UNSAFE_METADATA');
  });
}
