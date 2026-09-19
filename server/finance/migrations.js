export function applyFinanceMigrations(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS finance_schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS finance_entries (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
      amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
      currency TEXT NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
      occurred_at TEXT NOT NULL,
      timezone TEXT NOT NULL,
      category TEXT NOT NULL,
      merchant TEXT,
      counterparty TEXT,
      note TEXT,
      source_message_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_owner_client_request
      ON finance_entries(owner_id, client_request_id);
    CREATE INDEX IF NOT EXISTS idx_finance_owner_occurred
      ON finance_entries(owner_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_finance_owner_status_category
      ON finance_entries(owner_id, status, category);
  `);
  database.prepare(`
    INSERT OR IGNORE INTO finance_schema_versions (version, applied_at) VALUES (1, ?)
  `).run(new Date().toISOString());
}
