import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeMemoryCandidate,
  createMemoryRecord,
  shouldRemember,
  validateMemoryRecord
} from './index.js';

const context = { now: '2026-07-13T09:00:00+08:00' };

test('creates complete MemoryRecord defaults without undefined display values', () => {
  const record = createMemoryRecord({ originalText: '请记住我喜欢简洁的界面。' }, context);
  const validation = validateMemoryRecord(record);

  assert.equal(validation.valid, true);
  assert.equal(record.originalText, '请记住我喜欢简洁的界面。');
  assert.equal(record.amount, null);
  assert.deepEqual(record.people, []);
  assert.deepEqual(record.metadata, {});
  assert.equal(Object.values(record).some((value) => value === undefined), false);
});

test('detects expense memory from grocery spending', () => {
  const result = analyzeMemoryCandidate('今天买菜花了100元。', context);

  assert.equal(result.decision.remember, true);
  assert.equal(result.memoryCandidate.memoryType, 'expense');
  assert.equal(result.memoryCandidate.category, 'expense');
  assert.equal(result.memoryCandidate.amount, 100);
  assert.equal(result.memoryCandidate.currency, 'CNY');
  assert.equal(result.memoryCandidate.direction, 'expense');
  assert.match(result.memoryCandidate.summary, /买菜/);
});

test('detects income memory from customer payment', () => {
  const result = analyzeMemoryCandidate('刚才收到客户货款5000元。', context);

  assert.equal(result.memoryCandidate.memoryType, 'income');
  assert.equal(result.memoryCandidate.amount, 5000);
  assert.equal(result.memoryCandidate.direction, 'income');
  assert.match(result.memoryCandidate.summary, /客户货款/);
});

test('extracts schedule date, time and person', () => {
  const result = analyzeMemoryCandidate('明天下午3点见张总。', context);

  assert.equal(result.memoryCandidate.category, 'schedule');
  assert.deepEqual(result.memoryCandidate.people, ['张总']);
  assert.equal(result.memoryCandidate.eventDate, '2026-07-14');
  assert.equal(result.memoryCandidate.eventTime, '15:00');
});

test('extracts quote amount and customer organization', () => {
  const result = analyzeMemoryCandidate('华南客户报价是12万元。', context);

  assert.ok(['quote', 'customer_fact'].includes(result.memoryCandidate.category));
  assert.deepEqual(result.memoryCandidate.organizations, ['华南客户']);
  assert.equal(result.memoryCandidate.amount, 120000);
  assert.equal(result.memoryCandidate.currency, 'CNY');
});

test('extracts common CNY amount variants', () => {
  assert.equal(analyzeMemoryCandidate('午餐花了68.5元。', context).memoryCandidate.amount, 68.5);
  assert.equal(analyzeMemoryCandidate('收到定金5000块。', context).memoryCandidate.amount, 5000);
  assert.equal(analyzeMemoryCandidate('项目预算2万。', context).memoryCandidate.amount, 20000);
  assert.equal(analyzeMemoryCandidate('报价1.5万元。', context).memoryCandidate.amount, 15000);
});

test('explicit remember preference becomes long term memory', () => {
  const result = analyzeMemoryCandidate('请记住我喜欢简洁的界面。', context);

  assert.equal(result.decision.remember, true);
  assert.equal(result.memoryCandidate.category, 'preference');
  assert.equal(result.memoryCandidate.retentionPolicy, 'long_term');
});

test('does not remember greeting', () => {
  const decision = shouldRemember('你好。', context);

  assert.equal(decision.remember, false);
});

test('does not remember one-off translation request', () => {
  const result = analyzeMemoryCandidate('帮我翻译这句话。', context);

  assert.equal(result.decision.remember, false);
  assert.equal(result.memoryCandidate, null);
});

test('requires confirmation for sensitive bank card data', () => {
  const result = analyzeMemoryCandidate('我的银行卡号是6222021234567890123。', context);

  assert.equal(result.decision.needsConfirmation, true);
  assert.equal(result.memoryCandidate.sensitivity, 'high');
  assert.equal(result.memoryCandidate.needsConfirmation, true);
  assert.doesNotMatch(result.warnings.join('\n'), /6222021234567890123/);
});

test('requires confirmation for redacted sensitive bank card statement', () => {
  const result = analyzeMemoryCandidate('我的银行卡号是……', context);

  assert.equal(result.decision.needsConfirmation, true);
  assert.equal(result.memoryCandidate.sensitivity, 'high');
});

test('time-only input needs confirmation and keeps clean summary', () => {
  const result = analyzeMemoryCandidate('今晚8点。', context);

  assert.equal(result.memoryCandidate.eventTime, '20:00');
  assert.equal(result.memoryCandidate.needsConfirmation, true);
  assert.equal(result.decision.needsConfirmation, true);
  assert.doesNotMatch(result.memoryCandidate.summary, /点|钟/);
});

test('empty input is ignored without throwing', () => {
  const result = analyzeMemoryCandidate('   ', context);

  assert.equal(result.decision.remember, false);
  assert.equal(result.memoryCandidate, null);
  assert.equal(result.validation.valid, false);
});
