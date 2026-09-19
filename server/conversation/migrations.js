import { createHash } from 'node:crypto';

const MIGRATION = Object.freeze({
  version: 1,
  name: 'owner_scoped_conversation_foundation',
  sql: `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pending', 'streaming', 'completed', 'stopped', 'error')),
      client_request_id TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_conversations_owner_updated
      ON conversations(owner_id, updated_at DESC);
    CREATE INDEX idx_messages_conversation_created
      ON messages(conversation_id, created_at ASC);
    CREATE UNIQUE INDEX uq_messages_user_client_request
      ON messages(conversation_id, client_request_id)
      WHERE role = 'user' AND client_request_id IS NOT NULL;
  `
});

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const conversationMigrations = Object.freeze([MIGRATION]);

export function applyConversationMigrations(database) {
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversation_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  for (const migration of conversationMigrations) {
    const digest = checksum(migration.sql);
    const applied = database.prepare('SELECT name, checksum FROM conversation_schema_migrations WHERE version = ?').get(migration.version);
    if (applied) {
      if (applied.name !== migration.name || applied.checksum !== digest) {
        const error = new Error('Conversation migration checksum mismatch.');
        error.code = 'CONVERSATION_MIGRATION_DRIFT';
        throw error;
      }
      continue;
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare(`
        INSERT INTO conversation_schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, digest, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return { version: conversationMigrations.at(-1)?.version || 0 };
}
