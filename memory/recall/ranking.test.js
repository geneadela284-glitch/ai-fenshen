import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRankingEngine } from './index.js';
import { fakeMemoryRecord } from './testing/fixtures.js';

const ranking = new MemoryRankingEngine();
const base = { text: '按我的咖啡偏好推荐', timestamp: '2026-07-15T08:00:00.000Z', intent: 'personal_preference' };

function score(record, request = base) {
  return ranking.score(record, request);
}

test('ranking gives relevant content a higher score', () => {
  assert.ok(score(fakeMemoryRecord('coffee', { value: '虚构咖啡偏好', normalizedValue: '虚构咖啡偏好' })).score > score(fakeMemoryRecord('tea', { value: '虚构茶偏好', normalizedValue: '虚构茶偏好' })).score);
});

test('ranking gives recent records a higher score when otherwise equal', () => {
  const recent = fakeMemoryRecord('recent', { sourceTimestamp: '2026-07-14T08:00:00.000Z' });
  const old = fakeMemoryRecord('old', { sourceTimestamp: '2020-01-01T00:00:00.000Z' });
  assert.ok(score(recent).score > score(old).score);
});

test('ranking gives higher confidence a higher score', () => {
  assert.ok(score(fakeMemoryRecord('high', { confidence: 1 })).score > score(fakeMemoryRecord('low', { confidence: 0.1 })).score);
});

test('ranking gives higher importance a higher score', () => {
  assert.ok(score(fakeMemoryRecord('high', { importance: 1 })).score > score(fakeMemoryRecord('low', { importance: 0.1 })).score);
});

const TRUST_ORDER = ['user_confirmed', 'structured_system_record', 'user_explicit', 'repeated_observation', 'imported', 'model_inferred', 'legacy_unknown'];
for (let index = 0; index < TRUST_ORDER.length - 1; index += 1) {
  test(`source trust ranks ${TRUST_ORDER[index]} above ${TRUST_ORDER[index + 1]}`, () => {
    const stronger = fakeMemoryRecord('stronger', { source: { type: TRUST_ORDER[index], id: 'fake-source-a' } });
    const weaker = fakeMemoryRecord('weaker', { source: { type: TRUST_ORDER[index + 1], id: 'fake-source-b' } });
    assert.ok(score(stronger).score > score(weaker).score);
  });
}

test('user confirmation ranks above not-required confirmation', () => {
  assert.ok(score(fakeMemoryRecord('confirmed')).score > score(fakeMemoryRecord('not-required', { confirmationStatus: 'not_required' })).score);
});

test('sensitivity applies a penalty rather than overriding authorization', () => {
  assert.ok(score(fakeMemoryRecord('low')).score > score(fakeMemoryRecord('high', { sensitivity: 'high' })).score);
});

test('ranking breakdown explains every scoring dimension', () => {
  const result = score(fakeMemoryRecord('explain'));
  for (const key of ['relevance', 'recency', 'effectiveTimeMatch', 'confidence', 'importance', 'sourceTrust', 'confirmationStrength', 'sensitivityPenalty']) assert.equal(typeof result.breakdown[key], 'number');
});

test('ranking is deterministic for identical input', () => {
  const record = fakeMemoryRecord('stable');
  assert.deepEqual(score(record), score(structuredClone(record)));
});

test('stable sort uses memory id as the final tie breaker', () => {
  const records = [fakeMemoryRecord('b'), fakeMemoryRecord('a')];
  assert.deepEqual(ranking.rank(records, base).map((item) => item.record.id), ['a', 'b']);
});

test('Provider labels do not affect ranking', () => {
  const record = fakeMemoryRecord('provider-independent');
  assert.deepEqual(score(record, { ...base, provider: 'fake-provider-a' }), score(record, { ...base, provider: 'fake-provider-b' }));
});
