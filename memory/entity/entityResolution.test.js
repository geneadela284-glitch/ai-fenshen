import assert from 'node:assert/strict';
import test from 'node:test';

import { ENTITY_TEST_IDS } from '../../testing/entityFixtures.js';
import { FakeAIEntityResolver } from '../../testing/fakeAIEntityResolver.js';
import {
  ENTITY_RESOLUTION_PURPOSES,
  validateAIEntityResolver
} from './aiEntityResolver.js';
import { ConversationEntityContext } from './conversationEntityContext.js';
import { parseEntityReferenceProposal } from './entityReferenceParser.js';

const NOW = '2026-07-16T12:00:00.000Z';

test('AI Entity Resolver port accepts only an object with resolve()', () => {
  assert.deepEqual(ENTITY_RESOLUTION_PURPOSES, ['capture', 'recall']);
  assert.equal(validateAIEntityResolver(new FakeAIEntityResolver()).valid, true);
  assert.equal(validateAIEntityResolver({}).valid, false);
});

test('Entity Reference Parser accepts a closed structured semantic proposal', () => {
  assert.deepEqual(parseEntityReferenceProposal({
    kind: 'alias_relation', mention: '我女儿小雨', alias: '小雨',
    relationKind: 'child', role: 'daughter',
    suggestedEntityId: ENTITY_TEST_IDS.daughterOne,
    rankedCandidateEntityIds: [ENTITY_TEST_IDS.daughterOne],
    needsClarification: false
  }), {
    kind: 'alias_relation', mention: '我女儿小雨', alias: '小雨',
    relationKind: 'child', role: 'daughter', entityId: null,
    suggestedEntityId: ENTITY_TEST_IDS.daughterOne,
    rankedCandidateEntityIds: [ENTITY_TEST_IDS.daughterOne],
    needsClarification: false
  });
});

test('Entity Reference Parser rejects unknown fields and relation labels as Entity IDs', () => {
  assert.throws(() => parseEntityReferenceProposal({
    kind: 'entity', mention: '女儿', entityId: 'family:daughter'
  }), /opaque Entity ID/i);
  assert.throws(() => parseEntityReferenceProposal({
    kind: 'self', mention: '我', createEntity: true
  }), /unknown field/i);
});

test('Entity Reference Parser does not turn unknown input into an exact proposal', () => {
  assert.deepEqual(parseEntityReferenceProposal({ kind: 'none', mention: '' }), {
    kind: 'none', mention: '', alias: null, relationKind: null, role: null,
    entityId: null, suggestedEntityId: null, rankedCandidateEntityIds: [],
    needsClarification: false
  });
});

test('Conversation Entity Context is owner-scoped, conversation-scoped, and expiring', () => {
  let time = Date.parse(NOW);
  const context = new ConversationEntityContext({
    ttlMs: 1000,
    now: () => new Date(time).toISOString()
  });
  context.recordExact({
    ownerUserId: ENTITY_TEST_IDS.owner,
    conversationId: 'conversation-a',
    entityId: ENTITY_TEST_IDS.daughterOne,
    entityType: 'person'
  });
  assert.equal(context.get({
    ownerUserId: ENTITY_TEST_IDS.owner,
    conversationId: 'conversation-a'
  }).entityId, ENTITY_TEST_IDS.daughterOne);
  assert.equal(context.get({ ownerUserId: 'other-owner', conversationId: 'conversation-a' }), null);
  assert.equal(context.get({ ownerUserId: ENTITY_TEST_IDS.owner, conversationId: 'conversation-b' }), null);
  time += 1001;
  assert.equal(context.get({
    ownerUserId: ENTITY_TEST_IDS.owner,
    conversationId: 'conversation-a'
  }), null);
});

test('Conversation Entity Context explicit Entity overrides the previous Entity', () => {
  const context = new ConversationEntityContext({ now: () => NOW });
  for (const entityId of [ENTITY_TEST_IDS.daughterOne, ENTITY_TEST_IDS.friendOne]) {
    context.recordExact({
      ownerUserId: ENTITY_TEST_IDS.owner,
      conversationId: 'conversation-a',
      entityId,
      entityType: 'person'
    });
  }
  assert.equal(context.get({
    ownerUserId: ENTITY_TEST_IDS.owner,
    conversationId: 'conversation-a'
  }).entityId, ENTITY_TEST_IDS.friendOne);
});

test('Conversation Entity Context can be cleared when candidates become ambiguous', () => {
  const context = new ConversationEntityContext({ now: () => NOW });
  context.recordExact({
    ownerUserId: ENTITY_TEST_IDS.owner,
    conversationId: 'conversation-a',
    entityId: ENTITY_TEST_IDS.daughterOne,
    entityType: 'person'
  });
  context.clear({ ownerUserId: ENTITY_TEST_IDS.owner, conversationId: 'conversation-a' });
  assert.equal(context.get({
    ownerUserId: ENTITY_TEST_IDS.owner,
    conversationId: 'conversation-a'
  }), null);
});

test('Fake AI Resolver returns proposals but receives no Repository or Memory capability', async () => {
  const fake = new FakeAIEntityResolver({
    input: { kind: 'self', mention: '我' }
  });
  assert.deepEqual(await fake.resolve({
    ownerUserId: ENTITY_TEST_IDS.owner,
    text: 'input', locale: 'zh-CN', purpose: 'capture',
    conversationEntityContext: null
  }), { kind: 'self', mention: '我' });
  assert.deepEqual(Object.keys(fake.calls[0]).sort(), [
    'conversationEntityContext', 'locale', 'ownerUserId', 'purpose', 'text'
  ]);
});
