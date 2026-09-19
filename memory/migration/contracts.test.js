import assert from 'node:assert/strict';
import test from 'node:test';

import * as migration from './index.js';

const NOW = '2031-02-03T04:05:06.000Z';

function context(overrides = {}) {
  return {
    authenticatedUserId: 'fake-user-a', actorType: 'user', actorId: 'fake-user-a',
    requestId: 'fake-request-1', correlationId: 'fake-correlation-1', timestamp: NOW,
    purpose: 'legacy_memory_migration', policyVersion: 'm8-v1', metadata: {}, ...overrides
  };
}

function source(overrides = {}) {
  return {
    id: 'fake-source-1', userId: 'fake-user-a', kind: 'notes', label: 'Fake notes',
    schemaVersion: 'v1', metadata: {}, scan: async () => [], ...overrides
  };
}

const REQUIRED_EXPORTS = [
  'MigrationSourceKind', 'MigrationCandidateStatus', 'MigrationPlanStatus', 'MigrationApprovalStatus',
  'MigrationExecutionStatus', 'MigrationAuditAction', 'MigrationError', 'validateMigrationContext',
  'createMigrationSource', 'createMigrationCandidate', 'createMigrationPlan', 'createMigrationReport',
  'MigrationScanner', 'DuplicateDetector', 'ConflictDetector', 'SensitiveDetector',
  'MigrationPlanner', 'DryRunEngine', 'ApprovalEngine', 'RollbackEngine', 'MigrationAudit',
  'MemoryMigrationFramework'
];

for (const name of REQUIRED_EXPORTS) {
  test(`exports ${name}`, () => assert.ok(migration[name], `${name} must be exported`));
}

for (const kind of ['chatgpt', 'wechat', 'email', 'calendar', 'notes', 'knowledge', 'files', 'photos', 'fake']) {
  test(`source kind includes ${kind}`, () => assert.equal(Object.values(migration.MigrationSourceKind ?? {}).includes(kind), true));
}

for (const status of ['ready_for_approval', 'duplicate', 'conflict', 'sensitive_approval_required', 'prohibited']) {
  test(`candidate status includes ${status}`, () => assert.equal(Object.values(migration.MigrationCandidateStatus ?? {}).includes(status), true));
}

for (const status of ['draft', 'approval_required', 'approved', 'executed', 'rolled_back', 'cancelled']) {
  test(`plan status includes ${status}`, () => assert.equal(Object.values(migration.MigrationPlanStatus ?? {}).includes(status), true));
}

test('accepts a trusted migration context', () => {
  assert.equal(migration.validateMigrationContext(context()).valid, true);
});

const INVALID_CONTEXTS = [
  ['missing user', { authenticatedUserId: '' }, 'REQUIRED'],
  ['invalid actor', { actorType: 'root' }, 'INVALID_ENUM'],
  ['missing actor id', { actorId: '' }, 'REQUIRED'],
  ['missing request id', { requestId: '' }, 'REQUIRED'],
  ['missing correlation id', { correlationId: '' }, 'REQUIRED'],
  ['invalid timestamp', { timestamp: 'tomorrow' }, 'INVALID_DATE'],
  ['missing purpose', { purpose: '' }, 'REQUIRED'],
  ['missing policy version', { policyVersion: '' }, 'REQUIRED'],
  ['non-object metadata', { metadata: [] }, 'INVALID_TYPE'],
  ['secret metadata', { metadata: { accessToken: 'not-a-real-token' } }, 'SECRET_FORBIDDEN'],
  ['unknown field', { unexpected: true }, 'UNKNOWN_FIELD']
];

for (const [name, override, code] of INVALID_CONTEXTS) {
  test(`context rejects ${name}`, () => {
    const result = migration.validateMigrationContext(context(override));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === code));
  });
}

test('creates and freezes a migration source', () => {
  const result = migration.createMigrationSource(source(), { trustedUserId: 'fake-user-a' });
  assert.equal(result.userId, 'fake-user-a');
  assert.equal(Object.isFrozen(result), true);
});

const INVALID_SOURCES = [
  ['missing id', { id: '' }, 'REQUIRED'],
  ['missing user', { userId: '' }, 'REQUIRED'],
  ['cross user', { userId: 'fake-user-b' }, 'USER_SCOPE_MISMATCH'],
  ['invalid kind', { kind: 'conversation' }, 'INVALID_ENUM'],
  ['missing label', { label: '' }, 'REQUIRED'],
  ['invalid schema', { schemaVersion: 'v2' }, 'UNSUPPORTED_SCHEMA_VERSION'],
  ['missing scan', { scan: null }, 'INTERFACE_METHOD_MISSING'],
  ['secret metadata', { metadata: { password: 'not-a-real-password' } }, 'SECRET_FORBIDDEN'],
  ['unknown field', { path: '/private/fake' }, 'UNKNOWN_FIELD']
];

for (const [name, override, code] of INVALID_SOURCES) {
  test(`source rejects ${name}`, () => {
    assert.throws(
      () => migration.createMigrationSource(source(override), { trustedUserId: 'fake-user-a' }),
      (error) => error?.code === code
    );
  });
}

test('migration errors expose only safe code messages', () => {
  const error = new migration.MigrationError('MIGRATION_SOURCE_INVALID');
  assert.equal(error.code, 'MIGRATION_SOURCE_INVALID');
  assert.equal(/not-a-real|private\/fake/i.test(error.message), false);
});

test('unknown migration error codes fail closed', () => {
  const error = new migration.MigrationError('some raw secret');
  assert.equal(error.code, 'MIGRATION_FAILED');
  assert.equal(error.message, 'Migration operation failed.');
});
