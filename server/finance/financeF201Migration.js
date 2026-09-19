const TARGET_SCHEMA_VERSION = 2;

const V1_ENTRY_COLUMNS = Object.freeze([
  'id', 'owner_id', 'type', 'amount_minor', 'currency', 'occurred_at', 'timezone',
  'category', 'merchant', 'counterparty', 'note', 'source_message_id',
  'client_request_id', 'status', 'created_at', 'updated_at', 'deleted_at'
]);

const V1_INDEXES = Object.freeze([
  'idx_finance_owner_occurred',
  'idx_finance_owner_status_category',
  'uq_finance_owner_client_request'
]);

const V2_TABLE_COLUMNS = Object.freeze({
  finance_accounts: Object.freeze([
    'id', 'owner_id', 'name', 'account_type', 'currency', 'status', 'is_system',
    'created_at', 'updated_at', 'archived_at'
  ]),
  finance_revisions: Object.freeze([
    'id', 'owner_id', 'entry_id', 'entry_version', 'mutation_type', 'before_json',
    'after_json', 'client_request_id', 'created_at'
  ]),
  finance_mutation_requests: Object.freeze([
    'owner_id', 'client_request_id', 'mutation_type', 'target_entry_id',
    'request_fingerprint', 'status', 'result_json', 'created_at', 'completed_at'
  ])
});

const V2_INDEXES = Object.freeze([
  'idx_finance_accounts_owner_status',
  'idx_finance_mutation_requests_entry',
  'idx_finance_revisions_owner_entry'
]);

const V2_MIGRATION_SQL = `
  CREATE TABLE finance_accounts (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    account_type TEXT NOT NULL CHECK (
      account_type IN ('historical', 'cash', 'bank', 'credit', 'wallet', 'other')
    ),
    currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE INDEX idx_finance_accounts_owner_status
    ON finance_accounts(owner_id, status, created_at, id);

  ALTER TABLE finance_entries
    ADD COLUMN account_id TEXT REFERENCES finance_accounts(id) ON DELETE RESTRICT;
  ALTER TABLE finance_entries
    ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
  ALTER TABLE finance_entries
    ADD COLUMN archived_at TEXT;

  CREATE TABLE finance_revisions (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    entry_version INTEGER NOT NULL CHECK (entry_version >= 2),
    mutation_type TEXT NOT NULL CHECK (
      mutation_type IN ('update', 'delete', 'restore', 'archive')
    ),
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(entry_id, entry_version),
    FOREIGN KEY(entry_id) REFERENCES finance_entries(id) ON DELETE RESTRICT
  );
  CREATE INDEX idx_finance_revisions_owner_entry
    ON finance_revisions(owner_id, entry_id, entry_version DESC);

  CREATE TABLE finance_mutation_requests (
    owner_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    mutation_type TEXT NOT NULL CHECK (
      mutation_type IN ('update', 'delete', 'restore', 'archive')
    ),
    target_entry_id TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'committed', 'failed')),
    result_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY(owner_id, client_request_id),
    FOREIGN KEY(target_entry_id) REFERENCES finance_entries(id) ON DELETE RESTRICT
  );
  CREATE INDEX idx_finance_mutation_requests_entry
    ON finance_mutation_requests(owner_id, target_entry_id, created_at);
`;

function v2SchemaErrors(database) {
  const errors = [];
  for (const [table, expectedColumns] of Object.entries(V2_TABLE_COLUMNS)) {
    const exists = database.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?
    `).get(table);
    if (!exists) {
      errors.push(`missing_table:${table}`);
      continue;
    }
    const actualColumns = database.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
      errors.push(`column_drift:${table}`);
    }
  }

  const entryColumns = database.prepare('PRAGMA table_info(finance_entries)').all();
  const entryColumnNames = entryColumns.map((row) => row.name);
  if (JSON.stringify(entryColumnNames) !== JSON.stringify([
    ...V1_ENTRY_COLUMNS,
    'account_id',
    'version',
    'archived_at'
  ])) {
    errors.push('column_drift:finance_entries');
  }
  const entryTail = entryColumns.slice(-3).map(({ name, notnull, dflt_value: defaultValue }) => ({
    name,
    notnull,
    defaultValue
  }));
  const expectedEntryTail = [
    { name: 'account_id', notnull: 0, defaultValue: null },
    { name: 'version', notnull: 1, defaultValue: '1' },
    { name: 'archived_at', notnull: 0, defaultValue: null }
  ];
  if (JSON.stringify(entryTail) !== JSON.stringify(expectedEntryTail)) {
    errors.push('column_drift:finance_entries');
  }

  for (const index of V2_INDEXES) {
    const exists = database.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'index' AND name = ?
    `).get(index);
    if (!exists) errors.push(`missing_index:${index}`);
  }

  const entryAccountForeignKey = database.prepare('PRAGMA foreign_key_list(finance_entries)').all()
    .some((row) => row.table === 'finance_accounts' && row.from === 'account_id' && row.to === 'id');
  if (!entryAccountForeignKey) errors.push('foreign_key_drift:finance_entries.account_id');
  for (const [table, from] of [
    ['finance_revisions', 'entry_id'],
    ['finance_mutation_requests', 'target_entry_id']
  ]) {
    const valid = database.prepare(`PRAGMA foreign_key_list(${table})`).all()
      .some((row) => row.table === 'finance_entries' && row.from === from && row.to === 'id');
    if (!valid) errors.push(`foreign_key_drift:${table}.${from}`);
  }

  const versions = database.prepare('SELECT version FROM finance_schema_versions ORDER BY version').all()
    .map((row) => Number(row.version));
  if (JSON.stringify(versions) !== JSON.stringify([1, TARGET_SCHEMA_VERSION])) {
    errors.push('version_history_drift');
  }
  return errors;
}

function assertV2Schema(database) {
  const errors = v2SchemaErrors(database);
  if (errors.length === 0) return;
  throw Object.assign(new Error(`Finance F2.0-1 schema drift: ${errors.join(', ')}`), {
    code: 'FINANCE_F2_0_1_MIGRATION_DRIFT',
    details: errors
  });
}

function assertV1Schema(database) {
  const tables = new Set(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('finance_schema_versions', 'finance_entries')
  `).all().map((row) => row.name));
  if (!tables.has('finance_schema_versions') || !tables.has('finance_entries')) {
    throw Object.assign(new Error('Finance V1 schema is required before F2.0-1 Migration.'), {
      code: 'FINANCE_F2_0_1_BASE_SCHEMA_REQUIRED'
    });
  }
  const entryColumns = database.prepare('PRAGMA table_info(finance_entries)').all().map((row) => row.name);
  const schemaVersionColumns = database.prepare('PRAGMA table_info(finance_schema_versions)').all().map((row) => row.name);
  const indexes = new Set(database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'index'
  `).all().map((row) => row.name));
  const valid = JSON.stringify(entryColumns) === JSON.stringify(V1_ENTRY_COLUMNS) &&
    JSON.stringify(schemaVersionColumns) === JSON.stringify(['version', 'applied_at']) &&
    V1_INDEXES.every((index) => indexes.has(index));
  if (!valid) {
    throw Object.assign(new Error('Finance V1 schema is incomplete or incompatible.'), {
      code: 'FINANCE_F2_0_1_BASE_SCHEMA_INVALID'
    });
  }
}

export function applyFinanceF201Migration(database, { clock = () => new Date() } = {}) {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('BEGIN IMMEDIATE');
  try {
    const schemaVersionTable = database.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'finance_schema_versions'
    `).get();
    if (!schemaVersionTable) {
      throw Object.assign(new Error('Finance V1 schema is required before F2.0-1 Migration.'), {
        code: 'FINANCE_F2_0_1_BASE_SCHEMA_REQUIRED'
      });
    }
    const row = database.prepare('SELECT MAX(version) AS version FROM finance_schema_versions').get();
    const currentVersion = Number(row?.version);
    if (currentVersion === TARGET_SCHEMA_VERSION) {
      assertV2Schema(database);
      database.exec('COMMIT');
      return { version: TARGET_SCHEMA_VERSION, applied: false };
    }
    if (currentVersion !== 1) {
      throw Object.assign(new Error('Finance V1 schema is required before F2.0-1 Migration.'), {
        code: 'FINANCE_F2_0_1_BASE_SCHEMA_REQUIRED'
      });
    }
    assertV1Schema(database);
    database.exec(V2_MIGRATION_SQL);
    database.prepare(`
      INSERT INTO finance_schema_versions (version, applied_at) VALUES (?, ?)
    `).run(TARGET_SCHEMA_VERSION, clock().toISOString());
    assertV2Schema(database);
    database.exec('COMMIT');
    return { version: TARGET_SCHEMA_VERSION, applied: true };
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch {}
    throw error;
  }
}
