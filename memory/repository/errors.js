const SAFE_MESSAGES = Object.freeze({
  MEMORY_EXPECTED_VERSION_REQUIRED: 'Expected version is required.',
  MEMORY_VERSION_CONFLICT: 'Memory version conflict.',
  MEMORY_RECORD_NOT_FOUND: 'Memory record not found.',
  MEMORY_TRANSACTION_FAILED: 'Memory transaction failed.',
  MEMORY_NESTED_TRANSACTION_UNSUPPORTED: 'Nested Memory transactions are not supported.',
  MEMORY_BATCH_ATOMICITY_FAILED: 'Memory batch failed atomically.',
  MEMORY_IDEMPOTENCY_CONFLICT: 'Memory idempotency key conflicts with another request.',
  INVARIANT_VIOLATION: 'Memory operation violates repository invariants.',
  INVALID_TRANSITION: 'Memory status transition is invalid.',
  USER_SCOPE_MISMATCH: 'Memory user scope is invalid.',
  USER_SCOPE_REQUIRED: 'Memory user scope is required.',
  SECRET_FORBIDDEN: 'Memory operation contains forbidden secret fields.',
  REQUIRED: 'Memory operation is missing a required field.',
  INVALID_TYPE: 'Memory operation contains an invalid value.',
  INVALID_ENUM: 'Memory operation contains an invalid enum value.',
  INVALID_DATE: 'Memory operation contains an invalid date.',
  INVALID_RANGE: 'Memory operation exceeds an allowed range.',
  UNKNOWN_FIELD: 'Memory operation contains an unknown field.'
});

export class MemoryRepositoryError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.INVARIANT_VIOLATION);
    this.name = 'MemoryRepositoryError';
    this.code = SAFE_MESSAGES[code] ? code : 'INVARIANT_VIOLATION';
  }
}

export function repositoryError(code) {
  return new MemoryRepositoryError(code);
}
