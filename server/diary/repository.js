import { createHmac, randomUUID } from 'node:crypto';
import { encryptBytes, decryptBytes } from '../../core/localDataSpace/crypto.js';

export function diaryError(code, status = 400) { return Object.assign(new Error(code), { code, status }); }

export function applyDiaryMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS diary_entries (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, occurred_on TEXT NOT NULL,
      payload TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_diary_owner_date ON diary_entries(user_id, occurred_on DESC);
    CREATE TABLE IF NOT EXISTS diary_requests (
      user_id TEXT NOT NULL, request_key TEXT NOT NULL, content_hash TEXT NOT NULL,
      entry_id TEXT NOT NULL, PRIMARY KEY(user_id, request_key)
    );
    CREATE TABLE IF NOT EXISTS diary_audit (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, entry_id TEXT NOT NULL,
      action TEXT NOT NULL, revision INTEGER NOT NULL, occurred_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS diary_task_links (
      task_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, entry_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_diary_task_owner ON diary_task_links(user_id, entry_id);
  `);
}

export class DiaryRepository {
  constructor({ database, encryptionKey, clock = () => new Date() }) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) throw diaryError('DIARY_KEY_REQUIRED',503);
    this.database = database; this.key = Buffer.from(encryptionKey); this.clock = clock;
  }
  transaction(fn) {
    const name = `diary_${randomUUID().replaceAll('-','')}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try { const result=fn(); this.database.exec(`RELEASE SAVEPOINT ${name}`); return result; }
    catch(error) { this.database.exec(`ROLLBACK TO SAVEPOINT ${name}`); this.database.exec(`RELEASE SAVEPOINT ${name}`); throw error; }
  }
  contentHash(value) { return createHmac('sha256',this.key).update(JSON.stringify(value)).digest('hex'); }
  request(owner,key) {return this.database.prepare('SELECT * FROM diary_requests WHERE user_id=? AND request_key=?').get(owner,key);}
  saveRequest(owner,key,hash,id) {this.database.prepare('INSERT INTO diary_requests VALUES(?,?,?,?)').run(owner,key,hash,id);}
  linkTask(owner,entryId,taskId) {this.database.prepare('INSERT OR IGNORE INTO diary_task_links VALUES(?,?,?)').run(taskId,owner,entryId);}
  diaryIdForTask(owner,taskId) {return this.database.prepare('SELECT entry_id FROM diary_task_links WHERE user_id=? AND task_id=?').get(owner,taskId)?.entry_id||null;}
  decode(row) {
    if(!row) return null;
    const payload=JSON.parse(decryptBytes(JSON.parse(row.payload),this.key,{aad:`diary-v1:${row.user_id}:${row.id}`}).toString('utf8'));
    return {...payload,id:row.id,occurredOn:row.occurred_on,revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at};
  }
  encode(owner,entry) {
    return JSON.stringify(encryptBytes(Buffer.from(JSON.stringify({title:entry.title,body:entry.body,source:entry.source,reminder:entry.reminder})),this.key,{aad:`diary-v1:${owner}:${entry.id}`}));
  }
  getForOwner(owner,id) {return this.decode(this.database.prepare('SELECT * FROM diary_entries WHERE user_id=? AND id=?').get(owner,id));}
  listForOwner(owner,date) {
    const rows=date ? this.database.prepare('SELECT * FROM diary_entries WHERE user_id=? AND occurred_on=? ORDER BY occurred_on DESC,created_at DESC,id DESC').all(owner,date)
      : this.database.prepare('SELECT * FROM diary_entries WHERE user_id=? ORDER BY occurred_on DESC,created_at DESC,id DESC').all(owner);
    return rows.map(row=>this.decode(row));
  }
  insert(owner,entry) {
    this.database.prepare('INSERT INTO diary_entries VALUES(?,?,?,?,?,?,?)').run(entry.id,owner,entry.occurredOn,this.encode(owner,entry),entry.revision,entry.createdAt,entry.updatedAt);
    this.audit(owner,entry,'create'); return entry;
  }
  update(owner,entry,previousRevision) {
    const result=this.database.prepare('UPDATE diary_entries SET occurred_on=?,payload=?,revision=?,updated_at=? WHERE user_id=? AND id=? AND revision=?').run(entry.occurredOn,this.encode(owner,entry),entry.revision,entry.updatedAt,owner,entry.id,previousRevision);
    if(Number(result.changes)!==1) throw diaryError('DIARY_REVISION_CONFLICT',409);
    this.audit(owner,entry,'update'); return entry;
  }
  delete(owner,entry) {
    const result=this.database.prepare('DELETE FROM diary_entries WHERE user_id=? AND id=? AND revision=?').run(owner,entry.id,entry.revision);
    if(Number(result.changes)!==1) throw diaryError('DIARY_REVISION_CONFLICT',409);
    this.audit(owner,entry,'delete'); return true;
  }
  audit(owner,entry,action) {this.database.prepare('INSERT INTO diary_audit VALUES(?,?,?,?,?,?)').run(randomUUID(),owner,entry.id,action,entry.revision,this.clock().toISOString());}
}
