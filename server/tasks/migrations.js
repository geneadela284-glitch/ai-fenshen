export function applyTasksMigrations(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks_schema_versions (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      scheduled_at TEXT NOT NULL,
      timezone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'cancelled')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_user_scheduled
      ON tasks(user_id, scheduled_at ASC);
    CREATE INDEX IF NOT EXISTS idx_tasks_user_status_scheduled
      ON tasks(user_id, status, scheduled_at ASC);
  `);
  database.prepare(`
    INSERT OR IGNORE INTO tasks_schema_versions (version, applied_at) VALUES (1, ?)
  `).run(new Date().toISOString());
}
