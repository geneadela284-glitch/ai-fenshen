const SAFE_MESSAGES = Object.freeze({
  PERSISTENCE_ADAPTER_NOT_IMPLEMENTED: 'Persistence adapter is not implemented.',
  PERSISTENCE_INVALID_CONTRACT: 'Persistence contract is invalid.',
  PERSISTENCE_CAPABILITY_REQUIRED: 'A required persistence capability is unavailable.',
  PERSISTENCE_CAPABILITY_UNSUPPORTED: 'Persistence capability is unsupported.',
  PERSISTENCE_NOT_OPEN: 'Persistence adapter is not open.',
  PERSISTENCE_RECORD_NOT_FOUND: 'Persistence record was not found.',
  PERSISTENCE_RECORD_EXISTS: 'Persistence record already exists.',
  PERSISTENCE_EXPECTED_VERSION_REQUIRED: 'Expected persistence version is required.',
  PERSISTENCE_VERSION_CONFLICT: 'Persistence version conflict.',
  PERSISTENCE_TRANSACTION_STATE_INVALID: 'Persistence transaction state is invalid.',
  PERSISTENCE_NESTED_TRANSACTION_UNSUPPORTED: 'Nested persistence transactions are unsupported.',
  PERSISTENCE_BACKUP_NOT_FOUND: 'Persistence backup was not found.',
  PERSISTENCE_PATH_INVALID: 'Persistence path is invalid.',
  PERSISTENCE_SCHEMA_VERSION_UNSUPPORTED: 'Persistence schema version is unsupported.',
  PERSISTENCE_MIGRATION_CHECKSUM_MISMATCH: 'Persistence migration checksum does not match.',
  PERSISTENCE_MIGRATION_FAILED: 'Persistence migration failed.',
  PERSISTENCE_CORRUPT: 'Persistence storage is corrupt.',
  PERSISTENCE_LOCKED: 'Persistence storage is locked.',
  PERSISTENCE_READ_ONLY: 'Persistence storage is read-only.',
  PERSISTENCE_BACKUP_INVALID: 'Persistence backup is invalid.'
});

export class PersistenceError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.PERSISTENCE_INVALID_CONTRACT);
    this.name = 'PersistenceError';
    this.code = SAFE_MESSAGES[code] ? code : 'PERSISTENCE_INVALID_CONTRACT';
  }
}

export function persistenceError(code) {
  return new PersistenceError(code);
}
