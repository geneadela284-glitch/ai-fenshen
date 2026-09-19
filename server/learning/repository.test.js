import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyConversationMigrations } from '../conversation/migrations.js';
import { LearningRepository, applyLearningMigrations } from './repository.js';

function setup(t) {
  const db = new DatabaseSync(':memory:'); applyConversationMigrations(db); applyLearningMigrations(db);
  t.after(() => db.close());
  return { db, repo: new LearningRepository({ database: db, encryptionKey: Buffer.alloc(32, 3) }) };
}
const sessionInput = { lessonId: 'hello', level: 'beginner', language: 'en', persist: true, operationId: 'start-001', status: 'active' };
test('learning sessions reuse conversations, enforce owners and encrypt role-play messages', t => {
  const { db, repo } = setup(t);
  const session = repo.create('a', sessionInput);
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, 1);
  assert.equal(repo.get('b', session.id), null);
  const saved = repo.append('a', session.id, { clientTurnId: 'turn-001', transcript: 'I live in London', reply: { replyEn: 'Hello!', helpZh: '你好', feedback: [], goalReached: true }, inputMode: 'voice', hint: 'none' }, session.revision);
  assert.equal(repo.turns('a', session.id)[0].transcript, 'I live in London');
  assert.throws(() => repo.turns('b', session.id), { code: 'LEARNING_NOT_FOUND' });
  const raw = db.prepare('SELECT content FROM messages').all().map(x => x.content).join(' ');
  assert.ok(!raw.includes('London'));
  assert.equal(saved.revision, 2);
  assert.equal(repo.isLearningConversation(session.conversationId, 'a'), true);
});
test('same retry returns original turn but changed content or stale revisions cannot overwrite it', t => {
  const { repo } = setup(t); const s = repo.create('a', sessionInput);
  const input = { clientTurnId: 'turn-001', transcript: 'Hello', reply: { replyEn: 'Hi', helpZh: '你好', feedback: [], goalReached: true }, inputMode: 'voice', hint: 'none' };
  const once = repo.append('a', s.id, input, 1);
  assert.deepEqual(repo.append('a', s.id, input, 1), once);
  assert.equal(repo.turns('a', s.id).length, 1);
  assert.throws(() => repo.append('a', s.id, { ...input, transcript: 'different' }, 2), { code: 'LEARNING_REQUEST_CONFLICT' });
  assert.throws(() => repo.append('a', s.id, { ...input, clientTurnId: 'turn-002' }, 1), { code: 'LEARNING_REVISION_CONFLICT' });
});
test('deleting learning removes shared messages and sources without affecting an ordinary chat', t => {
  const { db, repo } = setup(t); const s = repo.create('a', sessionInput);
  repo.conversations.createForOwner('a', { title: 'ordinary' });
  repo.append('a', s.id, { clientTurnId: 'turn-001', transcript: 'Hello', reply: { replyEn: 'Hi', helpZh: '你好', feedback: [], goalReached: true }, inputMode: 'voice', hint: 'none' }, 1);
  repo.delete('a', s.id, 2);
  assert.equal(repo.get('a', s.id), null);
  assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n, 0);
  assert.equal(db.prepare('SELECT title FROM conversations').get().title, 'ordinary');
});
test('preferences are owner-scoped, encrypted and survive repository recreation',t=>{
 const {db,repo}=setup(t);repo.savePreferences('a',{level:'advanced'});const reopened=new LearningRepository({database:db,encryptionKey:Buffer.alloc(32,3)});assert.equal(reopened.preferences('a').level,'advanced');assert.equal(reopened.preferences('b').level,'beginner');assert.ok(!db.prepare('SELECT payload FROM learning_preferences').get().payload.includes('advanced'));
});
