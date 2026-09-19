import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { PREDICATE_STRUCTURED_VALUE_SCHEMAS } from '../entity/contracts.js';
import { fakeMemoryRecordV2 } from '../../testing/entityFixtures.js';
import { createFakeConversationHarness } from './fakeConversationHarness.js';

async function open(t, createBackend, options = {}) {
  const backend = await createBackend();
  const harness = createFakeConversationHarness({ backend, ...options });
  await harness.initialize();
  t.after(async () => harness.close());
  return harness;
}

function currentBirthday(harness, ownerUserId, subjectEntityId) {
  return harness.listMemories({ ownerUserId, subjectEntityId, status: 'confirmed' })[0] ?? null;
}

export function registerMemoryRecallE2EConformance(label, createBackend, {
  sqliteRestart = false,
  repositoryRoot
} = {}) {
  test(`${label}: mother birthday is stored silently and a fresh conversation answers from evidence`, async (t) => {
    const harness = await open(t, createBackend);
    const stored = await harness.capture(harness.text.motherBirthday, { idempotencyKey: 'mother:first' });
    assert.equal(stored.outcome, 'memory_written');
    assert.equal(stored.acknowledgement, 'none');
    assert.equal(JSON.stringify(stored).includes('我记住了'), false);
    const answer = await harness.recall(harness.text.askMotherBirthday, { conversationId: 'conversation-fresh' });
    assert.equal(answer.outcome, 'fact');
    assert.equal(answer.safeAnswer.safeUserMessage, '5月6号。');
    assert.equal(answer.sourceMode, 'v2');
    assert.equal(answer.groundingResult.evidenceMemoryIds.length, 1);
  });

  test(`${label}: two daughters clarify relation-only input and exact alias never crosses Entity`, async (t) => {
    const harness = await open(t, createBackend);
    const ambiguous = await harness.capture(harness.text.ambiguousDaughterBirthday, { idempotencyKey: 'daughter:ambiguous' });
    assert.equal(ambiguous.outcome, 'resolution_required');
    assert.equal(ambiguous.resolutionStatus, 'ambiguous');
    assert.equal(harness.listMemories({ ownerUserId: harness.owners.a }).length, 0);
    const rain = await harness.capture(harness.text.rainBirthday, { idempotencyKey: 'daughter:rain' });
    const snow = await harness.capture(harness.text.snowBirthday, { idempotencyKey: 'daughter:snow' });
    assert.equal(rain.acknowledgement, 'none');
    assert.equal(snow.acknowledgement, 'none');
    const answer = await harness.recall(harness.text.askRainBirthday, { conversationId: 'daughter:new' });
    assert.equal(answer.safeAnswer.safeUserMessage, '5月10号。');
    assert.equal(answer.groundingResult.subjectEntityId, harness.entityIds.a.daughterRain);
    assert.equal(answer.page.items.some((item) => item.subjectEntityId === harness.entityIds.a.daughterSnow), false);
  });

  test(`${label}: same-name friends stay ambiguous until deterministic contextual alias is supplied`, async (t) => {
    const harness = await open(t, createBackend);
    const ambiguous = await harness.capture(harness.text.ambiguousLinBirthday, { idempotencyKey: 'lin:ambiguous' });
    assert.equal(ambiguous.outcome, 'resolution_required');
    assert.equal(ambiguous.resolutionStatus, 'ambiguous');
    const college = await harness.capture(harness.text.collegeLinBirthday, { idempotencyKey: 'lin:college' });
    const neighbor = await harness.capture(harness.text.neighborLinBirthday, { idempotencyKey: 'lin:neighbor' });
    assert.equal(college.outcome, 'memory_written');
    assert.equal(neighbor.outcome, 'memory_written');
    const answer = await harness.recall(harness.text.askCollegeLinBirthday, { conversationId: 'lin:new' });
    assert.equal(answer.safeAnswer.safeUserMessage, '5月12号。');
    assert.equal(answer.groundingResult.subjectEntityId, harness.entityIds.a.friendCollege);
    assert.notEqual(answer.groundingResult.subjectEntityId, harness.entityIds.a.friendNeighbor);
  });

  test(`${label}: exact duplicates and concurrent idempotency replays create one confirmed Memory`, async (t) => {
    const harness = await open(t, createBackend);
    const [first, replay] = await Promise.all([
      harness.capture(harness.text.motherBirthday, { idempotencyKey: 'mother:concurrent' }),
      harness.capture(harness.text.motherBirthday, { idempotencyKey: 'mother:concurrent' })
    ]);
    assert.ok(['memory_written', 'duplicate_detected'].includes(first.outcome));
    assert.ok(['memory_written', 'duplicate_detected'].includes(replay.outcome));
    const duplicate = await harness.capture(harness.text.motherBirthday, { idempotencyKey: 'mother:second-key' });
    assert.equal(duplicate.outcome, 'duplicate_detected');
    assert.equal(duplicate.acknowledgement, 'none');
    assert.equal(harness.listMemories({ ownerUserId: harness.owners.a, subjectEntityId: harness.entityIds.a.mother, status: 'confirmed' }).length, 1);
  });

  test(`${label}: confirmed correction keeps Entity scope and separates current from historical answers`, async (t) => {
    const harness = await open(t, createBackend);
    await harness.capture(harness.text.motherBirthday, { idempotencyKey: 'correction:original' });
    const original = currentBirthday(harness, harness.owners.a, harness.entityIds.a.mother);
    harness.advanceTo('2026-07-18T10:00:00.000Z');
    const pending = await harness.capture(harness.text.correctMotherBirthday, { idempotencyKey: 'correction:new' });
    assert.equal(pending.outcome, 'confirmation_required');
    const corrected = await harness.confirm(pending.confirmationToken, { ownerUserId: harness.owners.a, accepted: true });
    assert.equal(corrected.outcome, 'corrected');
    const replacement = harness.getMemory(corrected.memoryId, harness.owners.a);
    assert.equal(replacement.subjectEntityId, original.subjectEntityId);
    assert.equal(replacement.supersedesId, original.memoryId);
    const current = await harness.recall(harness.text.askMotherBirthday, { conversationId: 'correction:current' });
    const historical = await harness.recall(harness.text.askMotherBirthday, {
      conversationId: 'correction:historical', readMode: 'historical', effectiveAt: '2026-07-17T12:00:00.000Z'
    });
    assert.equal(current.safeAnswer.safeUserMessage, '5月8号。');
    assert.equal(historical.safeAnswer.safeUserMessage, '5月6号。');
  });

  test(`${label}: delete removes current recall and V2 tombstone suppresses Legacy fallback`, async (t) => {
    const harness = await open(t, createBackend, { legacyMode: 'deterministic' });
    await harness.capture(harness.text.motherBirthday, { idempotencyKey: 'delete:seed' });
    const memory = currentBirthday(harness, harness.owners.a, harness.entityIds.a.mother);
    await harness.lifecycle('delete', { memoryId: memory.memoryId, expectedVersion: memory.version, idempotencyKey: 'delete:once' });
    const result = await harness.recall(harness.text.askMotherBirthday, { conversationId: 'delete:new' });
    assert.equal(result.outcome, 'not_found');
    assert.equal(result.safeAnswer.safeUserMessage, '我目前没有找到这项记录。');
    assert.equal(result.v2Presence.suppressLegacy, true);
    assert.equal(harness.traces.legacy.length, 0);
  });

  test(`${label}: restore re-enables exact recall without releasing Legacy suppression`, async (t) => {
    const harness = await open(t, createBackend, { legacyMode: 'deterministic' });
    await harness.capture(harness.text.motherBirthday, { idempotencyKey: 'restore:seed' });
    let memory = currentBirthday(harness, harness.owners.a, harness.entityIds.a.mother);
    await harness.lifecycle('delete', { memoryId: memory.memoryId, expectedVersion: memory.version, idempotencyKey: 'restore:delete' });
    memory = harness.getMemory(memory.memoryId, harness.owners.a);
    const restored = await harness.lifecycle('restore', { memoryId: memory.memoryId, expectedVersion: memory.version, idempotencyKey: 'restore:once' });
    assert.equal(restored.outcome, 'restored');
    const result = await harness.recall(harness.text.askMotherBirthday, { conversationId: 'restore:new' });
    assert.equal(result.safeAnswer.safeUserMessage, '5月6号。');
    assert.equal(result.sourceMode, 'v2');
    assert.equal(harness.traces.legacy.length, 0);
  });

  test(`${label}: purge destroys current and historical bodies, blocks restore, and suppresses Legacy`, async (t) => {
    const harness = await open(t, createBackend, { legacyMode: 'deterministic' });
    await harness.capture(harness.text.motherBirthday, { idempotencyKey: 'purge:seed' });
    const memory = currentBirthday(harness, harness.owners.a, harness.entityIds.a.mother);
    const purged = await harness.lifecycle('purge', {
      memoryId: memory.memoryId, expectedVersion: memory.version, idempotencyKey: 'purge:once', confirmed: true
    });
    assert.equal(purged.outcome, 'purged');
    const current = await harness.recall(harness.text.askMotherBirthday, { conversationId: 'purge:current' });
    const historical = await harness.recall(harness.text.askMotherBirthday, {
      conversationId: 'purge:history', readMode: 'historical', effectiveAt: '2026-07-17T12:00:00.000Z'
    });
    assert.equal(current.outcome, 'not_found');
    assert.equal(historical.outcome, 'not_found');
    const marker = harness.getMemory(memory.memoryId, harness.owners.a);
    assert.equal(Object.hasOwn(marker, 'structuredValue'), false);
    assert.equal(JSON.stringify(marker).includes('1960-05-06'), false);
    await assert.rejects(
      harness.lifecycle('restore', { memoryId: memory.memoryId, expectedVersion: marker.version, idempotencyKey: 'purge:restore' }),
      (error) => error?.code === 'MEMORY_PURGED'
    );
    assert.equal(harness.traces.legacy.length, 0);
  });

  test(`${label}: missing father birthday is not guessed`, async (t) => {
    const harness = await open(t, createBackend);
    const result = await harness.recall(harness.text.askFatherBirthday, { conversationId: 'father:new' });
    assert.equal(result.outcome, 'not_found');
    assert.equal(result.safeAnswer.safeUserMessage, '我目前没有找到这项记录。');
    assert.equal(result.safeAnswer.immutableFact, null);
  });

  test(`${label}: only deterministic Legacy mapping can become grounded evidence`, async (t) => {
    const trusted = await open(t, createBackend, { legacyMode: 'deterministic' });
    const fact = await trusted.recall(trusted.text.askMotherBirthday, { conversationId: 'legacy:trusted' });
    assert.equal(fact.outcome, 'fact');
    assert.equal(fact.sourceMode, 'legacy');
    assert.equal(fact.safeAnswer.safeUserMessage, '5月6号。');
    const unsafe = await open(t, createBackend, { legacyMode: 'review_required' });
    const rejected = await unsafe.recall(unsafe.text.askMotherBirthday, { conversationId: 'legacy:unsafe' });
    assert.equal(rejected.outcome, 'evidence_invalid');
    assert.equal(rejected.errorCode, 'LEGACY_MAPPING_UNSAFE');
    assert.equal(rejected.safeAnswer.type, 'evidence_invalid');
  });

  test(`${label}: Safe Answer verification rejects AI date, Entity, and not-found mutations`, async (t) => {
    const harness = await open(t, createBackend);
    await harness.capture(harness.text.motherBirthday, { idempotencyKey: 'tamper:seed' });
    const fact = await harness.recall(harness.text.askMotherBirthday, { conversationId: 'tamper:fact' });
    const changedDate = structuredClone(fact.safeAnswer);
    changedDate.safeUserMessage = '5月8号。';
    changedDate.immutableFact.date = '1960-05-08';
    assert.throws(() => harness.verifyAIProposal(fact.safeAnswer, changedDate), (error) => error?.code === 'EVIDENCE_INVALID');
    const changedEntity = structuredClone(fact.safeAnswer);
    changedEntity.subjectEntityId = harness.entityIds.a.daughterRain;
    assert.throws(() => harness.verifyAIProposal(fact.safeAnswer, changedEntity), (error) => error?.code === 'EVIDENCE_INVALID');
    const missing = await harness.recall(harness.text.askFatherBirthday, { conversationId: 'tamper:missing' });
    const guessed = structuredClone(missing.safeAnswer);
    guessed.safeUserMessage = '可能是5月6号。';
    assert.throws(() => harness.verifyAIProposal(missing.safeAnswer, guessed), (error) => error?.code === 'EVIDENCE_INVALID');
  });

  test(`${label}: Fake Business Record acknowledges only committed writes and confirms short-window duplicates`, async (t) => {
    const harness = await open(t, createBackend);
    const committed = await harness.capture(harness.text.businessRecord, { idempotencyKey: 'business:first' });
    assert.equal(committed.outcome, 'business_record_committed');
    assert.equal(committed.acknowledgement, '已记录');
    const duplicate = await harness.capture(harness.text.businessRecord, { idempotencyKey: 'business:second' });
    assert.equal(duplicate.outcome, 'confirmation_required');
    assert.equal(harness.businessRecordAdapter.records.length, 1);
    await harness.confirm(duplicate.confirmationToken, { ownerUserId: harness.owners.a, accepted: true });
    assert.equal(harness.businessRecordAdapter.records.length, 2);
    const failing = await open(t, createBackend, { businessFailure: true });
    const failed = await failing.capture(failing.text.businessRecord, { idempotencyKey: 'business:failure' });
    assert.equal(failed.outcome, 'business_commit_failed');
    assert.equal(failed.acknowledgement, 'none');
    assert.equal(JSON.stringify(failed).includes('已记录'), false);
  });

  test(`${label}: owner and conversation contexts never cross security boundaries`, async (t) => {
    const harness = await open(t, createBackend);
    await harness.capture(harness.text.motherBirthday, {
      ownerUserId: harness.owners.b, conversationId: 'shared-conversation', idempotencyKey: 'owner-b:mother'
    });
    const ownerA = await harness.recall(harness.text.askMotherBirthday, {
      ownerUserId: harness.owners.a, conversationId: 'shared-conversation'
    });
    assert.equal(ownerA.outcome, 'not_found');
    const directOtherEntity = await harness.recall(harness.text.askOtherOwnerMotherBirthday, {
      ownerUserId: harness.owners.a, conversationId: 'owner-a:direct'
    });
    assert.equal(directOtherEntity.outcome, 'no_match');
    assert.equal(directOtherEntity.safeAnswer.safeUserMessage, '我目前没有找到这项记录。');
    const contextLeak = await harness.recall(harness.text.askContextBirthday, {
      ownerUserId: harness.owners.a, conversationId: 'shared-conversation'
    });
    assert.equal(contextLeak.outcome, 'not_found');
    assert.equal(contextLeak.resolution.entityId, harness.entityIds.a.mother);
    assert.notEqual(contextLeak.resolution.entityId, harness.entityIds.b.mother);
  });

  test(`${label}: opaque cursors reject cross-owner and cross-Entity reuse`, async (t) => {
    const harness = await open(t, createBackend);
    await harness.capture(harness.text.motherBirthday, { idempotencyKey: 'cursor:mother' });
    const first = currentBirthday(harness, harness.owners.a, harness.entityIds.a.mother);
    harness.foundation.memories.create(harness.owners.a, fakeMemoryRecordV2({
      memoryId: 'memory-e2e-cursor-second', ownerUserId: harness.owners.a,
      subjectEntityId: harness.entityIds.a.mother, structuredValue: { date: '1961-05-06' },
      displayValue: '5月6号', createdAt: '2026-07-17T09:00:00.000Z', updatedAt: '2026-07-17T09:00:00.000Z',
      effectiveFrom: '2026-07-17T09:00:00.000Z', sourceTimestamp: '2026-07-17T09:00:00.000Z',
      source: { type: 'user_confirmed', id: 'cursor-second' }
    }));
    assert.ok(first);
    const page = await harness.queryPage(harness.text.askMotherBirthday, { limit: 1 });
    assert.equal(typeof page.page.nextCursor, 'string');
    await assert.rejects(
      harness.queryPage(harness.text.askMotherBirthday, {
        ownerUserId: harness.owners.b, cursor: page.page.nextCursor, limit: 1
      }),
      (error) => error?.code === 'CURSOR_SCOPE_MISMATCH'
    );
    await assert.rejects(
      harness.queryPage(harness.text.askRainBirthday, { cursor: page.page.nextCursor, limit: 1 }),
      (error) => error?.code === 'CURSOR_SCOPE_MISMATCH'
    );
  });

  test(`${label}: Ranking receives only exact Repository candidates and Grounding rereads evidence`, async (t) => {
    const harness = await open(t, createBackend);
    await harness.capture(harness.text.motherBirthday, { idempotencyKey: 'scope:mother' });
    await harness.capture(harness.text.rainBirthday, { idempotencyKey: 'scope:rain' });
    const result = await harness.recall(harness.text.askMotherBirthday, { conversationId: 'scope:new' });
    assert.equal(harness.traces.ranking.length, 1);
    assert.ok(harness.traces.ranking[0].candidates.every((candidate) =>
      candidate.ownerUserId === harness.owners.a &&
      candidate.subjectEntityId === harness.entityIds.a.mother &&
      candidate.predicate === 'birthday'));
    assert.deepEqual(result.groundingResult.evidenceMemoryIds, result.rankingResult.rankedMemoryIds);
    assert.equal(result.groundingResult.checksum, result.page.items[0].checksum);
  });

  test(`${label}: scenario realignment leaves the registered predicate schemas frozen`, async () => {
    assert.deepEqual(Object.keys(PREDICATE_STRUCTURED_VALUE_SCHEMAS), [
      'birthday',
      'preference_statement',
      'favorite_preference_statement'
    ]);
  });

  if (sqliteRestart) {
    test(`${label}: close/reopen destroys runtime state and a new conversation reads persisted SQLite evidence`, async (t) => {
      const harness = await open(t, createBackend);
      await harness.capture(harness.text.motherBirthday, { idempotencyKey: 'restart:seed' });
      const before = harness.runtimeGeneration;
      await harness.restart({ conversationId: 'restart:fresh' });
      assert.equal(harness.runtimeGeneration, before + 1);
      assert.equal(harness.traces.ranking.length, 0);
      const result = await harness.recall(harness.text.askMotherBirthday, { conversationId: 'restart:fresh' });
      assert.equal(result.safeAnswer.safeUserMessage, '5月6号。');
      assert.equal(result.sourceMode, 'v2');
    });

    test(`${label}: Shadow SQLite is repository-external and its temporary directory is cleaned`, async (t) => {
      const harness = await open(t, createBackend);
      const root = harness.backend.root;
      assert.equal(path.resolve(root).startsWith(path.resolve(repositoryRoot)), false);
      assert.equal(fs.existsSync(harness.backend.databasePath), true);
      await harness.close();
      assert.equal(fs.existsSync(root), false);
    });
  }
}
