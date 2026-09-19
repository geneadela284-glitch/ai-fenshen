import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveProtectedMemoryRuntimeConfig } from './protectedMemoryConfig.js';

const db = '/Users/example/runtime/m9-2-acceptance/memory.sqlite';
const vpsDb = '/opt/ai-fenshen-staging/shared/data/memory/memory.sqlite';
const original = '/Users/example/data/memory/memory.sqlite';
const action = 'M9_2_REAL_CONVERSATION_MEMORY_OS_WIRING';

function state(overrides = {}) {
  return {
    current_engineering_action: { id: action },
    next_product_action_after_stabilization: { id: 'M9_2_MANUAL_REAL_USER_ACCEPTANCE' },
    real_data_authorization: {
      scope: 'local-m9-2-acceptance', environment: 'local-m9-2-acceptance',
      database_kind: 'isolated_acceptance_memory', database_path: db,
      owner_source: 'authenticated_session',
      allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
      original_memory_database: { path: original, access: 'read_only' },
      cross_owner_access: 'denied', migration_allowed: false, bulk_import_allowed: false,
      active_action_ids: [action, 'M9_2_MANUAL_REAL_USER_ACCEPTANCE']
    },
    ...overrides
  };
}

function multiScopeState() {
  const result = state();
  const local = result.real_data_authorization;
  delete result.real_data_authorization;
  result.real_data_authorizations = {
    'local-m9-2-acceptance': local,
    'vps-staging': {
      ...local,
      scope: 'vps-staging',
      environment: 'vps-staging',
      database_path: vpsDb
    }
  };
  return result;
}

test('server resolves the exact canonical protected acceptance scope', () => {
  const result = resolveProtectedMemoryRuntimeConfig({
    canonicalState: state(), databasePath: db, scope: 'local-m9-2-acceptance'
  });
  assert.equal(result.databasePath, db);
  assert.equal(result.actionId, action);
  assert.equal(result.memoryPolicy, 'protected_acceptance');
  assert.equal(Object.isFrozen(result.authorization), true);
  assert.equal(Object.isFrozen(result.authorization.allowed_operations), true);
  assert.equal(Object.isFrozen(result.authorization.active_action_ids), true);
});

test('server fails closed for another database, scope, or inactive action', () => {
  assert.throws(() => resolveProtectedMemoryRuntimeConfig({ canonicalState: state(), databasePath: `${db}.other`, scope: 'local-m9-2-acceptance' }), /FAIL_CLOSED/);
  assert.throws(() => resolveProtectedMemoryRuntimeConfig({ canonicalState: state(), databasePath: db, scope: 'other' }), /FAIL_CLOSED/);
  assert.throws(() => resolveProtectedMemoryRuntimeConfig({
    canonicalState: state({ current_engineering_action: { id: 'OTHER_ACTION' }, next_product_action_after_stabilization: { id: 'OTHER_NEXT' } }),
    databasePath: db, scope: 'local-m9-2-acceptance'
  }), /FAIL_CLOSED/);
});

test('server explicitly selects one registered local or VPS scope', () => {
  const local = resolveProtectedMemoryRuntimeConfig({
    canonicalState: multiScopeState(), databasePath: db, scope: 'local-m9-2-acceptance'
  });
  assert.equal(local.scope, 'local-m9-2-acceptance');
  assert.equal(local.databasePath, db);
  const vps = resolveProtectedMemoryRuntimeConfig({
    canonicalState: multiScopeState(), databasePath: vpsDb, scope: 'vps-staging'
  });
  assert.equal(vps.scope, 'vps-staging');
  assert.equal(vps.databasePath, vpsDb);
});

test('server rejects missing scope and bidirectional cross-scope database paths', () => {
  assert.throws(() => resolveProtectedMemoryRuntimeConfig({
    canonicalState: multiScopeState(), databasePath: db
  }), /scope|FAIL_CLOSED/i);
  assert.throws(() => resolveProtectedMemoryRuntimeConfig({
    canonicalState: multiScopeState(), databasePath: vpsDb, scope: 'local-m9-2-acceptance'
  }), /database.*path|FAIL_CLOSED/i);
  assert.throws(() => resolveProtectedMemoryRuntimeConfig({
    canonicalState: multiScopeState(), databasePath: db, scope: 'vps-staging'
  }), /database.*path|FAIL_CLOSED/i);
});

test('server rejects simultaneous legacy and multi-scope canonical authorization forms', () => {
  const canonicalState = multiScopeState();
  canonicalState.real_data_authorization = state().real_data_authorization;
  assert.throws(() => resolveProtectedMemoryRuntimeConfig({
    canonicalState, databasePath: db, scope: 'local-m9-2-acceptance'
  }), /legacy|multi.scope|both|FAIL_CLOSED/i);
});
