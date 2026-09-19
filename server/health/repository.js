import { createHmac, randomUUID } from 'node:crypto';
import { encryptBytes, decryptBytes } from '../../core/localDataSpace/crypto.js';
export function healthError(code, status = 400) {
  return Object.assign(new Error(code), {
    code,
    status
  });
}
export function applyHealthMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS health_records (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      occurred_on TEXT NOT NULL,
      payload TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_health_owner_kind_date
      ON health_records(user_id, kind, occurred_on DESC);
    CREATE TABLE IF NOT EXISTS health_requests (
      user_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      health_id TEXT NOT NULL,
      PRIMARY KEY(user_id, request_key)
    );
    CREATE TABLE IF NOT EXISTS health_audit (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      health_id TEXT NOT NULL,
      action TEXT NOT NULL,
      revision INTEGER NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_task_links (
      task_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      health_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_health_task_owner
      ON health_task_links(user_id, health_id);
  `);
}
export class HealthRepository {
  constructor({
    database,
    encryptionKey,
    clock = () => new Date()
  } = {}) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
      throw healthError('HEALTH_KEY_REQUIRED', 503);
    }
    this.database = database;
    this.key = Buffer.from(encryptionKey);
    this.clock = clock;
  }
  transaction(operation) {
    const savepoint = `health_${randomUUID().replaceAll('-', '')}`;
    this.database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = operation();
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    }
  }
  contentHash(value) {
    return createHmac('sha256', this.key).update(JSON.stringify(value)).digest('hex');
  }
  request(owner, key) {
    return this.database.prepare('SELECT * FROM health_requests WHERE user_id = ? AND request_key = ?').get(owner, key);
  }
  saveRequest(owner, key, hash, healthId) {
    this.database.prepare('INSERT INTO health_requests VALUES (?, ?, ?, ?)').run(owner, key, hash, healthId);
  }
  linkTask(owner, healthId, taskId) {
    this.database.prepare('INSERT INTO health_task_links VALUES (?, ?, ?)').run(taskId, owner, healthId);
  }
  healthIdForTask(owner, taskId) {
    return this.database.prepare('SELECT health_id FROM health_task_links WHERE user_id = ? AND task_id = ?').get(owner, taskId)?.health_id || null;
  }
  taskLinks(owner, healthId) {
    return this.database.prepare('SELECT task_id FROM health_task_links WHERE user_id = ? AND health_id = ? ORDER BY rowid ASC').all(owner, healthId).map(row => row.task_id);
  }
  encode(owner, record) {
    const bytes = Buffer.from(JSON.stringify(record.payload), 'utf8');
    return JSON.stringify(encryptBytes(bytes, this.key, {
      aad: `health-v1:${owner}:${record.id}:${record.kind}`
    }));
  }
  decode(row) {
    if (!row) return null;
    const payload = JSON.parse(decryptBytes(JSON.parse(row.payload), this.key, {
      aad: `health-v1:${row.user_id}:${row.id}:${row.kind}`
    }).toString('utf8'));
    return {
      id: row.id,
      kind: row.kind,
      occurredOn: row.occurred_on,
      payload,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }
  getForOwner(owner, id) {
    return this.decode(this.database.prepare('SELECT * FROM health_records WHERE user_id = ? AND id = ?').get(owner, id));
  }
  listForOwner(owner, {
    kind,
    from,
    to
  } = {}) {
    const clauses = ['user_id = ?'];
    const values = [owner];
    if (kind) {
      clauses.push('kind = ?');
      values.push(kind);
    }
    if (from) {
      clauses.push('occurred_on >= ?');
      values.push(from);
    }
    if (to) {
      clauses.push('occurred_on <= ?');
      values.push(to);
    }
    return this.database.prepare(`
      SELECT * FROM health_records WHERE ${clauses.join(' AND ')}
      ORDER BY occurred_on DESC, created_at DESC, id DESC
    `).all(...values).map(row => this.decode(row));
  }
  insert(owner, record) {
    this.database.prepare(`
      INSERT INTO health_records
        (id, user_id, kind, occurred_on, payload, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, owner, record.kind, record.occurredOn, this.encode(owner, record), record.revision, record.createdAt, record.updatedAt);
    this.audit(owner, record, 'create');
    return record;
  }
  update(owner, record, previousRevision) {
    const result = this.database.prepare(`
      UPDATE health_records SET occurred_on = ?, payload = ?, revision = ?, updated_at = ?
      WHERE user_id = ? AND id = ? AND revision = ?
    `).run(record.occurredOn, this.encode(owner, record), record.revision, record.updatedAt, owner, record.id, previousRevision);
    if (Number(result.changes) !== 1) throw healthError('HEALTH_REVISION_CONFLICT', 409);
    this.audit(owner, record, 'update');
    return record;
  }
  delete(owner, record) {
    const result = this.database.prepare('DELETE FROM health_records WHERE user_id = ? AND id = ? AND revision = ?').run(owner, record.id, record.revision);
    if (Number(result.changes) !== 1) throw healthError('HEALTH_REVISION_CONFLICT', 409);
    this.audit(owner, record, 'delete');
    this.database.prepare('DELETE FROM health_task_links WHERE user_id = ? AND health_id = ?').run(owner, record.id);
    return true;
  }
  audit(owner, record, action) {
    this.database.prepare('INSERT INTO health_audit VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), owner, record.id, action, record.revision, this.clock().toISOString());
  }
}
