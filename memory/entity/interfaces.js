function port(name, requiredMethods) {
  return Object.freeze({
    name,
    contractVersion: 'v2',
    requiredMethods: Object.freeze([...requiredMethods])
  });
}

function issue(path, code, message) {
  return Object.freeze({ path, code, message });
}

function validatePort(value, contract) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(issue('', 'INVALID_TYPE', `${contract.name} must be an object.`));
  } else {
    for (const method of contract.requiredMethods) {
      if (typeof value[method] !== 'function') {
        errors.push(issue(method, 'INTERFACE_METHOD_MISSING', `${method}() is required.`));
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}

export const EntityRepository = port('EntityRepository', [
  'getById',
  'query',
  'findByAlias',
  'findRelations',
  'createEntity',
  'updateEntity',
  'addAlias',
  'updateAlias',
  'createRelation',
  'endRelation'
]);

export const MemoryUnitOfWork = port('MemoryUnitOfWork', ['run']);
export const MemoryRecordV2ReadRepository = port('MemoryRecordV2ReadRepository', [
  'queryByEntityAndPredicate'
]);
export const MemoryRecordV2PresenceRepository = port('MemoryRecordV2PresenceRepository', [
  'inspectPresenceByEntityAndPredicate'
]);
export const MemoryRecordV2LifecycleRepository = port('MemoryRecordV2LifecycleRepository', [
  'getById',
  'listByEntityAndPredicateForLifecycle',
  'transition',
  'purgeChain'
]);
export const LegacyReadAdapter = port('LegacyReadAdapter', ['query']);

export const ShadowDatabasePlan = Object.freeze({
  name: 'ShadowDatabasePlan',
  contractVersion: 'v2',
  requiredFields: Object.freeze([
    'planId',
    'sourceDatabasePath',
    'shadowDatabasePath',
    'sourceChecksum',
    'targetSchemaVersion',
    'migrationId',
    'createdAt',
    'status'
  ]),
  unknownFieldPolicy: 'reject'
});

export function validateEntityRepositoryInterface(value) {
  return validatePort(value, EntityRepository);
}

export function validateMemoryUnitOfWorkInterface(value) {
  return validatePort(value, MemoryUnitOfWork);
}

export function validateMemoryRecordV2ReadRepositoryInterface(value) {
  return validatePort(value, MemoryRecordV2ReadRepository);
}

export function validateMemoryRecordV2PresenceRepositoryInterface(value) {
  return validatePort(value, MemoryRecordV2PresenceRepository);
}

export function validateMemoryRecordV2LifecycleRepositoryInterface(value) {
  return validatePort(value, MemoryRecordV2LifecycleRepository);
}

export function validateLegacyReadAdapterInterface(value) {
  return validatePort(value, LegacyReadAdapter);
}

export function validateShadowDatabasePlanInterface(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: [issue('', 'INVALID_TYPE', 'ShadowDatabasePlan must be an object.')], warnings: [] };
  }
  for (const field of ShadowDatabasePlan.requiredFields) {
    if (!(field in value) || value[field] === undefined) {
      errors.push(issue(field, 'REQUIRED', `${field} is required.`));
    }
  }
  for (const field of Object.keys(value)) {
    if (!ShadowDatabasePlan.requiredFields.includes(field)) {
      errors.push(issue(field, 'UNKNOWN_FIELD', `Unknown field: ${field}`));
    }
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}
