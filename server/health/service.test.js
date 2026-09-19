import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { applyTasksMigrations } from '../tasks/migrations.js';
import { createTasksRuntime } from '../tasks/runtime.js';
import { createHealthLifecycleRuntime, createHealthRuntime } from './runtime.js';

const KEY = Buffer.alloc(32, 19);

function harness({ now = '2026-09-09T02:00:00.000Z', tasksOverride } = {}) {
  const database = new DatabaseSync(':memory:');
  applyTasksMigrations(database);
  const clock = () => new Date(now);
  const tasks = createTasksRuntime({ database, clock });
  const tasksService = tasksOverride ? tasksOverride(tasks.service) : tasks.service;
  const runtime = createHealthRuntime({ database, tasksService, encryptionKey: KEY, clock, applyMigrations: true });
  return { database, tasks, runtime, service: runtime.service, close() { runtime.close(); tasks.close(); database.close(); } };
}

function profile(overrides = {}) {
  return { subject: 'self', consentStorage: true, consentAI: false, ...overrides };
}

function metric(overrides = {}) {
  return {
    type: 'weight', value: 62.5, unit: 'kg', measuredAt: '2026-09-09T08:00:00+08:00',
    context: 'morning', status: 'confirmed', note: '仅属于甲的敏感体重', ...overrides
  };
}

function assertCode(code, status) {
  return (error) => error?.code === code && (status === undefined || error.status === status);
}

test('owner 隔离覆盖 CRUD 和导出，SQLite 不含敏感明文', () => {
  const h = harness();
  try {
    h.service.saveProfile('owner-a', { payload: profile(), idempotencyKey: 'profile-a' });
    h.service.saveProfile('owner-b', { payload: profile(), idempotencyKey: 'profile-b' });
    const created = h.service.create('owner-a', { kind: 'metric', occurredOn: '2026-09-09', payload: metric(), idempotencyKey: 'metric-a' });
    assert.equal(h.service.get('owner-a', created.id).payload.note, '仅属于甲的敏感体重');
    assert.throws(() => h.service.get('owner-b', created.id), assertCode('HEALTH_NOT_FOUND', 404));
    assert.equal(h.service.list('owner-b').some((record) => record.id === created.id), false);
    assert.equal(h.service.export('owner-b').records.some((record) => record.id === created.id), false);
    assert.doesNotMatch(JSON.stringify(h.database.prepare('SELECT * FROM health_records').all()), /仅属于甲的敏感体重/);
    const updated = h.service.update('owner-a', created.id, { revision: 1, payload: metric({ value: 63 }) });
    assert.equal(updated.revision, 2);
    assert.equal(h.service.delete('owner-a', created.id, { revision: 2, confirmed: true }), true);
  } finally { h.close(); }
});

test('幂等重试返回原记录，不同内容冲突，删除后重放被拒绝', () => {
  const h = harness();
  try {
    h.service.saveProfile('owner-a', { payload: profile(), idempotencyKey: 'profile-a' });
    const input = { kind: 'metric', occurredOn: '2026-09-09', payload: metric(), idempotencyKey: 'same' };
    const first = h.service.create('owner-a', input);
    assert.equal(h.service.create('owner-a', input).id, first.id);
    assert.throws(() => h.service.create('owner-a', { ...input, payload: metric({ value: 70 }) }), assertCode('HEALTH_IDEMPOTENCY_CONFLICT', 409));
    h.service.delete('owner-a', first.id, { revision: 1, confirmed: true });
    assert.throws(() => h.service.create('owner-a', input), assertCode('HEALTH_IDEMPOTENCY_DELETED', 409));
  } finally { h.close(); }
});

test('revision 冲突、非法日期、单位、非有限数和血糖确认情境均失败，血糖草稿可保存', () => {
  const h = harness();
  try {
    h.service.saveProfile('owner-a', { payload: profile(), idempotencyKey: 'profile-a' });
    const created = h.service.create('owner-a', { kind: 'metric', occurredOn: '2026-09-09', payload: metric(), idempotencyKey: 'one' });
    assert.throws(() => h.service.update('owner-a', created.id, { revision: 9, payload: metric() }), assertCode('HEALTH_REVISION_CONFLICT', 409));
    assert.throws(() => h.service.create('owner-a', { kind: 'metric', occurredOn: '2026-02-30', payload: metric(), idempotencyKey: 'bad-date' }), assertCode('HEALTH_DATE_INVALID'));
    assert.throws(() => h.service.create('owner-a', { kind: 'metric', occurredOn: '2026-09-09', payload: metric({ unit: 'lb' }), idempotencyKey: 'bad-unit' }), assertCode('HEALTH_METRIC_UNIT_INVALID'));
    assert.throws(() => h.service.create('owner-a', { kind: 'metric', occurredOn: '2026-09-09', payload: metric({ value: Infinity }), idempotencyKey: 'bad-value' }), assertCode('HEALTH_METRIC_VALUE_INVALID'));
    assert.throws(() => h.service.create('owner-a', { kind: 'metric', occurredOn: '2026-09-09', payload: metric({ type: 'glucose', unit: 'mmol/L', context: 'unknown' }), idempotencyKey: 'bad-glucose' }), assertCode('HEALTH_GLUCOSE_CONTEXT_REQUIRED'));
    const draft = h.service.create('owner-a', { kind: 'metric', occurredOn: '2026-09-09', payload: metric({ type: 'glucose', unit: 'mmol/L', context: '', status: 'draft' }), idempotencyKey: 'draft-glucose' });
    assert.equal(draft.payload.status, 'draft');
  } finally { h.close(); }
});

test('只允许本人资料；未同意和撤回存储同意后阻断新增、修改与提醒', () => {
  const h = harness();
  try {
    assert.throws(() => h.service.saveProfile('owner-a', { payload: profile({ subject: 'child' }), idempotencyKey: 'bad-subject' }), assertCode('HEALTH_SUBJECT_INVALID'));
    const initial = h.service.saveProfile('owner-a', { payload: profile({ consentStorage: false }), idempotencyKey: 'profile-a' });
    assert.throws(() => h.service.create('owner-a', { kind: 'meal', occurredOn: '2026-09-09', payload: { name: '早餐', meal: 'breakfast' }, idempotencyKey: 'meal-a' }), assertCode('HEALTH_STORAGE_CONSENT_REQUIRED', 403));
    const enabled = h.service.saveProfile('owner-a', { payload: profile(), revision: initial.revision, idempotencyKey: 'profile-enable' });
    const meal = h.service.create('owner-a', { kind: 'meal', occurredOn: '2026-09-09', payload: { name: '早餐', meal: 'breakfast' }, idempotencyKey: 'meal-a' });
    const revoked = h.service.saveProfile('owner-a', { payload: profile({ consentStorage: false }), revision: enabled.revision, idempotencyKey: 'profile-revoke' });
    assert.equal(revoked.payload.consentStorage, false);
    assert.throws(() => h.service.update('owner-a', meal.id, { revision: meal.revision, payload: { name: '午餐', meal: 'lunch' } }), assertCode('HEALTH_STORAGE_CONSENT_REQUIRED', 403));
    assert.throws(() => h.service.create('owner-a', { kind: 'reminder', occurredOn: '2026-09-10', payload: { title: '吃药', scheduledAt: '2026-09-10T09:00:00+08:00', timezone: 'Asia/Shanghai', repeat: 'none', status: 'pending', history: [] }, idempotencyKey: 'reminder-a' }), assertCode('HEALTH_STORAGE_CONSENT_REQUIRED', 403));
    assert.equal(h.service.export('owner-a').records.length, 2);
  } finally { h.close(); }
});

test('提醒与任务同事务回滚，列表使用隐私标题且可观察外部完成', () => {
  const failing = harness({ tasksOverride: (service) => ({ ...service, repository: service.repository, create() { throw Object.assign(new Error('boom'), { code: 'TASK_CREATE_FAILED' }); } }) });
  try {
    failing.service.saveProfile('owner-a', { payload: profile(), idempotencyKey: 'profile-a' });
    assert.throws(() => failing.service.create('owner-a', { kind: 'reminder', occurredOn: '2026-09-09', payload: { title: '敏感药名', scheduledAt: '2026-09-09T11:00:00+08:00', timezone: 'Asia/Shanghai', repeat: 'none', status: 'pending', history: [] }, idempotencyKey: 'reminder-a' }), /boom/);
    assert.equal(failing.database.prepare("SELECT COUNT(*) count FROM health_records WHERE kind='reminder'").get().count, 0);
  } finally { failing.close(); }

  const h = harness();
  try {
    h.service.saveProfile('owner-a', { payload: profile(), idempotencyKey: 'profile-a' });
    const reminder = h.service.create('owner-a', { kind: 'reminder', occurredOn: '2026-09-09', payload: { title: '敏感药名', scheduledAt: '2026-09-09T11:00:00+08:00', timezone: 'Asia/Shanghai', repeat: 'none', status: 'pending', history: [] }, idempotencyKey: 'reminder-a' });
    const visible = h.service.reminders('owner-a');
    assert.equal(visible[0].title, '有一项健康提醒');
    assert.doesNotMatch(JSON.stringify(visible[0]), /敏感药名/);
    const taskId = h.database.prepare('SELECT task_id FROM health_task_links WHERE health_id=?').get(reminder.id).task_id;
    h.tasks.service.complete('owner-a', taskId);
    assert.equal(h.service.get('owner-a', reminder.id).payload.status, 'completed');
  } finally { h.close(); }
});

test('每周提醒完成记录历史并生成唯一的下次提醒，延期和取消受规则约束', () => {
  const h = harness();
  try {
    h.service.saveProfile('owner-a', { payload: profile(), idempotencyKey: 'profile-a' });
    const weekly = h.service.create('owner-a', { kind: 'reminder', occurredOn: '2026-09-09', payload: { title: '复查', scheduledAt: '2026-09-09T09:00:00+08:00', timezone: 'Asia/Shanghai', repeat: 'weekly', status: 'pending', history: [] }, idempotencyKey: 'weekly' });
    const next = h.service.reminderAction('owner-a', weekly.id, { revision: 1, action: 'complete' });
    assert.equal(next.payload.status, 'pending');
    assert.equal(next.payload.history.length, 1);
    assert.equal(next.payload.scheduledAt, '2026-09-16T01:00:00.000Z');
    assert.equal(h.database.prepare('SELECT COUNT(*) count FROM health_task_links WHERE health_id=?').get(weekly.id).count, 2);
    assert.throws(() => h.service.reminderAction('owner-a', weekly.id, { revision: 1, action: 'complete' }), assertCode('HEALTH_REVISION_CONFLICT', 409));
    assert.throws(() => h.service.reminderAction('owner-a', weekly.id, { revision: 2, action: 'snooze', scheduledAt: '2026-09-09T09:00:00+08:00' }), assertCode('HEALTH_SNOOZE_NOT_FUTURE'));
    const snoozed = h.service.reminderAction('owner-a', weekly.id, { revision: 2, action: 'snooze', scheduledAt: '2026-09-10T09:00:00+08:00' });
    const cancelled = h.service.reminderAction('owner-a', weekly.id, { revision: snoozed.revision, action: 'cancel' });
    assert.equal(cancelled.payload.status, 'cancelled');
  } finally { h.close(); }
});

test('报告文件只在 get 暴露，常规更新不能归档，并限制 PDF、base64 与记录规模', () => {
  const h = harness();
  try {
    h.service.saveProfile('owner-a', { payload: profile(), idempotencyKey: 'profile-a' });
    const reportPayload = { filename: 'report.pdf', dataBase64: Buffer.from('%PDF synthetic private').toString('base64'), checksum: 'abc', pages: [{ pageNumber: 1, text: '合成报告' }], status: 'review', items: [] };
    const report = h.service.create('owner-a', { kind: 'report', occurredOn: '2026-09-09', payload: reportPayload, idempotencyKey: 'report-a' });
    assert.equal(h.service.get('owner-a', report.id).payload.dataBase64, reportPayload.dataBase64);
    assert.equal('dataBase64' in h.service.list('owner-a', { kind: 'report' })[0].payload, false);
    assert.equal('dataBase64' in h.service.export('owner-a').records.find((record) => record.id === report.id).payload, false);
    assert.throws(() => h.service.update('owner-a', report.id, { revision: 1, payload: { ...reportPayload, status: 'archived' } }), assertCode('HEALTH_REPORT_ARCHIVE_CONFIRMATION_REQUIRED'));
    assert.throws(() => h.service.create('owner-a', { kind: 'report', occurredOn: '2026-09-09', payload: { ...reportPayload, filename: 'report.png' }, idempotencyKey: 'bad-ext' }), assertCode('HEALTH_REPORT_FILE_INVALID'));
    assert.throws(() => h.service.create('owner-a', { kind: 'report', occurredOn: '2026-09-09', payload: { ...reportPayload, dataBase64: 'A'.repeat(16_777_220) }, idempotencyKey: 'too-big' }), assertCode('HEALTH_REPORT_TOO_LARGE'));
    assert.throws(() => h.service.create('owner-a', { kind: 'meal', occurredOn: '2026-09-09', payload: { name: '早餐', meal: 'breakfast', note: 'x'.repeat(1_100_000) }, idempotencyKey: 'huge-record' }), assertCode('HEALTH_RECORD_TOO_LARGE'));
  } finally { h.close(); }
});

test('plan 不能通用创建 active，通用更新 active 需要 confirmed 且 versions 有界', () => {
  const h = harness();
  try {
    h.service.saveProfile('owner-a', { payload: profile(), idempotencyKey: 'profile-a' });
    const payload = { status: 'draft', startDate: '2026-09-09', days: [], basis: [], mode: 'rules', versions: [] };
    assert.throws(() => h.service.create('owner-a', { kind: 'plan', occurredOn: '2026-09-09', payload: { ...payload, status: 'active' }, idempotencyKey: 'active' }), assertCode('HEALTH_PLAN_CONFIRMATION_REQUIRED'));
    const draft = h.service.create('owner-a', { kind: 'plan', occurredOn: '2026-09-09', payload, idempotencyKey: 'draft' });
    assert.throws(() => h.service.update('owner-a', draft.id, { revision: 1, payload: { ...payload, status: 'active' } }), assertCode('HEALTH_PLAN_CONFIRMATION_REQUIRED'));
    const active = h.service.update('owner-a', draft.id, { revision: 1, confirmed: true, payload: { ...payload, status: 'active' } });
    assert.equal(active.payload.versions.length, 1);
  } finally { h.close(); }
});

test('运行时公开注入时钟，口述训练可保留未记录感受而不伪造舒适', () => {
  const h = harness();
  try {
    assert.equal(h.runtime.clock().toISOString(), '2026-09-09T02:00:00.000Z');
    h.service.saveProfile('owner-a', { payload: profile(), idempotencyKey: 'profile-a' });
    const workout = h.service.create('owner-a', {
      kind: 'workout', occurredOn: '2026-09-09', idempotencyKey: 'workout-a',
      payload: { name: '散步', minutes: 20, feeling: 'unrecorded' }
    });
    assert.equal(workout.payload.feeling, 'unrecorded');
  } finally { h.close(); }
});

test('无 key 生命周期允许删除，空数据可导出，非空数据导出失败', () => {
  const h = harness();
  try {
    h.service.saveProfile('owner-a', { payload: profile(), idempotencyKey: 'profile-a' });
    const lifecycle = createHealthLifecycleRuntime({ database: h.database, tasksService: h.tasks.service });
    assert.throws(() => lifecycle.service.export('owner-a'), assertCode('HEALTH_KEY_REQUIRED', 503));
    assert.equal(lifecycle.service.export('owner-b').records.length, 0);
    assert.equal(lifecycle.service.deleteAllForOwner('owner-a'), 1);
    assert.equal(lifecycle.service.export('owner-a').records.length, 0);
  } finally { h.close(); }
});
