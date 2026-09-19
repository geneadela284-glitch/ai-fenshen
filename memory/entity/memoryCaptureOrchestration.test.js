import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ENTITY_TEST_IDS,
  fakeEntity,
  fakeEntityRelation,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';
import { FakeAIEntityResolver } from '../../testing/fakeAIEntityResolver.js';
import { FakeAIMemoryClassifier } from '../../testing/fakeAIMemoryClassifier.js';
import { FakeBusinessRecordAdapter } from '../../testing/fakeBusinessRecordAdapter.js';
import { createEntityResolutionService } from './entityResolutionService.js';
import { ConversationEntityContext } from './conversationEntityContext.js';
import { createInMemoryEntityFoundation } from './inMemoryFoundation.js';
import { createMemoryCaptureDecisionService } from './memoryCaptureDecisionService.js';
import { createSQLiteEntityFoundation } from './sqliteFoundation.js';

const Orchestration = await import('./memoryCaptureOrchestrator.js').catch(() => ({}));
const SafeWrite = await import('./memorySafeWriteService.js').catch(() => ({}));
const Stores = await import('./memoryCaptureStores.js').catch(() => ({}));

const OWNER = ENTITY_TEST_IDS.owner;
const MOTHER = ENTITY_TEST_IDS.friendOne;
const NOW = '2026-07-17T10:00:00.000Z';
const TEXT = Object.freeze({
  birthday: '我妈妈5月6号生日。',
  changedBirthday: '我妈妈生日是5月8号。',
  sensitive: '我妈妈的生日可能是5月6号。',
  answer: '我妈妈什么时候生日？',
  ignore: '我刚喝了一口水。',
  temporary: '这几天我在出差。',
  ambiguous: '我女儿下周考试。',
  noMatch: '陌生人下周考试。',
  business: '买菜100元。'
});

function proposal(overrides = {}) {
  return {
    proposedDecision: 'store_silently',
    memoryType: 'fact',
    predicate: 'birthday',
    confidence: 0.98,
    importance: 0.8,
    sensitivity: 'low',
    retentionPolicy: { mode: 'long_term', expiresAt: null },
    reasonCodes: ['long_term_personal_fact'],
    suggestedStructuredValue: { date: '1968-05-06' },
    containsPersonalFact: true,
    needsClarification: false,
    explicitBusinessIntent: false,
    ...structuredClone(overrides)
  };
}

function classifierProposals() {
  return {
    [TEXT.birthday]: proposal(),
    [TEXT.changedBirthday]: proposal({ suggestedStructuredValue: { date: '1968-05-08' } }),
    [TEXT.sensitive]: proposal({
      proposedDecision: 'confirm_before_store',
      confidence: 0.7,
      sensitivity: 'high',
      reasonCodes: ['sensitive_information'],
      needsClarification: true
    }),
    [TEXT.answer]: proposal({
      proposedDecision: 'answer_only', memoryType: null, predicate: null,
      importance: 0, retentionPolicy: { mode: 'none', expiresAt: null },
      reasonCodes: ['information_query'], suggestedStructuredValue: null,
      containsPersonalFact: false
    }),
    [TEXT.ignore]: proposal({
      proposedDecision: 'ignore', memoryType: null, predicate: null,
      importance: 0.05, retentionPolicy: { mode: 'none', expiresAt: null },
      reasonCodes: ['low_long_term_value'], suggestedStructuredValue: null,
      containsPersonalFact: false
    }),
    [TEXT.temporary]: proposal({
      proposedDecision: 'temporary_context', memoryType: 'temporary_context',
      predicate: 'temporary_presence', importance: 0.4,
      retentionPolicy: { mode: 'ttl', expiresAt: '2026-07-21T00:00:00.000Z' },
      reasonCodes: ['time_bounded_context'],
      suggestedStructuredValue: { summary: '用户正在出差', expiresAt: '2026-07-21T00:00:00.000Z' }
    }),
    [TEXT.ambiguous]: proposal(),
    [TEXT.noMatch]: proposal(),
    [TEXT.business]: proposal({
      proposedDecision: 'business_record', memoryType: 'financial_record',
      predicate: 'financial_transaction', importance: 0.7,
      retentionPolicy: { mode: 'business_record', expiresAt: null },
      reasonCodes: ['explicit_business_record'],
      suggestedStructuredValue: { direction: 'expense', amount: 100, currency: 'CNY', category: 'groceries' },
      explicitBusinessIntent: true
    })
  };
}

function seed(foundation) {
  const entity = (entityId, metadata = {}) => foundation.repository.create(OWNER, fakeEntity({
    ownerUserId: OWNER,
    entityId,
    metadata,
    source: { type: 'user_confirmed', id: `entity-${entityId}` }
  }));
  entity(ENTITY_TEST_IDS.self, { entityRole: 'self' });
  entity(MOTHER);
  entity(ENTITY_TEST_IDS.daughterOne);
  entity(ENTITY_TEST_IDS.daughterTwo);
  const relation = (relationId, targetEntityId, relationKind, role) =>
    foundation.relations.createRelation(OWNER, fakeEntityRelation({
      relationId, targetEntityId, relationKind, role,
      source: { type: 'user_confirmed', id: relationId }
    }));
  relation('rel_mother_s3c1', MOTHER, 'parent', 'mother');
  relation('rel_daughter_s3c1', ENTITY_TEST_IDS.daughterOne, 'child', 'daughter');
  relation('rel_daughter_s3c2', ENTITY_TEST_IDS.daughterTwo, 'child', 'daughter');
}

function resolutionProposals() {
  return {
    [TEXT.birthday]: { kind: 'relation', mention: '我妈妈', relationKind: 'parent', role: 'mother' },
    [TEXT.changedBirthday]: { kind: 'relation', mention: '我妈妈', relationKind: 'parent', role: 'mother' },
    [TEXT.sensitive]: { kind: 'relation', mention: '我妈妈', relationKind: 'parent', role: 'mother' },
    [TEXT.answer]: { kind: 'relation', mention: '我妈妈', relationKind: 'parent', role: 'mother' },
    [TEXT.ignore]: { kind: 'self', mention: '我' },
    [TEXT.temporary]: { kind: 'self', mention: '我' },
    [TEXT.ambiguous]: { kind: 'relation', mention: '我女儿', relationKind: 'child', role: 'daughter' },
    [TEXT.noMatch]: { kind: 'alias', mention: '陌生人', alias: '陌生人' },
    [TEXT.business]: { kind: 'self', mention: '我' }
  };
}

async function runtimeFor(foundation, options = {}) {
  assert.equal(typeof SafeWrite.createMemoryDuplicateConflictInspector, 'function');
  assert.equal(typeof SafeWrite.createMemorySafeWriteService, 'function');
  assert.equal(typeof Stores.createMemoryCaptureStores, 'function');
  assert.equal(typeof Orchestration.createMemoryCaptureOrchestrator, 'function');
  seed(foundation);
  const aiResolver = new FakeAIEntityResolver(resolutionProposals());
  const classifier = new FakeAIMemoryClassifier(classifierProposals());
  const businessRecordAdapter = options.businessRecordAdapter ?? new FakeBusinessRecordAdapter({ now: () => NOW });
  const resolutionService = createEntityResolutionService({
    repository: foundation.repository,
    aliases: foundation.aliases,
    relations: foundation.relations,
    aiResolver,
    conversationContext: new ConversationEntityContext({ now: () => NOW }),
    now: () => NOW
  });
  const inspector = SafeWrite.createMemoryDuplicateConflictInspector({ memories: foundation.memories });
  const decisionService = createMemoryCaptureDecisionService({ classifier, inspector, now: () => NOW });
  let memorySequence = 0;
  const safeWriteService = SafeWrite.createMemorySafeWriteService({
    foundation,
    inspector,
    now: () => NOW,
    memoryIdFactory: () => `memory-s3c-${String(++memorySequence).padStart(4, '0')}`
  });
  const stores = Stores.createMemoryCaptureStores({ now: () => NOW });
  const orchestrator = Orchestration.createMemoryCaptureOrchestrator({
    resolutionService,
    decisionService,
    safeWriteService,
    pendingCandidates: stores.pendingCandidates,
    temporaryContexts: stores.temporaryContexts,
    businessRecordAdapter,
    now: () => NOW
  });
  return {
    orchestrator,
    stores,
    businessRecordAdapter,
    aiResolver,
    classifier,
    inspector,
    safeWriteService,
    decisionService
  };
}

function capture(orchestrator, text, idempotencyKey = `capture:${text}`) {
  return orchestrator.process({
    ownerUserId: OWNER,
    text,
    locale: 'zh-CN',
    conversationId: 'conversation-s3c',
    idempotencyKey
  });
}

function memories(foundation, status = 'confirmed') {
  return foundation.memories.queryByEntityAndPredicate(OWNER, MOTHER, 'birthday', { status });
}

export function registerConformance(label, createHarness) {
  test(`${label}: store_silently writes one MemoryRecordV2 with no acknowledgement`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    const result = await capture(runtime.orchestrator, TEXT.birthday);
    assert.equal(result.outcome, 'memory_written');
    assert.equal(result.acknowledgement, 'none');
    assert.equal('acknowledgementText' in result, false);
    assert.equal(memories(harness.foundation).length, 1);
  });

  test(`${label}: answer_only and ignore never write formal Memory`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    assert.equal((await capture(runtime.orchestrator, TEXT.answer)).outcome, 'answer_only');
    assert.equal((await capture(runtime.orchestrator, TEXT.ignore)).outcome, 'ignored');
    assert.equal(memories(harness.foundation).length, 0);
    assert.equal(runtime.stores.pendingCandidates.size(OWNER), 0);
  });

  test(`${label}: temporary_context is TTL-scoped and never enters formal Memory`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    const result = await capture(runtime.orchestrator, TEXT.temporary);
    assert.equal(result.outcome, 'temporary_context_stored');
    assert.equal(runtime.stores.temporaryContexts.listActive(OWNER).length, 1);
    assert.equal(memories(harness.foundation).length, 0);
  });

  test(`${label}: ambiguous and no_match Entity resolution fail closed without candidates or writes`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    assert.equal((await capture(runtime.orchestrator, TEXT.ambiguous)).outcome, 'resolution_required');
    assert.equal((await capture(runtime.orchestrator, TEXT.noMatch)).outcome, 'resolution_required');
    assert.equal(runtime.stores.pendingCandidates.size(OWNER), 0);
    assert.equal(memories(harness.foundation).length, 0);
  });

  test(`${label}: confirm_before_store creates only a pending candidate`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    const result = await capture(runtime.orchestrator, TEXT.sensitive);
    assert.equal(result.outcome, 'confirmation_required');
    assert.equal(typeof result.confirmationToken, 'string');
    assert.equal(typeof result.confirmationQuestion, 'string');
    assert.equal(memories(harness.foundation).length, 0);
    assert.equal(runtime.stores.pendingCandidates.size(OWNER), 1);
  });

  test(`${label}: accepting or rejecting a pending candidate is owner-scoped and deterministic`, async (t) => {
    const acceptedHarness = await createHarness(t);
    const accepted = await runtimeFor(acceptedHarness.foundation);
    const pending = await capture(accepted.orchestrator, TEXT.sensitive);
    await assert.rejects(
      accepted.orchestrator.confirm({ ownerUserId: 'other-owner', confirmationToken: pending.confirmationToken, accepted: true }),
      /owner/i
    );
    const stored = await accepted.orchestrator.confirm({
      ownerUserId: OWNER, confirmationToken: pending.confirmationToken, accepted: true
    });
    assert.equal(stored.outcome, 'memory_written');
    assert.equal(memories(acceptedHarness.foundation).length, 1);

    const rejectedHarness = await createHarness(t);
    const rejected = await runtimeFor(rejectedHarness.foundation);
    const rejectedPending = await capture(rejected.orchestrator, TEXT.sensitive);
    const result = await rejected.orchestrator.confirm({
      ownerUserId: OWNER, confirmationToken: rejectedPending.confirmationToken, accepted: false
    });
    assert.equal(result.outcome, 'candidate_rejected');
    assert.equal(memories(rejectedHarness.foundation).length, 0);
    assert.equal(rejected.stores.pendingCandidates.size(OWNER), 0);
  });

  test(`${label}: business_record acknowledges only a real successful adapter commit`, async (t) => {
    const successHarness = await createHarness(t);
    const success = await runtimeFor(successHarness.foundation);
    const committed = await capture(success.orchestrator, TEXT.business, 'business-success');
    assert.equal(committed.outcome, 'business_record_committed');
    assert.equal(committed.acknowledgement, '已记录');
    assert.equal(success.businessRecordAdapter.records.length, 1);

    const failureHarness = await createHarness(t);
    const adapter = new FakeBusinessRecordAdapter({ now: () => NOW, fail: true });
    const failure = await runtimeFor(failureHarness.foundation, { businessRecordAdapter: adapter });
    const failed = await capture(failure.orchestrator, TEXT.business, 'business-failure');
    assert.equal(failed.outcome, 'business_commit_failed');
    assert.equal(failed.acknowledgement, 'none');
    assert.equal(JSON.stringify(failed).includes('已记录'), false);
  });

  test(`${label}: exact fact duplicate is detected without a second write`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    await capture(runtime.orchestrator, TEXT.birthday, 'birthday-first');
    const duplicate = await capture(runtime.orchestrator, TEXT.birthday, 'birthday-second');
    assert.equal(duplicate.outcome, 'duplicate_detected');
    assert.equal(memories(harness.foundation).length, 1);
  });

  test(`${label}: short-window business duplicate requires explicit confirmation`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    await capture(runtime.orchestrator, TEXT.business, 'business-first');
    const duplicate = await capture(runtime.orchestrator, TEXT.business, 'business-second');
    assert.equal(duplicate.outcome, 'confirmation_required');
    assert.equal(runtime.businessRecordAdapter.records.length, 1);
    const committed = await runtime.orchestrator.confirm({
      ownerUserId: OWNER, confirmationToken: duplicate.confirmationToken, accepted: true
    });
    assert.equal(committed.acknowledgement, '已记录');
    assert.equal(runtime.businessRecordAdapter.records.length, 2);
  });

  test(`${label}: conflicting fact cannot overwrite silently and confirmation creates a correction chain`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    const original = await capture(runtime.orchestrator, TEXT.birthday, 'birthday-original');
    const conflict = await capture(runtime.orchestrator, TEXT.changedBirthday, 'birthday-correction');
    assert.equal(conflict.outcome, 'confirmation_required');
    assert.equal(memories(harness.foundation).length, 1);
    const corrected = await runtime.orchestrator.confirm({
      ownerUserId: OWNER, confirmationToken: conflict.confirmationToken, accepted: true
    });
    assert.equal(corrected.outcome, 'memory_written');
    assert.equal(corrected.memory.supersedesId, original.memory.memoryId);
    assert.equal(memories(harness.foundation).length, 1);
    assert.equal(memories(harness.foundation, 'archived').length, 1);
  });

  test(`${label}: invalid structured value and owner mismatch never enter Unit of Work`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    runtime.classifier.set(TEXT.birthday, proposal({ suggestedStructuredValue: { year: 1968 } }));
    assert.equal((await capture(runtime.orchestrator, TEXT.birthday, 'invalid-value')).outcome, 'candidate_rejected');
    const decision = await runtime.decisionService.decide({
      ownerUserId: OWNER,
      text: TEXT.birthday,
      locale: 'zh-CN',
      entityResolution: {
        resolutionStatus: 'exact', ownerUserId: OWNER, entityId: MOTHER,
        entityType: 'person', evidence: [], confidence: 1,
        resolutionMethod: 'test', resolvedAt: NOW
      },
      conversationContext: null
    });
    await assert.rejects(runtime.safeWriteService.write({
      ownerUserId: OWNER,
      resolution: {
        resolutionStatus: 'exact', ownerUserId: 'other-owner', entityId: MOTHER,
        entityType: 'person', evidence: [], confidence: 1,
        resolutionMethod: 'malicious', resolvedAt: NOW
      },
      decision,
      idempotencyKey: 'owner-mismatch'
    }), /owner-scoped/i);
    assert.equal(memories(harness.foundation).length, 0);
  });

  test(`${label}: Unit of Work failure rolls back the archived side of a correction`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    harness.foundation.memories.create(OWNER, fakeMemoryRecordV2({
      memoryId: 'memory-s3c-0002', subjectEntityId: MOTHER, status: 'archived'
    }), { resolution: {
      schemaVersion: 'v2', resolutionStatus: 'exact', ownerUserId: OWNER,
      entityType: 'person', entityId: MOTHER, relationKind: 'parent', role: 'mother',
      predicate: 'birthday', candidateEntityIds: [], sourceRelationIds: ['rel_mother_s3c1'],
      resolutionReason: 'test', policyVersion: 'entity-resolution-v2', resolvedAt: NOW
    }});
    const original = await capture(runtime.orchestrator, TEXT.birthday, 'rollback-original');
    const conflict = await capture(runtime.orchestrator, TEXT.changedBirthday, 'rollback-correction');
    await assert.rejects(runtime.orchestrator.confirm({
      ownerUserId: OWNER, confirmationToken: conflict.confirmationToken, accepted: true
    }), /already exists/i);
    assert.equal(harness.foundation.memories.getById(OWNER, original.memory.memoryId).status, 'confirmed');
  });

  test(`${label}: concurrent idempotency replay produces one confirmed Memory`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    const results = await Promise.all([
      capture(runtime.orchestrator, TEXT.birthday, 'same-idempotency-key'),
      capture(runtime.orchestrator, TEXT.birthday, 'same-idempotency-key')
    ]);
    assert.equal(results.every((result) => ['memory_written', 'duplicate_detected'].includes(result.outcome)), true);
    assert.equal(memories(harness.foundation).length, 1);
  });

  test(`${label}: AI helpers receive no Repository, database, or write capability`, async (t) => {
    const harness = await createHarness(t);
    const runtime = await runtimeFor(harness.foundation);
    await capture(runtime.orchestrator, TEXT.birthday);
    for (const call of [...runtime.aiResolver.calls, ...runtime.classifier.calls]) {
      assert.equal('repository' in call, false);
      assert.equal('database' in call, false);
      assert.equal('unitOfWork' in call, false);
      assert.equal('write' in call, false);
    }
  });
}

registerConformance('InMemory Capture Orchestration', async () => ({
  foundation: createInMemoryEntityFoundation({ now: () => NOW })
}));

registerConformance('Shadow SQLite Capture Orchestration', async (t) => {
  const shadowRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiwc-entity-shadow-s3c-'));
  const databasePath = path.join(shadowRoot, 'capture-orchestration.sqlite');
  const foundation = createSQLiteEntityFoundation({
    shadowRoot, databasePath, repositoryRoot: process.cwd(), now: () => NOW
  });
  t.after(() => {
    foundation.close();
    fs.rmSync(shadowRoot, { recursive: true, force: true });
  });
  return { foundation, databasePath };
});

test('Shadow SQLite confirmed Memory survives close and reopen', async (t) => {
  assert.equal(typeof Orchestration.createMemoryCaptureOrchestrator, 'function');
  const shadowRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'aiwc-entity-shadow-s3c-restart-'));
  const databasePath = path.join(shadowRoot, 'capture-restart.sqlite');
  let foundation = createSQLiteEntityFoundation({ shadowRoot, databasePath, repositoryRoot: process.cwd(), now: () => NOW });
  const runtime = await runtimeFor(foundation);
  await capture(runtime.orchestrator, TEXT.birthday);
  foundation.close();
  foundation = createSQLiteEntityFoundation({ shadowRoot, databasePath, repositoryRoot: process.cwd(), now: () => NOW });
  assert.equal(memories(foundation).length, 1);
  t.after(() => {
    foundation.close();
    fs.rmSync(shadowRoot, { recursive: true, force: true });
  });
});

test('pending candidate snapshots are deeply immutable', async () => {
  const foundation = createInMemoryEntityFoundation({ now: () => NOW });
  const runtime = await runtimeFor(foundation);
  const pending = await capture(runtime.orchestrator, TEXT.sensitive);
  const snapshot = runtime.stores.pendingCandidates.get(OWNER, pending.confirmationToken);
  assert.throws(() => {
    snapshot.candidate.decision.sensitivity = 'low';
  }, TypeError);
  assert.equal(
    runtime.stores.pendingCandidates.get(OWNER, pending.confirmationToken).candidate.decision.sensitivity,
    'high'
  );
});

test('business adapter exception never produces a success acknowledgement', async () => {
  const foundation = createInMemoryEntityFoundation({ now: () => NOW });
  const adapter = new FakeBusinessRecordAdapter({ now: () => NOW });
  adapter.commit = () => { throw new Error('adapter unavailable'); };
  const runtime = await runtimeFor(foundation, { businessRecordAdapter: adapter });
  const result = await capture(runtime.orchestrator, TEXT.business, 'business-throws');
  assert.equal(result.outcome, 'business_commit_failed');
  assert.equal(result.acknowledgement, 'none');
  assert.equal(JSON.stringify(result).includes('已记录'), false);
});
