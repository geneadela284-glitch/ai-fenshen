export const MEMORY_SPEC_VERSION = '1.0.0';

export const SPEC_LEVELS = Object.freeze(['MUST', 'MUST_NOT', 'SHOULD', 'SHOULD_NOT', 'MAY']);
export const SPEC_PROFILES = Object.freeze(['K', 'R', 'P']);
export const SPEC_STATUSES = Object.freeze(['implemented', 'partially_implemented', 'not_implemented', 'future']);

const KERNEL = Object.freeze(['memory/kernel/index.js']);
const KERNEL_SCHEMA = Object.freeze(['memory/kernel/schemas.js', 'memory/kernel/validation.js']);
const KERNEL_INVARIANTS = Object.freeze(['memory/kernel/invariants.js', 'memory/kernel/validation.js']);
const KERNEL_TESTS = Object.freeze(['memory/kernel/contracts.test.js', 'memory/kernel/validation.test.js', 'memory/kernel/invariantsInterfaces.test.js']);
const REPOSITORY = Object.freeze(['memory/repository/inMemoryRepository.js', 'memory/repository/contracts.js']);
const REPOSITORY_TESTS = Object.freeze(['memory/repository/conformance.test.js', 'memory/repository/repository.test.js']);
const PERSISTENCE = Object.freeze(['memory/persistence/contracts.js', 'memory/persistence/errors.js']);
const PERSISTENCE_FAKE = Object.freeze(['memory/persistence/fakePersistenceAdapter.js']);
const PERSISTENCE_TESTS = Object.freeze(['memory/persistence/persistence.test.js', 'memory/persistence/conformance.test.js']);
const SQLITE_PERSISTENCE = Object.freeze([
  'memory/persistence/sqlite/migrationRunner.js',
  'memory/persistence/sqlite/sqlitePersistenceAdapter.js',
  'memory/persistence/sqlite/sqliteAdapterSupport.js',
  'memory/repository/persistenceMemoryRepository.js'
]);
const SQLITE_PERSISTENCE_TESTS = Object.freeze([
  'memory/persistence/sqlite/sqliteMigration.test.js',
  'memory/persistence/sqlite/sqliteConformance.test.js',
  'memory/persistence/sqlite/sqlitePersistence.test.js',
  'memory/repository/sqliteConformance.test.js'
]);
const SPEC_TEST = Object.freeze(['memory/spec/memory-spec-v1.test.js']);

function rule(ruleId, level, category, description, profile, status, implementedBy, testedBy, targetStage) {
  return Object.freeze({
    specVersion: MEMORY_SPEC_VERSION,
    ruleId,
    level,
    category,
    description,
    implementedBy: Object.freeze([...implementedBy]),
    testedBy: Object.freeze([...testedBy]),
    status,
    profile,
    targetStage
  });
}

export const MEMORY_SPEC_RULES_V1 = Object.freeze([
  rule('MEMV1-K-001', 'MUST', 'record', 'MemoryRecord MUST use the approved v1 field contract.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-002', 'MUST', 'ownership', 'Every formal MemoryRecord MUST contain a non-empty userId.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-003', 'MUST', 'ownership', 'MemoryRecord userId MUST match the trusted user context.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-004', 'MUST', 'source', 'Every formal MemoryRecord MUST contain a valid source type and source id.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-005', 'MUST', 'temporal', 'Every formal MemoryRecord MUST contain source and technical timestamps.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-006', 'MUST', 'temporal', 'Every formal MemoryRecord MUST contain an effective time range.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-007', 'MUST', 'compatibility', 'Every MemoryRecord MUST declare schemaVersion v1.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-008', 'MUST_NOT', 'compatibility', 'Kernel validation MUST NOT accept unknown fields or unsupported schema versions.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-009', 'MUST', 'lifecycle', 'Memory status MUST use the approved eight-value enumeration.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-010', 'MUST', 'confirmation', 'Memory confirmationStatus MUST use the approved five-value enumeration.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-011', 'MUST', 'sensitivity', 'Memory sensitivity MUST use public, low, medium, high, or restricted.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-012', 'MUST', 'trust', 'Memory confidence MUST be a number from zero through one.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-013', 'MUST', 'importance', 'Memory importance MUST be a number from zero through one and remain independent from confidence.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-014', 'MUST_NOT', 'trust', 'A model-inferred source MUST NOT directly produce confirmed Memory.', 'K', 'implemented', KERNEL_INVARIANTS, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-015', 'MUST_NOT', 'confirmation', 'A pending Candidate MUST NOT be represented as a confirmed fact.', 'K', 'implemented', KERNEL_INVARIANTS, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-016', 'MUST', 'sensitivity', 'High-sensitivity confirmed Memory MUST have user confirmation.', 'K', 'implemented', KERNEL_INVARIANTS, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-017', 'MUST_NOT', 'sensitivity', 'Prohibited secret fields MUST NOT pass Kernel validation.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-018', 'MUST', 'traceability', 'Formal Memory MUST retain source, time, schema, and record version.', 'K', 'implemented', KERNEL_INVARIANTS, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-019', 'MUST_NOT', 'versioning', 'A changed fact MUST NOT silently overwrite its history.', 'K', 'implemented', KERNEL_INVARIANTS, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-020', 'MUST_NOT', 'temporal', 'effectiveTo MUST NOT be earlier than effectiveFrom.', 'K', 'implemented', KERNEL_SCHEMA, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-021', 'MUST_NOT', 'retrieval', 'Deleted or superseded Memory MUST NOT be treated as current or recallable.', 'K', 'implemented', KERNEL_INVARIANTS, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-022', 'MUST_NOT', 'architecture', 'Memory Kernel MUST NOT depend on SQLite, Persistence Adapter, or another storage implementation.', 'K', 'implemented', KERNEL, KERNEL_TESTS, 'M1'),
  rule('MEMV1-K-023', 'MUST_NOT', 'provider', 'Memory contracts and ownership MUST NOT depend on a Provider or model.', 'K', 'implemented', KERNEL, KERNEL_TESTS, 'M1'),

  rule('MEMV1-R-001', 'MUST', 'context', 'RepositoryContext authenticatedUserId MUST originate from trusted server-side authentication context and include trusted actor metadata.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-002', 'MUST_NOT', 'audit', 'RepositoryContext metadata MUST NOT contain secrets or complete sensitive bodies.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-003', 'MUST', 'ownership', 'Repository create operations MUST require record userId to equal authenticatedUserId.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-004', 'MUST', 'ownership', 'Every Repository read MUST be constrained to authenticatedUserId.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-005', 'MUST', 'ownership', 'Every Repository write, state change, delete, and version operation MUST be constrained to authenticatedUserId.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-006', 'MUST', 'ownership', 'Cross-user access MUST fail closed with MEMORY_RECORD_NOT_FOUND without existence disclosure.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-007', 'MUST_NOT', 'ownership', 'An administrator MUST NOT read an ordinary user complete Memory body by default.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-008', 'MUST', 'validation', 'Repository creation and mutation MUST pass Kernel validation and invariants.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-009', 'MUST', 'versioning', 'A newly created MemoryRecord MUST start at version one.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-010', 'MUST', 'idempotency', 'Create and supported mutation retries MUST accept a technical idempotencyKey.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-011', 'MUST', 'idempotency', 'The same user, operation, payload, and idempotencyKey MUST return the same result without repeating the mutation.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-012', 'MUST', 'idempotency', 'Idempotency scope MUST include user ownership and operation.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-013', 'MUST_NOT', 'idempotency', 'Equal text MUST NOT be treated as technical duplication without an idempotency key.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-014', 'MUST', 'concurrency', 'Every mutation of an existing MemoryRecord MUST provide expectedVersion.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-015', 'MUST_NOT', 'concurrency', 'A version conflict MUST reject the mutation and MUST NOT use last-write-wins.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-016', 'MUST', 'concurrency', 'Each successful existing-record mutation MUST increment version exactly once.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-017', 'MUST', 'transaction', 'Repository transactions MUST commit completely or roll back completely.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-018', 'MUST', 'transaction', 'Batch creation MUST be atomic and leave zero writes when any member fails.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-019', 'MUST', 'transaction', 'Unsupported nested transactions MUST fail explicitly.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-020', 'MUST', 'versioning', 'Supersede MUST atomically create bidirectional supersedes and supersededBy links.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-021', 'MUST_NOT', 'versioning', 'Supersede MUST NOT allow self-supersede, repeat supersede, or partial chains.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-022', 'MUST', 'query', 'Default Repository query MUST exclude deleted, expired, superseded, user-rejected, disputed, archived, and unconfirmed Candidate records.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-023', 'MUST', 'query', 'Historical records and Candidates MUST require explicit query flags.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-024', 'MUST_NOT', 'query', 'Cursor pagination MUST be stable and MUST NOT expose record content or identifiers.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-025', 'MUST_NOT', 'encapsulation', 'Returned objects MUST NOT expose mutable Repository internal state.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-026', 'MUST', 'deletion', 'Recycle-bin deletion MUST stop normal recall immediately and MAY allow restore for seven days.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-027', 'MUST', 'deletion', 'Permanent purge MUST remove the body and make restore impossible.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-028', 'MUST', 'deletion', 'A captured prohibited secret MUST be purged immediately without entering the recycle bin.', 'R', 'partially_implemented', Object.freeze(['memory/repository/inMemoryRepository.js', 'memory/kernel/validation.js']), REPOSITORY_TESTS, 'M3'),
  rule('MEMV1-R-029', 'MUST_NOT', 'audit', 'Audit and idempotency diagnostics MUST NOT retain complete Memory bodies or prohibited secrets.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-030', 'MUST_NOT', 'authorization', 'Ordinary conversation MUST NOT default to formal long-term Memory writes.', 'R', 'not_implemented', [], SPEC_TEST, 'M3'),
  rule('MEMV1-R-031', 'MAY', 'authorization', 'An explicit user instruction to remember MAY enter the formal write pipeline for ordinary or low-sensitivity content.', 'R', 'not_implemented', [], SPEC_TEST, 'M3'),
  rule('MEMV1-R-032', 'MUST_NOT', 'authorization', 'System observation and model inference MUST NOT directly write confirmed Memory.', 'R', 'not_implemented', [], SPEC_TEST, 'M3'),
  rule('MEMV1-R-033', 'MUST', 'authorization', 'High-sensitivity write requests MUST receive additional explicit user confirmation.', 'R', 'not_implemented', [], SPEC_TEST, 'M3'),
  rule('MEMV1-R-034', 'MUST_NOT', 'architecture', 'Repository MUST NOT directly depend on SQLite or expose a Persistence Adapter to callers.', 'R', 'implemented', Object.freeze(['memory/repository/index.js']), REPOSITORY_TESTS, 'M2'),
  rule('MEMV1-R-035', 'SHOULD_NOT', 'audit', 'Audit SHOULD NOT store raw request identifiers when stable hashes satisfy diagnostics.', 'R', 'implemented', REPOSITORY, REPOSITORY_TESTS, 'M2'),

  rule('MEMV1-P-001', 'MUST', 'persistence', 'Every storage implementation MUST implement PersistenceAdapter contract v1.', 'P', 'implemented', PERSISTENCE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-002', 'MUST', 'capability', 'Persistence Adapter MUST declare every capability truthfully.', 'P', 'implemented', PERSISTENCE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-003', 'MUST', 'capability', 'A production Persistence Adapter MUST enable every required capability.', 'P', 'implemented', PERSISTENCE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-004', 'MUST', 'capability', 'An unsupported Persistence capability MUST fail closed.', 'P', 'implemented', Object.freeze(['memory/persistence/sqlitePersistenceAdapterSkeleton.js', 'memory/persistence/errors.js']), PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-005', 'MUST', 'persistence', 'Persistence operations MUST use the approved explicit method surface and lifecycle.', 'P', 'implemented', PERSISTENCE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-006', 'MUST', 'concurrency', 'Persistence update and delete MUST enforce expectedVersion.', 'P', 'implemented', PERSISTENCE_FAKE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-007', 'MUST_NOT', 'concurrency', 'Persistence version conflicts MUST NOT use last-write-wins.', 'P', 'implemented', PERSISTENCE_FAKE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-008', 'MUST', 'transaction', 'A Persistence transaction MUST read its own writes while hiding uncommitted writes externally.', 'P', 'implemented', PERSISTENCE_FAKE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-009', 'MUST', 'transaction', 'Persistence commit and rollback MUST be atomic.', 'P', 'implemented', PERSISTENCE_FAKE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-010', 'MUST_NOT', 'query', 'Persistence cursor pagination MUST be stable and MUST NOT contain stored keys or values.', 'P', 'implemented', PERSISTENCE_FAKE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-011', 'MUST_NOT', 'encapsulation', 'Persistence inputs and outputs MUST NOT expose mutable internal state.', 'P', 'implemented', PERSISTENCE_FAKE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-012', 'MUST', 'health', 'Persistence healthCheck MUST report structured availability without data bodies.', 'P', 'implemented', PERSISTENCE_FAKE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-013', 'MUST', 'integrity', 'Persistence integrityCheck MUST report deterministic record count, checksum, and issues.', 'P', 'implemented', PERSISTENCE_FAKE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-014', 'MUST_NOT', 'backup', 'Snapshot, checkpoint, and backup descriptors MUST NOT expose complete stored data.', 'P', 'implemented', PERSISTENCE_FAKE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-015', 'SHOULD', 'backup', 'Restore SHOULD return restored count and checksum for verification.', 'P', 'implemented', PERSISTENCE_FAKE, PERSISTENCE_TESTS, 'M2.1'),
  rule('MEMV1-P-016', 'MUST_NOT', 'compatibility', 'Corrupt or unknown higher-version storage MUST NOT be silently overwritten.', 'P', 'implemented', SQLITE_PERSISTENCE, SQLITE_PERSISTENCE_TESTS, 'M2.2'),
  rule('MEMV1-P-017', 'MUST', 'integrity', 'A corrupted store MUST fail closed or enter an explicit read-only recovery state.', 'P', 'implemented', SQLITE_PERSISTENCE, SQLITE_PERSISTENCE_TESTS, 'M2.2'),
  rule('MEMV1-P-018', 'MUST', 'sql', 'Every SQL implementation MUST use parameterized inputs for values and validated identifiers.', 'P', 'implemented', SQLITE_PERSISTENCE, SQLITE_PERSISTENCE_TESTS, 'M2.2'),
  rule('MEMV1-P-019', 'MUST_NOT', 'architecture', 'A Persistence Adapter MUST NOT bypass Kernel validation or Repository user isolation.', 'P', 'implemented', SQLITE_PERSISTENCE, SQLITE_PERSISTENCE_TESTS, 'M2.2'),
  rule('MEMV1-P-020', 'MUST', 'migration', 'Migration MUST be dry-run capable, source-preserving, atomic by batch, validated, and reversible.', 'P', 'future', [], SPEC_TEST, 'Migration'),
  rule('MEMV1-P-021', 'MUST_NOT', 'migration', 'Migration MUST NOT convert all historical conversation into confirmed Memory.', 'P', 'future', [], SPEC_TEST, 'Migration'),
  rule('MEMV1-P-022', 'MUST', 'sync', 'Sync MUST preserve user ownership, record versions, deletion tombstones, and conflict evidence.', 'P', 'future', [], SPEC_TEST, 'Sync'),
  rule('MEMV1-P-023', 'MUST_NOT', 'sync', 'Sync conflicts MUST NOT use silent last-write-wins for Memory facts.', 'P', 'future', [], SPEC_TEST, 'Sync'),
  rule('MEMV1-P-024', 'SHOULD', 'sync', 'Non-overlapping Sync changes SHOULD merge only when ownership and common-base validation succeed.', 'P', 'future', [], SPEC_TEST, 'Sync'),
  rule('MEMV1-P-025', 'MAY', 'deployment', 'Cloud, PostgreSQL, IndexedDB, NAS, and future adapters MAY implement this contract without changing Memory ownership or format.', 'P', 'future', [], SPEC_TEST, 'Future Adapter'),
  rule('MEMV1-P-026', 'MUST_NOT', 'provider', 'Changing Provider or model MUST NOT change Memory format, ownership, or persistence semantics.', 'P', 'implemented', Object.freeze(['memory/kernel/index.js', 'memory/persistence/contracts.js']), SPEC_TEST, 'M2.1')
]);
