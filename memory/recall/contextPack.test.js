import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRecallEngine } from './index.js';
import { fakeMemoryRecord, fakeRecallContext, staticRepository } from './testing/fixtures.js';

function selected(record, score = 0.8) {
  return { record, score, breakdown: { relevance: score }, classification: 'resolved_current', reasonSelected: 'test', chainSummary: null };
}

function recallResult(records, overrides = {}) {
  return {
    ok: true,
    intent: { intent: 'personal_preference', reasonCode: 'RECALL_TEST' },
    plan: { includeHistorical: false },
    selected: records.map((record, index) => selected(record, 1 - index * 0.01)),
    excluded: [], conflictNotices: [], warnings: [], auditEvents: [], error: null,
    ...overrides
  };
}

function engine() {
  return new MemoryRecallEngine({ repository: staticRepository([]) });
}

test('Context Pack contains the approved top-level fields', () => {
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([fakeMemoryRecord('one')]));
  for (const key of ['budgetUsage', 'conflictNotices', 'excludedSummary', 'generatedAt', 'memoryItems', 'policyVersion', 'provenance', 'purpose', 'userId', 'warnings']) assert.ok(key in pack);
});

test('Context item contains the approved provenance fields', () => {
  const item = engine().buildContextPack(fakeRecallContext(), recallResult([fakeMemoryRecord('one')])).memoryItems[0];
  for (const key of ['memoryId', 'memoryType', 'safeText', 'sourceType', 'sourceTimestamp', 'effectiveFrom', 'effectiveTo', 'confidence', 'importance', 'sensitivity', 'reasonSelected', 'rankScore', 'version', 'isDerivedSummary']) assert.ok(key in item);
});

test('maxItems keeps only whole highest-ranked records', () => {
  const records = [fakeMemoryRecord('one'), fakeMemoryRecord('two', { predicate: 'avoids', normalizedValue: '二' })];
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult(records), { maxItems: 1 });
  assert.deepEqual(pack.memoryItems.map((item) => item.memoryId), ['one']);
});

test('maxCharacters never truncates a fact midway', () => {
  const record = fakeMemoryRecord('long', { value: '完整虚构事实'.repeat(100), normalizedValue: 'long' });
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([record]), { maxCharacters: 20 });
  assert.equal(pack.memoryItems.every((item) => !item.safeText.endsWith('完')), true);
  assert.equal(pack.memoryItems[0].isDerivedSummary, true);
});

test('zero character budget returns no items', () => {
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([fakeMemoryRecord('one')]), { maxCharacters: 0 });
  assert.equal(pack.memoryItems.length, 0);
});

test('zero item budget returns no items', () => {
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([fakeMemoryRecord('one')]), { maxItems: 0 });
  assert.equal(pack.memoryItems.length, 0);
});

test('estimated token budget is enforced', () => {
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([fakeMemoryRecord('one')]), { maxEstimatedTokens: 1 });
  assert.ok(pack.budgetUsage.estimatedTokens <= 1);
});

test('perTypeLimit is enforced', () => {
  const records = [fakeMemoryRecord('one'), fakeMemoryRecord('two', { predicate: 'avoids', normalizedValue: '二' })];
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult(records), { perTypeLimit: 1 });
  assert.equal(pack.memoryItems.length, 1);
});

test('high-sensitive item uses a derived safe existence notice', () => {
  const record = fakeMemoryRecord('health', { memoryType: 'fact', value: '虚构健康正文', normalizedValue: '虚构健康正文', sensitivity: 'high' });
  const context = fakeRecallContext({ purpose: 'sensitive_assistance', sensitivityAllowance: 'high', metadata: { sensitiveAccessApproved: true }, contextBudget: { ...fakeRecallContext().contextBudget, maxSensitiveItems: 1 } });
  const pack = engine().buildContextPack(context, recallResult([record]), { maxSensitiveItems: 1 });
  assert.equal(pack.memoryItems[0].safeText.includes('虚构健康正文'), false);
  assert.equal(pack.memoryItems[0].isDerivedSummary, true);
});

test('maxSensitiveItems zero omits high-sensitive items', () => {
  const record = fakeMemoryRecord('health', { sensitivity: 'high' });
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([record]), { maxSensitiveItems: 0 });
  assert.equal(pack.memoryItems.length, 0);
});

test('Context Pack never includes SQL text', () => {
  const record = fakeMemoryRecord('sql', { value: 'SELECT * FROM memories', normalizedValue: 'sql' });
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([record]));
  assert.equal(JSON.stringify(pack).includes('SELECT *'), false);
});

test('Context Pack never includes an absolute file path', () => {
  const record = fakeMemoryRecord('path', { value: '/private/tmp/fake-memory', normalizedValue: 'path' });
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([record]));
  assert.equal(JSON.stringify(pack).includes('/private/tmp'), false);
});

test('Context Pack never includes prohibited secret text', () => {
  const record = fakeMemoryRecord('secret', { value: 'Access Token fake-value', normalizedValue: 'secret' });
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([record]));
  assert.equal(JSON.stringify(pack).includes('fake-value'), false);
});

test('budget trimming is reported without record bodies', () => {
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([fakeMemoryRecord('one'), fakeMemoryRecord('two', { predicate: 'avoids', normalizedValue: '二' })]), { maxItems: 1 });
  assert.equal(pack.warnings.includes('memory_budget_trimmed'), true);
  assert.equal(pack.excludedSummary.budget, 1);
});

test('Context Pack provenance is record-level and safe', () => {
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([fakeMemoryRecord('one')]));
  assert.deepEqual(pack.provenance, [{ memoryId: 'one', sourceType: 'user_confirmed', sourceTimestamp: '2026-07-01T08:00:00.000Z', version: 1 }]);
});

test('Context Pack is deeply immutable', () => {
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([fakeMemoryRecord('one')]));
  assert.equal(Object.isFrozen(pack), true);
  assert.equal(Object.isFrozen(pack.memoryItems), true);
  assert.throws(() => { pack.memoryItems.push({}); }, TypeError);
});

test('explanation states why memory was used', () => {
  const explanation = engine().explainRecall(fakeRecallContext(), recallResult([fakeMemoryRecord('one')]));
  assert.equal(explanation.memoryNeeded, true);
  assert.equal(explanation.selectedCount, 1);
});

test('explanation reports conflicts without body text', () => {
  const result = recallResult([], { conflictNotices: [{ classification: 'unresolved_conflict', memoryIds: ['a', 'b'] }] });
  const explanation = engine().explainRecall(fakeRecallContext(), result);
  assert.equal(explanation.hasConflict, true);
  assert.equal(JSON.stringify(explanation).includes('虚构'), false);
});

test('explanation reports historical use', () => {
  const explanation = engine().explainRecall(fakeRecallContext(), recallResult([], { plan: { includeHistorical: true } }));
  assert.equal(explanation.usedHistorical, true);
});

test('explanation reports sensitivity omission and budget trimming', () => {
  const result = recallResult([], { excluded: [{ memoryId: 's', exclusionReason: 'sensitivity' }, { memoryId: 'b', exclusionReason: 'budget' }] });
  const explanation = engine().explainRecall(fakeRecallContext(), result);
  assert.equal(explanation.sensitiveOmitted, true);
  assert.equal(explanation.budgetTrimmed, true);
});

test('Context Pack creation emits a safe audit event', () => {
  const pack = engine().buildContextPack(fakeRecallContext(), recallResult([fakeMemoryRecord('one')]));
  assert.equal(pack.auditEvents.some((event) => event.action === 'context_pack_created'), true);
  assert.equal(JSON.stringify(pack).includes('fake-recall-request'), false);
});
