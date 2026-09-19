import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MemoryRecallEngine,
  parseRelationshipEntityQuery
} from './index.js';
import { InMemoryMemoryRepository } from '../repository/index.js';
import { fakeMemoryRecord, fakeRecallContext } from './testing/fixtures.js';

const NOW = '2026-07-15T08:00:00.000Z';

const RELATION_CASES = [
  ['我妈什么时候生日？', 'mother', 'family:mother'],
  ['我妈妈什么时候生日？', 'mother', 'family:mother'],
  ['我母亲什么时候生日？', 'mother', 'family:mother'],
  ['我老婆什么时候生日？', 'wife', 'family:wife'],
  ['我妻子什么时候生日？', 'wife', 'family:wife'],
  ['我太太什么时候生日？', 'wife', 'family:wife'],
  ['我老公什么时候生日？', 'husband', 'family:husband'],
  ['我丈夫什么时候生日？', 'husband', 'family:husband'],
  ['我女儿什么时候生日？', 'daughter', 'family:daughter'],
  ['我闺女什么时候生日？', 'daughter', 'family:daughter'],
  ['我儿子什么时候生日？', 'son', 'family:son'],
  ['我爸爸什么时候生日？', 'father', 'family:father']
];

for (const [text, relationToUser, subjectCanonical] of RELATION_CASES) {
  test(`relationship entity query normalizes ${text}`, () => {
    const result = parseRelationshipEntityQuery({
      authenticatedUserId: 'fake-user-a',
      text
    });
    assert.equal(result.status, 'exact');
    assert.equal(result.ownerUserId, 'fake-user-a');
    assert.equal(result.entityType, 'person');
    assert.equal(result.entityId, subjectCanonical);
    assert.equal(result.relationToUser, relationToUser);
    assert.equal(result.subjectCanonical, subjectCanonical);
    assert.equal(result.predicate, 'birthday');
    assert.deepEqual(result.sourceMemoryIds, []);
    assert.equal(result.subjectAliases.length > 0, true);
  });
}

test('generic spouse and child terms fail closed when no precise entity context exists', () => {
  for (const text of ['我爱人什么时候生日？', '孩子什么时候生日？']) {
    const result = parseRelationshipEntityQuery({ authenticatedUserId: 'fake-user-a', text });
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.clarificationQuestion.endsWith('？'), true);
  }
});

test('nested or otherwise non-canonical family subjects ask for clarification instead of broad birthday recall', () => {
  const result = parseRelationshipEntityQuery({
    authenticatedUserId: 'fake-user-a',
    text: '我老婆的妈妈什么时候生日？'
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.subjectCanonical, null);
});

test('pronouns resolve only from an explicit same-conversation entity context', () => {
  const contextEntity = parseRelationshipEntityQuery({
    authenticatedUserId: 'fake-user-a',
    text: '我妈妈什么时候生日？'
  });
  const resolved = parseRelationshipEntityQuery({
    authenticatedUserId: 'fake-user-a',
    text: '她什么时候生日？',
    conversationEntity: contextEntity
  });
  assert.equal(resolved.status, 'exact');
  assert.equal(resolved.subjectCanonical, 'family:mother');

  const ambiguous = parseRelationshipEntityQuery({
    authenticatedUserId: 'fake-user-a',
    text: '她什么时候生日？'
  });
  assert.equal(ambiguous.status, 'ambiguous');
  assert.match(ambiguous.clarificationQuestion, /她.*谁/);
});

async function repositoryHarness(records) {
  const repository = new InMemoryMemoryRepository({ clock: () => new Date(NOW) });
  const context = {
    authenticatedUserId: 'fake-user-a', actorType: 'user', actorId: 'fake-user-a',
    requestId: 'entity-grounding', correlationId: 'entity-grounding', timestamp: NOW,
    policyVersion: 'memory-recall-v1', transactionId: null, metadata: {}
  };
  await repository.createMany(context, records, { idempotencyKey: 'entity-records' });
  return { repository, context };
}

function birthday(id, subject, value, overrides = {}) {
  return fakeMemoryRecord(id, {
    memoryType: 'relationship',
    subject,
    predicate: 'birthday',
    value,
    normalizedValue: value,
    ...overrides
  });
}

test('Recall Plan and Repository query use exact subject plus predicate', async () => {
  const records = [
    birthday('mother-birthday', 'family:mother', '我妈妈的生日是农历七月十六日'),
    birthday('wife-birthday', 'family:wife', '我妻子的生日是公历三月八日')
  ];
  const { repository } = await repositoryHarness(records);
  const originalQuery = repository.query.bind(repository);
  let observedQuery = null;
  repository.query = async (context, query) => {
    observedQuery = structuredClone(query);
    return originalQuery(context, query);
  };
  const engine = new MemoryRecallEngine({ repository });
  const result = await engine.recall(fakeRecallContext(), { text: '我老婆什么时候生日？' });
  assert.deepEqual(result.plan.subjects, ['family:wife']);
  assert.deepEqual(result.plan.predicates, ['birthday']);
  assert.equal(observedQuery.subject, 'family:wife');
  assert.equal(observedQuery.predicate, 'birthday');
  assert.deepEqual(result.selected.map((item) => item.record.id), ['wife-birthday']);
});

test('entity filter runs before ranking and no predicate-only fallback is allowed', async () => {
  const { repository } = await repositoryHarness([
    birthday('mother-birthday', 'family:mother', '我妈妈的生日是农历七月十六日')
  ]);
  let rankedRecords = null;
  const rankingEngine = {
    rank(records) {
      rankedRecords = records;
      return records.map((record) => ({ record, score: 1, scoreBreakdown: {} }));
    }
  };
  const result = await new MemoryRecallEngine({ repository, rankingEngine })
    .recall(fakeRecallContext(), { text: '我女儿什么时候生日？' });
  assert.deepEqual(rankedRecords, []);
  assert.deepEqual(result.selected, []);
  assert.equal(result.plan.subjects[0], 'family:daughter');
});

test('evidence grounding rejects a repository record whose subject does not match the query', async () => {
  const wrong = birthday('mother-birthday', 'family:mother', '我妈妈的生日是农历七月十六日');
  const repository = {
    async query() { return { items: [wrong], nextCursor: null }; },
    async getById() {}, async count() {}, async getVersionChain() {}, async getConflictGroup() {},
    async create() {}, async createMany() {}, async update() {}, async confirm() {}, async reject() {},
    async dispute() {}, async archive() {}, async expire() {}, async supersede() {},
    async moveToRecycleBin() {}, async restore() {}, async purge() {}, async withTransaction() {}
  };
  const result = await new MemoryRecallEngine({ repository })
    .recall(fakeRecallContext(), { text: '我老婆什么时候生日？' });
  assert.deepEqual(result.selected, []);
  assert.equal(result.excluded.some((item) => item.exclusionReason === 'subject'), true);
});
