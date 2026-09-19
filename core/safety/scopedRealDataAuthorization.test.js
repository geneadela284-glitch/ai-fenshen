import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertScopedRealDataOperation,
  selectScopedRealDataAuthorization,
  validateScopedRealDataAuthorization,
  validateScopedRealDataAuthorizations
} from './scopedRealDataAuthorization.js';

const ACCEPTANCE_DB = '/Users/tristazhang/Desktop/AI-Fenshen-Dev/runtime/m9-2-acceptance/memory.sqlite';
const VPS_DB = '/opt/ai-fenshen-staging/shared/data/memory/memory.sqlite';
const ORIGINAL_DB = '/Users/tristazhang/Desktop/Ai work center/data/memory/memory.sqlite';

function authorization(overrides = {}) {
  return {
    scope: 'local-m9-2-acceptance',
    environment: 'local-m9-2-acceptance',
    database_kind: 'isolated_acceptance_memory',
    database_path: ACCEPTANCE_DB,
    owner_source: 'authenticated_session',
    allowed_operations: ['capture', 'query', 'correct', 'delete', 'restore', 'purge'],
    original_memory_database: {
      path: ORIGINAL_DB,
      access: 'read_only'
    },
    cross_owner_access: 'denied',
    migration_allowed: false,
    bulk_import_allowed: false,
    active_action_ids: ['M9_2_REAL_CONVERSATION_MEMORY_OS_WIRING'],
    ...overrides
  };
}

function request(overrides = {}) {
  return {
    authorization: authorization(),
    scope: 'local-m9-2-acceptance',
    databasePath: ACCEPTANCE_DB,
    ownerSource: 'authenticated_session',
    operation: 'capture',
    actionId: 'M9_2_REAL_CONVERSATION_MEMORY_OS_WIRING',
    ...overrides
  };
}

function vpsAuthorization(overrides = {}) {
  return authorization({
    scope: 'vps-staging',
    environment: 'vps-staging',
    database_path: VPS_DB,
    ...overrides
  });
}

function authorizations(overrides = {}) {
  return {
    'local-m9-2-acceptance': authorization(),
    'vps-staging': vpsAuthorization(),
    ...overrides
  };
}

test('valid isolated acceptance authorization is accepted', () => {
  assert.deepEqual(validateScopedRealDataAuthorization(authorization()), []);
  assert.doesNotThrow(() => assertScopedRealDataOperation(request()));
});

test('unscoped real-data access fails closed', () => {
  assert.throws(() => assertScopedRealDataOperation(request({ authorization: null })), /authorization|fail.closed/i);
});

test('authorization rejects a different database path', () => {
  assert.throws(() => assertScopedRealDataOperation(request({ databasePath: ORIGINAL_DB })), /database.*path|read.only/i);
});

test('authorization rejects a non-session owner source', () => {
  assert.throws(() => assertScopedRealDataOperation(request({ ownerSource: 'request_body' })), /owner.*session/i);
});

test('authorization rejects an operation outside the allowlist', () => {
  assert.throws(() => assertScopedRealDataOperation(request({ operation: 'bulk_import' })), /operation/i);
});

test('authorization is inactive outside its canonical action lifecycle', () => {
  assert.throws(() => assertScopedRealDataOperation(request({ actionId: 'M10_UNRELATED' })), /action|inactive/i);
});

test('original memory database can never be an authorized write target', () => {
  const errors = validateScopedRealDataAuthorization(authorization({ database_path: ORIGINAL_DB }));
  assert.match(errors.join('\n'), /original.*database|same.*path|read.only/i);
});

test('two isolated scope authorizations are valid together', () => {
  assert.deepEqual(validateScopedRealDataAuthorizations(authorizations()), []);
});

test('scope-keyed authorization collection rejects arrays', () => {
  assert.match(validateScopedRealDataAuthorizations([]).join('\n'), /object|array/i);
});

test('local and VPS scopes are selected explicitly', () => {
  assert.equal(selectScopedRealDataAuthorization({
    authorizations: authorizations(),
    requestedScope: 'local-m9-2-acceptance'
  }).database_path, ACCEPTANCE_DB);
  assert.equal(selectScopedRealDataAuthorization({
    authorizations: authorizations(),
    requestedScope: 'vps-staging'
  }).database_path, VPS_DB);
});

test('missing or unknown requested scope fails closed', () => {
  assert.throws(() => selectScopedRealDataAuthorization({ authorizations: authorizations() }), /scope|fail.closed/i);
  assert.throws(() => selectScopedRealDataAuthorization({
    authorizations: authorizations(),
    requestedScope: 'production'
  }), /scope|fail.closed/i);
});

test('local scope cannot access VPS database and VPS scope cannot access local database', () => {
  assert.throws(() => assertScopedRealDataOperation(request({ databasePath: VPS_DB })), /database.*path/i);
  assert.throws(() => assertScopedRealDataOperation(request({
    authorization: vpsAuthorization(),
    scope: 'vps-staging',
    databasePath: ACCEPTANCE_DB
  })), /database.*path/i);
});

test('unregistered and similar-prefix database paths fail closed', () => {
  assert.throws(() => assertScopedRealDataOperation(request({
    databasePath: '/tmp/unregistered-memory.sqlite'
  })), /database.*path/i);
  assert.throws(() => assertScopedRealDataOperation(request({
    databasePath: `${ACCEPTANCE_DB}-copy`
  })), /database.*path/i);
});

test('relative database paths fail closed', () => {
  assert.throws(() => assertScopedRealDataOperation(request({
    databasePath: 'runtime/memory.sqlite'
  })), /database.*path|absolute|fail.closed/i);
});

test('symlink path cannot escape the authorized real database location', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-real-data-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  const link = path.join(root, 'allowed-link');
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, link);
  const authorizedPath = path.join(allowed, 'memory.sqlite');
  const escapedPath = path.join(link, 'memory.sqlite');
  assert.throws(() => assertScopedRealDataOperation(request({
    authorization: authorization({ database_path: authorizedPath }),
    databasePath: escapedPath
  })), /database.*path|fail.closed/i);
});

test('collection rejects key and embedded scope mismatch or duplicate scope', () => {
  const errors = validateScopedRealDataAuthorizations(authorizations({
    'vps-staging': vpsAuthorization({
      scope: 'local-m9-2-acceptance',
      environment: 'local-m9-2-acceptance'
    })
  }));
  assert.match(errors.join('\n'), /key|scope|duplicate/i);
});

test('collection rejects two scopes resolving to the same database path', () => {
  const errors = validateScopedRealDataAuthorizations(authorizations({
    'vps-staging': vpsAuthorization({ database_path: ACCEPTANCE_DB })
  }));
  assert.match(errors.join('\n'), /database.*path|duplicate/i);
});

test('cross-owner access remains denied by every authorization entry', () => {
  const errors = validateScopedRealDataAuthorizations(authorizations({
    'vps-staging': vpsAuthorization({ cross_owner_access: 'allowed' })
  }));
  assert.match(errors.join('\n'), /cross.owner|denied/i);
});

test('inherited object keys can never select an authorization scope', () => {
  assert.throws(() => selectScopedRealDataAuthorization({
    authorizations: authorizations(),
    requestedScope: 'toString'
  }), /scope|fail.closed/i);
});

test('authorization registry must be a plain object', () => {
  class AuthorizationRegistry {}
  const registry = Object.assign(new AuthorizationRegistry(), authorizations());
  assert.match(validateScopedRealDataAuthorizations(registry).join('\n'), /plain|object/i);
});

test('explicit legacy and collection fields fail closed even when one is falsy', () => {
  assert.throws(() => selectScopedRealDataAuthorization({
    authorization: null,
    authorizations: authorizations(),
    requestedScope: 'local-m9-2-acceptance'
  }), /legacy|multi.scope|both|fail.closed/i);
});

test('dangling symlink resolution fails closed without leaking its path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-real-data-dangling-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dangling = path.join(root, 'dangling');
  fs.symlinkSync(path.join(root, 'missing-target'), dangling);
  const databasePath = path.join(dangling, 'memory.sqlite');
  assert.throws(
    () => assertScopedRealDataOperation(request({
      authorization: authorization({ database_path: databasePath }),
      databasePath
    })),
    (error) => error instanceof Error &&
      /SCOPED_REAL_DATA_FAIL_CLOSED/.test(error.message) &&
      !error.message.includes(root)
  );
});

test('authorized capability returns the resolved real database path', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-real-data-capability-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realDirectory = path.join(root, 'real');
  const link = path.join(root, 'link');
  fs.mkdirSync(realDirectory);
  fs.symlinkSync(realDirectory, link);
  const canonicalPath = path.join(fs.realpathSync(realDirectory), 'memory.sqlite');
  const linkedPath = path.join(link, 'memory.sqlite');
  const capability = assertScopedRealDataOperation(request({
    authorization: authorization({ database_path: canonicalPath }),
    databasePath: linkedPath
  }));
  assert.equal(capability.databasePath, canonicalPath);
});

test('selected authorization policy is deeply immutable', () => {
  const selected = selectScopedRealDataAuthorization({
    authorizations: authorizations(),
    requestedScope: 'local-m9-2-acceptance'
  });
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.allowed_operations), true);
  assert.equal(Object.isFrozen(selected.active_action_ids), true);
  assert.equal(Object.isFrozen(selected.original_memory_database), true);
  assert.throws(() => selected.allowed_operations.push('query'), /read only|extensible|frozen|object/i);
});
