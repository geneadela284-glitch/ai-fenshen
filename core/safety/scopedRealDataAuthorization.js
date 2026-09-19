import fs from 'node:fs';
import path from 'node:path';

export const SCOPED_REAL_DATA_OPERATIONS = Object.freeze([
  'capture',
  'query',
  'correct',
  'delete',
  'restore',
  'purge'
]);

const AUTHORIZATION_FIELDS = Object.freeze([
  'scope',
  'environment',
  'database_kind',
  'database_path',
  'owner_source',
  'allowed_operations',
  'original_memory_database',
  'cross_owner_access',
  'migration_allowed',
  'bulk_import_allowed',
  'active_action_ids'
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every(nonEmptyString) && new Set(value).size === value.length;
}

function normalizedAbsolutePath(value) {
  return nonEmptyString(value) && path.isAbsolute(value) && path.normalize(value) === value;
}

function canonicalAbsolutePath(value) {
  if (!normalizedAbsolutePath(value)) return null;
  try {
    const missingSegments = [];
    let existingPath = value;
    while (true) {
      try {
        fs.lstatSync(existingPath);
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') return null;
      }
      const parent = path.dirname(existingPath);
      if (parent === existingPath) return null;
      missingSegments.unshift(path.basename(existingPath));
      existingPath = parent;
    }
    const realExistingPath = fs.realpathSync(existingPath);
    return path.join(realExistingPath, ...missingSegments);
  } catch {
    return null;
  }
}

function failClosed(errors) {
  throw new Error(`SCOPED_REAL_DATA_FAIL_CLOSED: ${errors.join(' ')}`);
}

export function validateScopedRealDataAuthorization(authorization, { canonicalActionIds = [] } = {}) {
  const errors = [];
  if (!isObject(authorization)) return ['real_data_authorization must be an object.'];

  const unknownFields = Object.keys(authorization).filter((field) => !AUTHORIZATION_FIELDS.includes(field));
  if (unknownFields.length > 0) {
    errors.push(`real_data_authorization contains unsupported fields: ${unknownFields.join(', ')}.`);
  }
  for (const field of AUTHORIZATION_FIELDS) {
    if (!(field in authorization)) errors.push(`real_data_authorization.${field} is required.`);
  }

  if (!nonEmptyString(authorization.scope)) errors.push('real_data_authorization.scope is required.');
  if (authorization.environment !== authorization.scope) {
    errors.push('real_data_authorization.environment must exactly match its scope.');
  }
  if (authorization.database_kind !== 'isolated_acceptance_memory') {
    errors.push('real_data_authorization.database_kind must be isolated_acceptance_memory.');
  }
  if (!normalizedAbsolutePath(authorization.database_path)) {
    errors.push('real_data_authorization.database_path must be a normalized absolute path.');
  }
  if (authorization.owner_source !== 'authenticated_session') {
    errors.push('real_data_authorization.owner_source must be authenticated_session.');
  }
  if (!uniqueStrings(authorization.allowed_operations)) {
    errors.push('real_data_authorization.allowed_operations must contain unique operations.');
  } else {
    for (const operation of authorization.allowed_operations) {
      if (!SCOPED_REAL_DATA_OPERATIONS.includes(operation)) {
        errors.push(`real_data_authorization operation is unsupported: ${operation}.`);
      }
    }
  }
  if (!isObject(authorization.original_memory_database)) {
    errors.push('real_data_authorization.original_memory_database must be an object.');
  } else {
    const originalFields = Object.keys(authorization.original_memory_database);
    if (originalFields.length !== 2 || !originalFields.includes('path') || !originalFields.includes('access')) {
      errors.push('real_data_authorization.original_memory_database may contain only path and access.');
    }
    if (!normalizedAbsolutePath(authorization.original_memory_database.path)) {
      errors.push('real_data_authorization original database path must be a normalized absolute path.');
    }
    if (authorization.original_memory_database.access !== 'read_only') {
      errors.push('real_data_authorization original database must remain read_only.');
    }
    if (authorization.original_memory_database.path === authorization.database_path) {
      errors.push('real_data_authorization acceptance and original database paths must be different.');
    }
  }
  if (authorization.cross_owner_access !== 'denied') {
    errors.push('real_data_authorization.cross_owner_access must be denied.');
  }
  if (authorization.migration_allowed !== false) {
    errors.push('real_data_authorization.migration_allowed must be false.');
  }
  if (authorization.bulk_import_allowed !== false) {
    errors.push('real_data_authorization.bulk_import_allowed must be false.');
  }
  if (!uniqueStrings(authorization.active_action_ids)) {
    errors.push('real_data_authorization.active_action_ids must contain unique action IDs.');
  } else if (canonicalActionIds.length > 0 && !canonicalActionIds.some((id) => authorization.active_action_ids.includes(id))) {
    errors.push('real_data_authorization is inactive for the current canonical action lifecycle.');
  }
  return errors;
}

export function validateScopedRealDataAuthorizations(authorizations, { canonicalActionIds = [] } = {}) {
  if (!isPlainObject(authorizations)) return ['real_data_authorizations must be a plain scope-keyed object, not an array.'];
  const entries = Object.entries(authorizations);
  if (entries.length === 0) return ['real_data_authorizations must contain at least one scope.'];

  const errors = [];
  const seenScopes = new Set();
  const seenDatabasePaths = new Set();
  for (const [scopeKey, authorization] of entries) {
    const entryErrors = validateScopedRealDataAuthorization(authorization, { canonicalActionIds });
    errors.push(...entryErrors.map((error) => `${scopeKey}: ${error}`));
    if (!isObject(authorization)) continue;
    if (scopeKey !== authorization.scope) {
      errors.push(`real_data_authorizations key must exactly match entry scope: ${scopeKey}.`);
    }
    if (seenScopes.has(authorization.scope)) {
      errors.push(`real_data_authorizations contains duplicate scope: ${authorization.scope}.`);
    }
    seenScopes.add(authorization.scope);
    const canonicalDatabasePath = canonicalAbsolutePath(authorization.database_path);
    if (!canonicalDatabasePath) {
      errors.push('real_data_authorizations database path cannot be resolved safely.');
    }
    if (canonicalDatabasePath && seenDatabasePaths.has(canonicalDatabasePath)) {
      errors.push('real_data_authorizations contains a duplicate database path.');
    }
    if (canonicalDatabasePath) seenDatabasePaths.add(canonicalDatabasePath);
  }
  return errors;
}

export function selectScopedRealDataAuthorization(options = {}) {
  const hasLegacyAuthorization = Object.hasOwn(options, 'authorization');
  const hasAuthorizationCollection = Object.hasOwn(options, 'authorizations');
  const { authorization, authorizations, requestedScope, canonicalActionIds = [] } = options;
  if (!nonEmptyString(requestedScope)) {
    failClosed(['an explicit authorization scope is required.']);
  }
  if (hasLegacyAuthorization && hasAuthorizationCollection) {
    failClosed(['legacy and multi-scope authorizations cannot both be active.']);
  }
  if (hasAuthorizationCollection) {
    const errors = validateScopedRealDataAuthorizations(authorizations, { canonicalActionIds });
    if (errors.length > 0) failClosed(errors);
    if (!Object.hasOwn(authorizations, requestedScope)) {
      failClosed([`authorization scope is not registered: ${requestedScope}.`]);
    }
    return canonicalAuthorization(authorizations[requestedScope]);
  }
  const errors = validateScopedRealDataAuthorization(authorization, { canonicalActionIds });
  if (errors.length > 0) failClosed(errors);
  if (authorization.scope !== requestedScope) {
    failClosed(['authorization scope mismatch.']);
  }
  return canonicalAuthorization(authorization);
}

function canonicalAuthorization(authorization) {
  const databasePath = canonicalAbsolutePath(authorization.database_path);
  const originalDatabasePath = canonicalAbsolutePath(authorization.original_memory_database.path);
  if (!databasePath || !originalDatabasePath) {
    failClosed(['authorization database path cannot be resolved safely.']);
  }
  return Object.freeze({
    ...authorization,
    allowed_operations: Object.freeze([...authorization.allowed_operations]),
    active_action_ids: Object.freeze([...authorization.active_action_ids]),
    database_path: databasePath,
    original_memory_database: Object.freeze({
      ...authorization.original_memory_database,
      path: originalDatabasePath
    })
  });
}

function assertExactDatabasePath({ authorization, databasePath }) {
  const requestedPath = canonicalAbsolutePath(databasePath);
  const authorizedPath = canonicalAbsolutePath(authorization.database_path);
  const originalPath = canonicalAbsolutePath(authorization.original_memory_database.path);
  if (!requestedPath) {
    failClosed(['database path must be a normalized absolute path.']);
  }
  if (requestedPath === originalPath) {
    failClosed(['original memory database is read-only.']);
  }
  if (requestedPath !== authorizedPath) {
    failClosed(['database path mismatch.']);
  }
  return requestedPath;
}

export function assertScopedRealDataOperation({
  authorization,
  scope,
  databasePath,
  ownerSource,
  operation,
  actionId
}) {
  const errors = validateScopedRealDataAuthorization(authorization, {
    canonicalActionIds: nonEmptyString(actionId) ? [actionId] : []
  });
  if (errors.length > 0) throw new Error(`SCOPED_REAL_DATA_FAIL_CLOSED: ${errors.join(' ')}`);
  if (scope !== authorization.scope) {
    throw new Error('SCOPED_REAL_DATA_FAIL_CLOSED: authorization scope mismatch.');
  }
  const canonicalDatabasePath = assertExactDatabasePath({ authorization, databasePath });
  if (ownerSource !== authorization.owner_source) {
    throw new Error('SCOPED_REAL_DATA_FAIL_CLOSED: owner must come from the authenticated session.');
  }
  if (!authorization.allowed_operations.includes(operation)) {
    throw new Error(`SCOPED_REAL_DATA_FAIL_CLOSED: operation is not authorized: ${operation}.`);
  }
  if (!authorization.active_action_ids.includes(actionId)) {
    throw new Error('SCOPED_REAL_DATA_FAIL_CLOSED: authorization is inactive for this action.');
  }
  return Object.freeze({
    scope: authorization.scope,
    databasePath: canonicalDatabasePath,
    ownerSource: authorization.owner_source,
    operation,
    actionId
  });
}

export function assertScopedRealDataDatabaseLocation({
  authorization,
  scope,
  databasePath,
  ownerSource,
  actionId
}) {
  const errors = validateScopedRealDataAuthorization(authorization, {
    canonicalActionIds: nonEmptyString(actionId) ? [actionId] : []
  });
  if (errors.length > 0) throw new Error(`SCOPED_REAL_DATA_FAIL_CLOSED: ${errors.join(' ')}`);
  if (scope !== authorization.scope) {
    throw new Error('SCOPED_REAL_DATA_FAIL_CLOSED: authorization scope mismatch.');
  }
  const canonicalDatabasePath = assertExactDatabasePath({ authorization, databasePath });
  if (ownerSource !== authorization.owner_source) {
    throw new Error('SCOPED_REAL_DATA_FAIL_CLOSED: owner must come from the authenticated session.');
  }
  return Object.freeze({
    scope: authorization.scope,
    databasePath: canonicalDatabasePath,
    ownerSource: authorization.owner_source,
    actionId
  });
}
