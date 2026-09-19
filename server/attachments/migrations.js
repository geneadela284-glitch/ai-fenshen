import { createHash } from 'node:crypto';

const MIGRATION_V1 = Object.freeze({
  version: 1,
  name: 'attachment_foundation_phase_a1',
  sql: `
    CREATE TABLE attachments (
      attachment_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT,
      message_id TEXT,
      original_filename TEXT NOT NULL,
      safe_filename TEXT NOT NULL,
      declared_mime_type TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      media_kind TEXT NOT NULL CHECK(media_kind = 'image'),
      byte_size INTEGER NOT NULL CHECK(byte_size > 0),
      width INTEGER NOT NULL CHECK(width > 0),
      height INTEGER NOT NULL CHECK(height > 0),
      checksum_sha256 TEXT NOT NULL,
      storage_reference TEXT,
      processing_state TEXT NOT NULL CHECK(processing_state IN (
        'uploading', 'uploaded', 'validating', 'ready_for_processing',
        'processing', 'rejected', 'failed', 'expired', 'deleted'
      )),
      parser_type TEXT,
      extracted_text_reference TEXT,
      structured_content_reference TEXT,
      client_request_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT,
      deleted_at TEXT,
      failure_code TEXT,
      UNIQUE(user_id, client_request_id, ordinal)
    );
    CREATE INDEX idx_attachments_owner_created
      ON attachments(user_id, created_at, attachment_id);
    CREATE INDEX idx_attachments_expiry
      ON attachments(processing_state, message_id, expires_at);

    CREATE TABLE attachment_upload_batches (
      user_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes >= 0),
      actual_bytes INTEGER NOT NULL CHECK(actual_bytes >= 0),
      status TEXT NOT NULL CHECK(status IN ('uploading', 'completed', 'failed')),
      failure_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, client_request_id)
    );

    CREATE TABLE attachment_daily_usage (
      user_id TEXT NOT NULL,
      day_key TEXT NOT NULL,
      uploaded_bytes INTEGER NOT NULL CHECK(uploaded_bytes >= 0),
      updated_at TEXT NOT NULL,
      PRIMARY KEY(user_id, day_key)
    );

    CREATE TABLE attachment_state_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attachment_id TEXT NOT NULL,
      state TEXT NOT NULL,
      error_code TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_attachment_state_events_attachment
      ON attachment_state_events(attachment_id, id);

    CREATE TABLE attachment_tombstones (
      receipt_id TEXT PRIMARY KEY,
      attachment_ref TEXT UNIQUE NOT NULL,
      final_state TEXT NOT NULL CHECK(final_state IN ('deleted', 'account_deleted')),
      created_at TEXT NOT NULL
    );
  `
});

const MIGRATION_V2 = Object.freeze({
  version: 2,
  name: 'image_understanding_phase_a2_backend',
  sql: `
    ALTER TABLE attachments ADD COLUMN processing_state_v2 TEXT;

    CREATE TABLE attachment_processing_jobs (
      processing_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      client_request_id TEXT NOT NULL,
      processing_version TEXT NOT NULL,
      attachment_set_hash TEXT NOT NULL,
      user_question_reference TEXT NOT NULL,
      answer_reference TEXT,
      state TEXT NOT NULL CHECK(state IN (
        'created', 'processing_ocr', 'processing_vision', 'merging_evidence',
        'processed', 'processed_partial', 'processing_failed'
      )),
      answer_mode TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(user_id, client_request_id)
    );
    CREATE INDEX idx_attachment_processing_jobs_owner
      ON attachment_processing_jobs(user_id, created_at, processing_id);

    CREATE TABLE attachment_processing_job_items (
      processing_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(processing_id, attachment_id),
      UNIQUE(processing_id, ordinal)
    );
    CREATE INDEX idx_attachment_processing_items_attachment
      ON attachment_processing_job_items(attachment_id, processing_id);

    CREATE TABLE attachment_processing_steps (
      processing_id TEXT NOT NULL,
      step_key TEXT NOT NULL,
      call_type TEXT NOT NULL CHECK(call_type IN ('ocr', 'vision')),
      attachment_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('in_flight', 'completed', 'failed', 'interrupted')),
      request_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      result_reference TEXT,
      usage_json TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(processing_id, step_key)
    );

    CREATE TABLE attachment_ocr_results (
      processing_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      ocr_model TEXT NOT NULL,
      result_reference TEXT NOT NULL,
      usage_json TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(processing_id, attachment_id)
    );

    CREATE TABLE attachment_vision_results (
      processing_id TEXT PRIMARY KEY,
      attachment_set_hash TEXT NOT NULL,
      vision_model TEXT NOT NULL,
      result_reference TEXT NOT NULL,
      usage_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE attachment_evidence_results (
      processing_id TEXT PRIMARY KEY,
      answer_mode TEXT NOT NULL,
      result_reference TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `
});

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function applyAttachmentMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS attachment_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  let latest = 0;
  for (const migration of attachmentMigrations) {
    const digest = checksum(migration.sql);
    const applied = database.prepare(
      'SELECT name, checksum FROM attachment_schema_migrations WHERE version = ?'
    ).get(migration.version);
    if (applied) {
      if (applied.name !== migration.name || applied.checksum !== digest) {
        throw Object.assign(new Error('Attachment migration checksum mismatch.'), {
          code: 'ATTACHMENT_MIGRATION_DRIFT'
        });
      }
      latest = migration.version;
      continue;
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      database.prepare(`
        INSERT INTO attachment_schema_migrations (version, name, checksum, applied_at)
        VALUES (?, ?, ?, ?)
      `).run(migration.version, migration.name, digest, new Date().toISOString());
      database.exec('COMMIT');
      latest = migration.version;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return { version: latest };
}

export const attachmentMigrations = Object.freeze([MIGRATION_V1, MIGRATION_V2]);
