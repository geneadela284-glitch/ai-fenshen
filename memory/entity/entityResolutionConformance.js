import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityAlias,
  fakeEntityRelation
} from '../../testing/entityFixtures.js';
import { FakeAIEntityResolver } from '../../testing/fakeAIEntityResolver.js';
import { ConversationEntityContext } from './conversationEntityContext.js';
import { createEntityResolutionService } from './entityResolutionService.js';

const OWNER_A = ENTITY_TEST_IDS.owner;
const OWNER_B = 'user-entity-resolution-b';
const NOW = '2026-07-16T12:00:00.000Z';
const MOTHER = 'ent_506172839405a6b7c8d9eafb0c1d2e3f';

function entity(ownerUserId, entityId, overrides = {}) {
  return fakeEntity({
    ownerUserId,
    entityId,
    source: { type: 'user_confirmed', id: `entity-${entityId}` },
    ...overrides
  });
}

function addEntity(foundation, ownerUserId, entityId, overrides) {
  return foundation.repository.create(ownerUserId, entity(ownerUserId, entityId, overrides));
}

function addAlias(foundation, alias, entityId, overrides = {}) {
  return foundation.aliases.addAlias(OWNER_A, fakeEntityAlias({
    alias,
    entityId,
    source: { type: 'user_confirmed', id: `alias-${alias}-${entityId}` },
    ...overrides
  }));
}

function addRelation(foundation, relationId, targetEntityId, overrides = {}) {
  return foundation.relations.createRelation(OWNER_A, fakeEntityRelation({
    relationId,
    targetEntityId,
    ...overrides
  }));
}

function seedSelf(foundation) {
  addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.self, { metadata: { entityRole: 'self' } });
}

function serviceFor(foundation, proposals, {
  context = new ConversationEntityContext({ now: () => NOW }),
  now = () => NOW
} = {}) {
  const aiResolver = new FakeAIEntityResolver(proposals);
  const service = createEntityResolutionService({
    repository: foundation.repository,
    aliases: foundation.aliases,
    relations: foundation.relations,
    aiResolver,
    conversationContext: context,
    now
  });
  return { service, aiResolver, context };
}

function resolve(service, text, overrides = {}) {
  return service.resolve({
    ownerUserId: OWNER_A,
    text,
    locale: 'zh-CN',
    conversationId: 'conversation-a',
    purpose: 'capture',
    effectiveAt: NOW,
    ...overrides
  });
}

async function openForTest(t, createHarness) {
  const harness = await createHarness();
  t.after(async () => harness.close?.());
  return harness.foundation;
}

export function registerEntityResolutionConformance(label, createHarness) {
  test(`${label}: self mention resolves to the unique active self Entity`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    seedSelf(foundation);
    const { service } = serviceFor(foundation, {
      '我下周有安排': { kind: 'self', mention: '我' }
    });
    const result = await resolve(service, '我下周有安排');
    assert.equal(result.resolutionStatus, 'exact');
    assert.equal(result.entityId, ENTITY_TEST_IDS.self);
    assert.equal(result.ownerUserId, OWNER_A);
    assert.equal(result.entityType, 'person');
    assert.equal(result.resolutionMethod, 'self');
    assert.equal(result.confidence, 1);
    assert.ok(result.evidence.length > 0);
  });

  test(`${label}: one effective mother relation resolves exactly`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    seedSelf(foundation);
    addEntity(foundation, OWNER_A, MOTHER);
    addRelation(foundation, 'rel_mother_00001', MOTHER, {
      relationKind: 'parent', role: 'mother'
    });
    const { service } = serviceFor(foundation, {
      '我妈妈5月6号生日': {
        kind: 'relation', mention: '我妈妈', relationKind: 'parent', role: 'mother'
      }
    });
    const result = await resolve(service, '我妈妈5月6号生日');
    assert.equal(result.resolutionStatus, 'exact');
    assert.equal(result.entityId, MOTHER);
    assert.equal(result.resolutionMethod, 'relation');
  });

  test(`${label}: two current daughter relations are ambiguous and ask one question`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    seedSelf(foundation);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.daughterTwo);
    addRelation(foundation, 'rel_daughter_0001', ENTITY_TEST_IDS.daughterOne);
    addRelation(foundation, 'rel_daughter_0002', ENTITY_TEST_IDS.daughterTwo);
    const { service } = serviceFor(foundation, {
      '我女儿下周考试': {
        kind: 'relation', mention: '我女儿', relationKind: 'child', role: 'daughter'
      }
    });
    const result = await resolve(service, '我女儿下周考试');
    assert.equal(result.resolutionStatus, 'ambiguous');
    assert.deepEqual(result.candidates.map((value) => value.entityId), [
      ENTITY_TEST_IDS.daughterOne,
      ENTITY_TEST_IDS.daughterTwo
    ]);
    assert.equal(typeof result.clarificationQuestion, 'string');
    assert.equal((result.clarificationQuestion.match(/？/g) ?? []).length, 1);
  });

  test(`${label}: one active name alias resolves exactly`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    addAlias(foundation, '小雨', ENTITY_TEST_IDS.daughterOne);
    const { service } = serviceFor(foundation, {
      '小雨下周考试': { kind: 'alias', mention: '小雨', alias: '小雨' }
    });
    const result = await resolve(service, '小雨下周考试');
    assert.equal(result.resolutionStatus, 'exact');
    assert.equal(result.entityId, ENTITY_TEST_IDS.daughterOne);
    assert.equal(result.resolutionMethod, 'alias');
  });

  test(`${label}: two friends with the same name remain ambiguous and unmerged`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.friendOne);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.friendTwo);
    addAlias(foundation, '小王', ENTITY_TEST_IDS.friendOne);
    addAlias(foundation, '小王', ENTITY_TEST_IDS.friendTwo);
    const { service } = serviceFor(foundation, {
      '小王最近怎么样': { kind: 'alias', mention: '小王', alias: '小王' }
    });
    const result = await resolve(service, '小王最近怎么样');
    assert.equal(result.resolutionStatus, 'ambiguous');
    assert.equal(result.candidates.length, 2);
    assert.equal(foundation.repository.listByOwner(OWNER_A).length, 2);
  });

  test(`${label}: high-confidence duplicate alias cannot be forced to one candidate by AI`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.friendOne);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.friendTwo);
    addAlias(foundation, '阿明', ENTITY_TEST_IDS.friendOne, { confidence: 1 });
    addAlias(foundation, '阿明', ENTITY_TEST_IDS.friendTwo, { confidence: 1 });
    const { service } = serviceFor(foundation, {
      '阿明会来吗': {
        kind: 'alias', mention: '阿明', alias: '阿明',
        suggestedEntityId: ENTITY_TEST_IDS.friendOne,
        rankedCandidateEntityIds: [ENTITY_TEST_IDS.friendOne, ENTITY_TEST_IDS.friendTwo]
      }
    });
    const result = await resolve(service, '阿明会来吗');
    assert.equal(result.resolutionStatus, 'ambiguous');
    assert.equal(result.candidates.length, 2);
  });

  test(`${label}: an Entity owned by someone else resolves as no_match`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_B, ENTITY_TEST_IDS.friendOne);
    const { service } = serviceFor(foundation, {
      '另一个人的实体': {
        kind: 'entity', mention: '另一个人的实体', entityId: ENTITY_TEST_IDS.friendOne
      }
    });
    const result = await resolve(service, '另一个人的实体');
    assert.equal(result.resolutionStatus, 'no_match');
    assert.equal(result.reason, 'no_owner_scoped_candidate');
  });

  test(`${label}: relation label can never become an Entity ID`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    const { service } = serviceFor(foundation, {
      '错误关系标签': { kind: 'entity', mention: '女儿', entityId: 'family:daughter' }
    });
    const result = await resolve(service, '错误关系标签');
    assert.equal(result.resolutionStatus, 'no_match');
    assert.equal(result.reason, 'invalid_ai_proposal');
  });

  test(`${label}: disabled alias no longer participates in resolution`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.friendOne);
    addAlias(foundation, '旧称呼', ENTITY_TEST_IDS.friendOne);
    foundation.aliases.disableAlias(OWNER_A, '旧称呼', ENTITY_TEST_IDS.friendOne, {
      expectedVersion: 1, updatedAt: NOW
    });
    const { service } = serviceFor(foundation, {
      '旧称呼会来吗': { kind: 'alias', mention: '旧称呼', alias: '旧称呼' }
    });
    assert.equal((await resolve(service, '旧称呼会来吗')).resolutionStatus, 'no_match');
  });

  test(`${label}: relation resolution honors half-open historical effective time`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    seedSelf(foundation);
    addEntity(foundation, OWNER_A, MOTHER);
    addRelation(foundation, 'rel_mother_hist1', MOTHER, {
      relationKind: 'parent', role: 'mother',
      effectiveFrom: '2020-01-01T00:00:00.000Z',
      effectiveTo: '2024-01-01T00:00:00.000Z',
      status: 'ended'
    });
    const { service } = serviceFor(foundation, {
      '当时我妈妈': { kind: 'relation', mention: '我妈妈', relationKind: 'parent', role: 'mother' }
    });
    assert.equal((await resolve(service, '当时我妈妈', {
      effectiveAt: '2023-12-31T23:59:59.999Z'
    })).resolutionStatus, 'exact');
    assert.equal((await resolve(service, '当时我妈妈', {
      effectiveAt: '2024-01-01T00:00:00.000Z'
    })).resolutionStatus, 'no_match');
  });

  test(`${label}: exact Entity context resolves a following pronoun`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    addAlias(foundation, '小雨', ENTITY_TEST_IDS.daughterOne);
    const { service } = serviceFor(foundation, {
      '我女儿小雨下周考试': { kind: 'alias', mention: '小雨', alias: '小雨' },
      '她最近有点紧张': { kind: 'context', mention: '她' }
    });
    assert.equal((await resolve(service, '我女儿小雨下周考试')).resolutionStatus, 'exact');
    const pronoun = await resolve(service, '她最近有点紧张');
    assert.equal(pronoun.resolutionStatus, 'exact');
    assert.equal(pronoun.entityId, ENTITY_TEST_IDS.daughterOne);
    assert.equal(pronoun.resolutionMethod, 'conversation_context');
  });

  test(`${label}: expired conversation context cannot resolve a pronoun`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    addAlias(foundation, '小雨', ENTITY_TEST_IDS.daughterOne);
    let time = Date.parse(NOW);
    const context = new ConversationEntityContext({ ttlMs: 1000, now: () => new Date(time).toISOString() });
    const { service } = serviceFor(foundation, {
      '先说小雨': { kind: 'alias', mention: '小雨', alias: '小雨' },
      '然后说她': { kind: 'context', mention: '她' }
    }, { context, now: () => new Date(time).toISOString() });
    assert.equal((await resolve(service, '先说小雨', { effectiveAt: new Date(time).toISOString() })).resolutionStatus, 'exact');
    time += 1001;
    assert.equal((await resolve(service, '然后说她', { effectiveAt: new Date(time).toISOString() })).resolutionStatus, 'no_match');
  });

  test(`${label}: owner and conversation boundaries invalidate Entity context`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    addAlias(foundation, '小雨', ENTITY_TEST_IDS.daughterOne);
    const { service } = serviceFor(foundation, {
      '先说小雨': { kind: 'alias', mention: '小雨', alias: '小雨' },
      '然后说她': { kind: 'context', mention: '她' }
    });
    assert.equal((await resolve(service, '先说小雨')).resolutionStatus, 'exact');
    assert.equal((await resolve(service, '然后说她', {
      ownerUserId: OWNER_B
    })).resolutionStatus, 'no_match');
    assert.equal((await resolve(service, '然后说她', {
      conversationId: 'conversation-new'
    })).resolutionStatus, 'no_match');
  });

  test(`${label}: Fake AI suggestion for a nonexistent Entity is rejected deterministically`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    const { service } = serviceFor(foundation, {
      'AI猜错了': { kind: 'entity', mention: '猜测', entityId: ENTITY_TEST_IDS.daughterTwo }
    });
    assert.equal((await resolve(service, 'AI猜错了')).resolutionStatus, 'no_match');
  });

  test(`${label}: AI cannot select the first candidate from an ambiguous relation`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    seedSelf(foundation);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.daughterTwo);
    addRelation(foundation, 'rel_daughter_0001', ENTITY_TEST_IDS.daughterOne);
    addRelation(foundation, 'rel_daughter_0002', ENTITY_TEST_IDS.daughterTwo);
    const { service } = serviceFor(foundation, {
      'AI选择第一个女儿': {
        kind: 'relation', mention: '我女儿', relationKind: 'child', role: 'daughter',
        suggestedEntityId: ENTITY_TEST_IDS.daughterOne
      }
    });
    assert.equal((await resolve(service, 'AI选择第一个女儿')).resolutionStatus, 'ambiguous');
  });

  test(`${label}: no_match never creates an Entity`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    const before = foundation.repository.listByOwner(OWNER_A).length;
    const { service } = serviceFor(foundation, {
      '从未见过的人': { kind: 'alias', mention: '从未见过的人', alias: '从未见过的人' }
    });
    assert.equal((await resolve(service, '从未见过的人')).resolutionStatus, 'no_match');
    assert.equal(foundation.repository.listByOwner(OWNER_A).length, before);
  });

  test(`${label}: resolution has no Memory write capability`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    addAlias(foundation, '小雨', ENTITY_TEST_IDS.daughterOne);
    const { service } = serviceFor(foundation, {
      '只解析小雨': { kind: 'alias', mention: '小雨', alias: '小雨' }
    });
    assert.equal((await resolve(service, '只解析小雨')).resolutionStatus, 'exact');
    assert.deepEqual(foundation.memories.queryByEntityAndPredicate(
      OWNER_A, ENTITY_TEST_IDS.daughterOne, 'birthday'
    ), []);
  });

  test(`${label}: name plus relation intersects candidates without widening scope`, async (t) => {
    const foundation = await openForTest(t, createHarness);
    seedSelf(foundation);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.daughterOne);
    addEntity(foundation, OWNER_A, ENTITY_TEST_IDS.friendOne);
    addAlias(foundation, '小雨', ENTITY_TEST_IDS.daughterOne);
    addAlias(foundation, '小雨', ENTITY_TEST_IDS.friendOne);
    addRelation(foundation, 'rel_daughter_0001', ENTITY_TEST_IDS.daughterOne);
    const { service } = serviceFor(foundation, {
      '我女儿小雨': {
        kind: 'alias_relation', mention: '我女儿小雨', alias: '小雨',
        relationKind: 'child', role: 'daughter'
      }
    });
    const result = await resolve(service, '我女儿小雨');
    assert.equal(result.resolutionStatus, 'exact');
    assert.equal(result.entityId, ENTITY_TEST_IDS.daughterOne);
    assert.equal(result.resolutionMethod, 'alias_relation');
  });
}
