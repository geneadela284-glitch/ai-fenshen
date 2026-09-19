export const PERSISTENCE_CONTRACT_VERSION = 'v1';

export const CAPABILITY_STAGE = Object.freeze({
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  FUTURE: 'future'
});

export const PERSISTENCE_CAPABILITY_MATRIX = Object.freeze({
  transactions: CAPABILITY_STAGE.REQUIRED,
  optimisticConcurrency: CAPABILITY_STAGE.REQUIRED,
  batchAtomicity: CAPABILITY_STAGE.REQUIRED,
  cursorPagination: CAPABILITY_STAGE.REQUIRED,
  healthCheck: CAPABILITY_STAGE.REQUIRED,
  integrityCheck: CAPABILITY_STAGE.REQUIRED,
  snapshots: CAPABILITY_STAGE.OPTIONAL,
  backup: CAPABILITY_STAGE.OPTIONAL,
  restore: CAPABILITY_STAGE.OPTIONAL,
  checkpoints: CAPABILITY_STAGE.OPTIONAL,
  encryptionAtRest: CAPABILITY_STAGE.OPTIONAL,
  fullTextSearch: CAPABILITY_STAGE.FUTURE,
  vectorSearch: CAPABILITY_STAGE.FUTURE,
  sync: CAPABILITY_STAGE.FUTURE
});

export const PERSISTENCE_ADAPTER_METHODS = Object.freeze([
  'open', 'close', 'read', 'readMany', 'scan', 'insert', 'update', 'delete',
  'beginTransaction', 'commit', 'rollback', 'createSnapshot', 'createBackup',
  'restore', 'healthCheck', 'integrityCheck', 'createCheckpoint'
]);

function contract(name, fields) {
  return Object.freeze({ name, contractVersion: PERSISTENCE_CONTRACT_VERSION, fields: Object.freeze(fields) });
}

export const PersistenceAdapter = Object.freeze({
  name: 'PersistenceAdapter',
  contractVersion: PERSISTENCE_CONTRACT_VERSION,
  requiredProperties: Object.freeze(['capabilities']),
  requiredMethods: PERSISTENCE_ADAPTER_METHODS
});

export const PersistenceCapabilities = contract('PersistenceCapabilities', [
  'adapterId', 'adapterType', 'contractVersion', 'features'
]);
export const PersistenceTransaction = contract('PersistenceTransaction', [
  'id', 'state', 'startedAt', 'completedAt', 'metadata'
]);
export const PersistenceSnapshot = contract('PersistenceSnapshot', [
  'id', 'createdAt', 'recordCount', 'checksum', 'checkpointId', 'metadata'
]);
export const PersistenceBackup = contract('PersistenceBackup', [
  'id', 'createdAt', 'recordCount', 'checksum', 'format', 'encrypted', 'handle', 'metadata'
]);
export const PersistenceRestore = contract('PersistenceRestore', [
  'id', 'backupId', 'status', 'startedAt', 'completedAt', 'restoredCount', 'checksum', 'metadata'
]);
export const PersistenceHealth = contract('PersistenceHealth', [
  'status', 'checkedAt', 'latencyMs', 'details'
]);
export const PersistenceIntegrity = contract('PersistenceIntegrity', [
  'status', 'checkedAt', 'recordCount', 'checksum', 'issues'
]);
export const PersistenceCheckpoint = contract('PersistenceCheckpoint', [
  'id', 'createdAt', 'recordCount', 'checksum', 'metadata'
]);

function issue(path, code, message) {
  return Object.freeze({ path, code, message });
}

function result(errors) {
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function validatePersistenceCapabilities(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result([issue('', 'PERSISTENCE_INVALID_CONTRACT', 'Capabilities must be an object.')]);
  }
  for (const field of PersistenceCapabilities.fields) {
    if (!(field in value)) errors.push(issue(field, 'PERSISTENCE_INVALID_CONTRACT', `${field} is required.`));
  }
  for (const field of Object.keys(value)) {
    if (!PersistenceCapabilities.fields.includes(field)) errors.push(issue(field, 'PERSISTENCE_INVALID_CONTRACT', 'Unknown capability field.'));
  }
  if (value.contractVersion !== PERSISTENCE_CONTRACT_VERSION) {
    errors.push(issue('contractVersion', 'PERSISTENCE_INVALID_CONTRACT', 'Unsupported persistence contract version.'));
  }
  for (const field of ['adapterId', 'adapterType']) {
    if (typeof value[field] !== 'string' || !value[field].trim()) errors.push(issue(field, 'PERSISTENCE_INVALID_CONTRACT', `${field} is required.`));
  }
  if (!value.features || typeof value.features !== 'object' || Array.isArray(value.features)) {
    errors.push(issue('features', 'PERSISTENCE_INVALID_CONTRACT', 'features must be an object.'));
  } else {
    for (const feature of Object.keys(PERSISTENCE_CAPABILITY_MATRIX)) {
      if (typeof value.features[feature] !== 'boolean') errors.push(issue(`features.${feature}`, 'PERSISTENCE_INVALID_CONTRACT', 'Feature flag must be boolean.'));
    }
    for (const feature of Object.keys(value.features)) {
      if (!(feature in PERSISTENCE_CAPABILITY_MATRIX)) errors.push(issue(`features.${feature}`, 'PERSISTENCE_INVALID_CONTRACT', 'Unknown persistence feature.'));
    }
  }
  return result(errors);
}

export function validateProductionPersistenceCapabilities(value) {
  const validation = validatePersistenceCapabilities(value);
  const errors = [...validation.errors];
  if (validation.valid) {
    for (const [feature, stage] of Object.entries(PERSISTENCE_CAPABILITY_MATRIX)) {
      if (stage === CAPABILITY_STAGE.REQUIRED && value.features[feature] !== true) {
        errors.push(issue(`features.${feature}`, 'PERSISTENCE_CAPABILITY_REQUIRED', 'Required persistence capability is disabled.'));
      }
    }
  }
  return result(errors);
}

export function validatePersistenceAdapter(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return result([issue('', 'PERSISTENCE_INVALID_CONTRACT', 'PersistenceAdapter must be an object.')]);
  }
  errors.push(...validatePersistenceCapabilities(value.capabilities).errors);
  for (const method of PERSISTENCE_ADAPTER_METHODS) {
    if (typeof value[method] !== 'function') errors.push(issue(method, 'PERSISTENCE_INTERFACE_METHOD_MISSING', `${method}() is required.`));
  }
  return result(errors);
}
