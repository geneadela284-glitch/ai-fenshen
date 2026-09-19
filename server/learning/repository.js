import { randomUUID, createHmac } from 'node:crypto';
import { encryptBytes, decryptBytes } from '../../core/localDataSpace/crypto.js';
import { learningError, requiredText, evidenceOutcome, transitionSession, validateTeacherReply } from '../../core/learning/contract.js';
import { ConversationRepository, MessageRepository } from '../conversation/repositories.js';

export function applyLearningMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS learning_sessions (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, revision INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id,operation_id));
    CREATE TABLE IF NOT EXISTS learning_turns (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL, client_turn_id TEXT NOT NULL, digest TEXT NOT NULL,
      user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, UNIQUE(session_id,client_turn_id));
    CREATE TABLE IF NOT EXISTS learning_hints (session_id TEXT NOT NULL REFERENCES learning_sessions(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL,turn_number INTEGER NOT NULL,PRIMARY KEY(session_id,turn_number));
    CREATE TABLE IF NOT EXISTS learning_preferences (owner_id TEXT PRIMARY KEY,payload TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS learning_audit (id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,entity_id TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS learning_owner_sessions ON learning_sessions(owner_id,updated_at);
  `);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
export class LearningRepository {
  constructor({ database, encryptionKey, now = () => new Date().toISOString() }) {
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) throw learningError('LEARNING_KEY_REQUIRED', 503);
    this.database = database; this.key = Buffer.from(encryptionKey); this.now = now;
    this.conversations = new ConversationRepository({ database, now });
    this.messages = new MessageRepository({ database, now });
  }
  encode(owner, id, data) { return JSON.stringify(encryptBytes(Buffer.from(JSON.stringify(data)), this.key, { aad: `learning-v1:${owner}:${id}` })); }
  decode(owner, id, value) { return JSON.parse(decryptBytes(JSON.parse(value), this.key, { aad: `learning-v1:${owner}:${id}` }).toString('utf8')); }
  digest(input) { return createHmac('sha256', this.key).update(JSON.stringify(stable(input))).digest('hex'); }
  transaction(fn) {
    const name = `learning_${randomUUID().replaceAll('-', '')}`;
    this.database.exec(`SAVEPOINT ${name}`);
    try { const result = fn(); this.database.exec(`RELEASE SAVEPOINT ${name}`); return result; }
    catch (e) { this.database.exec(`ROLLBACK TO SAVEPOINT ${name}`); this.database.exec(`RELEASE SAVEPOINT ${name}`); throw e; }
  }
  audit(owner, id, action) { this.database.prepare('INSERT INTO learning_audit VALUES(?,?,?,?,?)').run(randomUUID(), owner, id, action, this.now()); }
  fromRow(row) { return row ? { ...this.decode(row.owner_id, row.id, row.payload), id: row.id, conversationId: row.conversation_id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at } : null; }
  get(owner, id) { return this.fromRow(this.database.prepare('SELECT * FROM learning_sessions WHERE owner_id=? AND id=?').get(requiredText(owner), id)); }
  require(owner, id) { const s = this.get(owner, id); if (!s) throw learningError('LEARNING_NOT_FOUND', 404); return s; }
  list(owner) { return this.database.prepare('SELECT * FROM learning_sessions WHERE owner_id=? ORDER BY updated_at DESC,rowid DESC').all(requiredText(owner)).map(row => this.fromRow(row)); }
  isLearningConversation(conversationId, owner) { return !!this.database.prepare('SELECT id FROM learning_sessions WHERE conversation_id=? AND owner_id=?').get(conversationId, owner); }
  create(owner, input) {
    owner = requiredText(owner); const digest = this.digest(input);
    const existing = this.database.prepare('SELECT * FROM learning_sessions WHERE owner_id=? AND operation_id=?').get(owner, requiredText(input.operationId));
    if (existing) {
      if (existing.digest !== digest) throw learningError('LEARNING_REQUEST_CONFLICT', 409);
      return this.fromRow(existing);
    }
    return this.transaction(() => {
      const id = `learn_${randomUUID()}`, at = this.now();
      const conversation = this.conversations.createForOwner(owner, { title: '英语练习' });
      const data = { ...input, status: 'active', turnCount: 0, independentCount: 0, lessonVersion: 1, goalReached: false };
      this.database.prepare('INSERT INTO learning_sessions VALUES(?,?,?,?,?,?,?,?,?)').run(id, owner, conversation.id, input.operationId, digest, this.encode(owner, id, data), 1, at, at);
      this.audit(owner, id, 'create'); return this.get(owner, id);
    });
  }
  write(owner, session, data, revision) {
    const { id, conversationId, createdAt, updatedAt, revision: _revision, ...payload } = data;
    const result = this.database.prepare('UPDATE learning_sessions SET payload=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?')
      .run(this.encode(owner, session.id, payload), this.now(), session.id, owner, revision);
    if (result.changes !== 1) throw learningError('LEARNING_REVISION_CONFLICT', 409);
    return this.get(owner, session.id);
  }
  markHint(owner, id) { const s=this.require(owner,id); if(s.status!=='active')throw learningError('LEARNING_STATE_CONFLICT',409);this.database.prepare('INSERT OR IGNORE INTO learning_hints VALUES(?,?,?)').run(id,owner,s.turnCount); }
  hasHint(owner,id,turnNumber) { return !!this.database.prepare('SELECT 1 FROM learning_hints WHERE session_id=? AND owner_id=? AND turn_number=?').get(id,owner,turnNumber); }
  findTurn(owner, sessionId, clientTurnId) {
    this.require(owner, sessionId);
    return this.database.prepare('SELECT * FROM learning_turns WHERE session_id=? AND owner_id=? AND client_turn_id=?').get(sessionId, owner, clientTurnId) || null;
  }
  append(owner, sessionId, input, revision) {
    const s = this.require(owner, sessionId);
    const digest = this.digest({ transcript: input.transcript, inputMode: input.inputMode, hint: input.hint, transcriptCorrected: input.transcriptCorrected === true });
    const existing = this.findTurn(owner, sessionId, requiredText(input.clientTurnId));
    if (existing) {
      if (digest !== existing.digest) throw learningError('LEARNING_REQUEST_CONFLICT', 409);
      return this.decode(owner, existing.id, existing.payload).result;
    }
    if (s.status !== 'active') throw learningError('LEARNING_STATE_CONFLICT', 409);
    const transcript = requiredText(input.transcript, 6000), reply = validateTeacherReply(input.reply, transcript);
    return this.transaction(() => {
      if (revision !== s.revision) throw learningError('LEARNING_REVISION_CONFLICT', 409);
      const requestId = input.clientTurnId, id = `lt_${randomUUID()}`;
      const user = this.messages.createUserMessage({ ownerId: owner, conversationId: s.conversationId, clientRequestId: requestId,
        content: this.encode(owner, `${s.id}:${requestId}:user`, { transcript, roleplay: true }) });
      const assistant = this.messages.createAssistantPlaceholder({ ownerId: owner, conversationId: s.conversationId, clientRequestId: requestId });
      this.messages.completeAssistantMessage({ ownerId: owner, messageId: assistant.id, content: this.encode(owner, `${s.id}:${requestId}:assistant`, reply) });
      const evidence = evidenceOutcome({ ...input, goalReached: reply.goalReached });
      const result = this.write(owner, s, { ...s, goalReached: s.goalReached || reply.goalReached, turnCount: s.turnCount + 1,
        independentCount: s.independentCount + Number(evidence === 'independent_this_attempt') }, revision);
      const payload = { result, inputMode: input.inputMode, hint: input.hint, transcriptCorrected: input.transcriptCorrected === true, correctsTurnId: input.correctsTurnId || null, sourceAudioDigest: input.sourceAudioDigest || null,
        evidence, assessmentSource: input.assessmentSource === 'guided_drill' ? 'guided_drill' : 'ai_expression_review',
        assessment: input.assessmentSource === 'guided_drill' ? '启蒙目标表达匹配，不是发音评分' : 'AI评估/本次表达，不是发音评分', createdAt: this.now() };
      this.database.prepare('INSERT INTO learning_turns VALUES(?,?,?,?,?,?,?,?)').run(id, s.id, owner, requestId, digest, user.id, assistant.id, this.encode(owner, id, payload));
      this.audit(owner, id, 'turn'); return result;
    });
  }
  turns(owner, sessionId) {
    const s = this.require(owner, sessionId);
    return this.database.prepare(`SELECT t.*,u.content AS user_content,a.content AS assistant_content FROM learning_turns t
      JOIN messages u ON u.id=t.user_message_id JOIN messages a ON a.id=t.assistant_message_id
      WHERE t.session_id=? AND t.owner_id=? ORDER BY t.rowid`).all(sessionId, owner).map(row => {
      const { result, ...meta } = this.decode(owner, row.id, row.payload);
      return { id: row.id, clientTurnId: row.client_turn_id, sourceMessageId: row.user_message_id, ...meta,
        ...this.decode(owner, `${s.id}:${row.client_turn_id}:user`, row.user_content),
        reply: this.decode(owner, `${s.id}:${row.client_turn_id}:assistant`, row.assistant_content) };
    });
  }
  replaceLast(owner,id,input,revision) {
    const session=this.require(owner,id),turns=this.turns(owner,id),last=turns.at(-1);
    if(!last||last.id!==input.correctsTurnId||last.inputMode!=='voice')throw learningError('LEARNING_CORRECTION_CONFLICT',409);
    if(session.revision!==revision)throw learningError('LEARNING_REVISION_CONFLICT',409);
    const prior=turns.slice(0,-1);
    return this.transaction(()=>{
      const row=this.findTurn(owner,id,last.clientTurnId);
      this.database.prepare('DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE owner_id=? AND id=?) AND id IN (?,?)').run(owner,session.conversationId,row.user_message_id,row.assistant_message_id);
      // The foreign keys remove the obsolete feedback row with its source messages.
      const base=this.write(owner,session,{...session,turnCount:prior.length,goalReached:prior.some(t=>t.reply.goalReached),independentCount:prior.filter(t=>t.evidence==='independent_this_attempt').length},revision);
      const result=this.append(owner,id,{...input,inputMode:'voice',transcriptCorrected:true},base.revision);
      this.audit(owner,last.id,'recognition_corrected');return result;
    });
  }
  action(owner, id, action, revision) {
    const s = this.require(owner, id);
    if (action === 'complete' && (!s.goalReached || s.turnCount === 0)) throw learningError('LEARNING_GOAL_NOT_REACHED', 409);
    return this.transaction(() => { const result = this.write(owner, s, { ...s, status: transitionSession(s.status, action) }, revision); this.audit(owner, id, action); return result; });
  }
  delete(owner, id, revision) {
    const s = this.require(owner, id);
    if (s.revision !== revision) throw learningError('LEARNING_REVISION_CONFLICT', 409);
    this.transaction(() => {
      this.database.prepare('DELETE FROM conversations WHERE id=? AND owner_id=?').run(s.conversationId, owner);
      this.audit(owner, id, 'delete');
    });
    return { deleted: true };
  }
  preferences(owner) { const row=this.database.prepare('SELECT payload FROM learning_preferences WHERE owner_id=?').get(requiredText(owner));return row?this.decode(owner,'preferences',row.payload):{level:'beginner'}; }
  savePreferences(owner,{level}) { if(!['beginner','intermediate','advanced'].includes(level))throw learningError('LEVEL_INVALID');this.database.prepare('INSERT INTO learning_preferences VALUES(?,?,1) ON CONFLICT(owner_id) DO UPDATE SET payload=excluded.payload,revision=revision+1').run(requiredText(owner),this.encode(owner,'preferences',{level})); }
  export(owner) { return { preferences:this.preferences(owner),version: 'learning-v1', exportedAt: this.now(), sessions: this.list(owner).map(s => ({ ...s, turns: this.turns(owner, s.id) })) }; }
  close() { this.key.fill(0); }
}
