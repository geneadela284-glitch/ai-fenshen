import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRecallEngine } from './index.js';
import { fakeMemoryRecord, fakeRecallContext, staticRepository } from './testing/fixtures.js';

async function recall(records, text = '按我的偏好推荐') {
  return new MemoryRecallEngine({ repository: staticRepository(records) }).recall(fakeRecallContext(), { text });
}

test('same Memory id is selected only once', async () => {
  const record = fakeMemoryRecord('same-id');
  const result = await recall([record, structuredClone(record)]);
  assert.equal(result.selected.length, 1);
  assert.equal(result.excluded.some((item) => item.exclusionReason === 'duplicate_id'), true);
});

test('same subject predicate and normalized value folds a technical duplicate', async () => {
  const result = await recall([fakeMemoryRecord('dup-a'), fakeMemoryRecord('dup-b')]);
  assert.equal(result.selected.length, 1);
  assert.equal(result.excluded.some((item) => item.exclusionReason === 'duplicate'), true);
});

test('independent current preferences are not treated as an unresolved conflict', async () => {
  const records = [
    fakeMemoryRecord('spicy', { value: '虚构偏好辛辣食物', normalizedValue: '辛辣食物' }),
    fakeMemoryRecord('warm-drink', { value: '虚构偏好温热饮品', normalizedValue: '温热饮品' })
  ];
  const result = await recall(records, '我喜欢吃什么？');
  assert.equal(result.selected.length, 2);
  assert.equal(result.conflictNotices.length, 0);
});

test('contradictory current preferences are not automatically adjudicated', async () => {
  const records = [
    fakeMemoryRecord('coffee', { value: '虚构偏好咖啡', normalizedValue: '咖啡', conflictGroupId: 'fake-preference-conflict' }),
    fakeMemoryRecord('tea', { value: '虚构偏好茶', normalizedValue: '茶', conflictGroupId: 'fake-preference-conflict' })
  ];
  const result = await recall(records);
  assert.equal(result.selected.length, 0);
  assert.equal(result.conflictNotices[0].classification, 'unresolved_conflict');
});

test('conflict notice contains ids but no record bodies', async () => {
  const result = await recall([
    fakeMemoryRecord('coffee', { value: '虚构偏好咖啡', normalizedValue: '咖啡', conflictGroupId: 'fake-preference-conflict' }),
    fakeMemoryRecord('tea', { value: '虚构偏好茶', normalizedValue: '茶', conflictGroupId: 'fake-preference-conflict' })
  ]);
  assert.deepEqual(result.conflictNotices[0].memoryIds, ['coffee', 'tea']);
  assert.equal(JSON.stringify(result.conflictNotices).includes('虚构偏好'), false);
});

test('multiple Life Events are retained as independent events', async () => {
  const records = [
    fakeMemoryRecord('graduation', { memoryType: 'life_event', predicate: 'experienced_event', value: '虚构毕业事件', normalizedValue: '虚构毕业事件', sourceTimestamp: '2020-01-01T00:00:00.000Z' }),
    fakeMemoryRecord('move', { memoryType: 'life_event', predicate: 'experienced_event', value: '虚构搬家事件', normalizedValue: '虚构搬家事件', sourceTimestamp: '2022-01-01T00:00:00.000Z' })
  ];
  const result = await recall(records, '我经历过哪些重要事件');
  assert.equal(result.selected.length, 2);
  assert.equal(result.selected.every((item) => item.classification === 'independent_event'), true);
});

test('different predicates remain independent facts', async () => {
  const records = [
    fakeMemoryRecord('name', { memoryType: 'fact', predicate: 'has_name', value: '虚构姓名', normalizedValue: '虚构姓名' }),
    fakeMemoryRecord('city', { memoryType: 'fact', predicate: 'resides_in_city', value: '虚构城市', normalizedValue: '虚构城市' })
  ];
  const result = await recall(records, '关于我的基本信息');
  assert.equal(result.selected.length, 2);
});

test('historical version chain keeps current and superseded records', async () => {
  const old = fakeMemoryRecord('old', { memoryType: 'fact', predicate: 'resides_in_city', value: '虚构旧城市', normalizedValue: '旧城市', status: 'superseded', supersededById: 'current' });
  const current = fakeMemoryRecord('current', { memoryType: 'fact', predicate: 'resides_in_city', value: '虚构当前城市', normalizedValue: '当前城市', supersedesId: 'old' });
  const result = await recall([old, current], '我以前住在哪里');
  assert.equal(result.selected.find((item) => item.record.id === 'old').classification, 'historical_only');
  assert.equal(result.selected.find((item) => item.record.id === 'current').classification, 'resolved_current');
});

test('historical version chain includes a safe chain summary', async () => {
  const old = fakeMemoryRecord('old', { memoryType: 'fact', predicate: 'resides_in_city', status: 'superseded', supersededById: 'current' });
  const current = fakeMemoryRecord('current', { memoryType: 'fact', predicate: 'resides_in_city', supersedesId: 'old' });
  const result = await recall([old, current], '我以前住在哪里');
  assert.deepEqual(result.selected[0].chainSummary, ['current', 'old']);
});

test('unlinked historical contradictions remain unresolved', async () => {
  const records = [
    fakeMemoryRecord('old-a', { memoryType: 'fact', predicate: 'resides_in_city', value: '虚构城市甲', normalizedValue: '甲', status: 'archived' }),
    fakeMemoryRecord('old-b', { memoryType: 'fact', predicate: 'resides_in_city', value: '虚构城市乙', normalizedValue: '乙', status: 'archived' })
  ];
  const result = await recall(records, '我以前住在哪里');
  assert.equal(result.selected.length, 0);
  assert.equal(result.conflictNotices.length, 1);
});

test('conflict creates a safe recall audit event', async () => {
  const result = await recall([
    fakeMemoryRecord('a', { normalizedValue: '甲', conflictGroupId: 'fake-preference-conflict' }),
    fakeMemoryRecord('b', { normalizedValue: '乙', conflictGroupId: 'fake-preference-conflict' })
  ]);
  assert.equal(result.auditEvents.some((event) => event.action === 'recall_conflict_found'), true);
  assert.equal(JSON.stringify(result.auditEvents).includes('虚构咖啡偏好'), false);
});
