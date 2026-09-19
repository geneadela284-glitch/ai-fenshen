import assert from 'node:assert/strict';
import { QuickNoteManager } from './quickNoteManager.js';

function createRepository() {
  return {
    items: [],
    create(item) { this.items.unshift(item); return item; },
    readAll() { return [...this.items]; }
  };
}

const repository = createRepository();
const events = [];
const manager = new QuickNoteManager({ repository, events: { createEvent(event) { events.push(event); return event; } } });

const schedule = manager.classify('明天上午九点开例会');
assert.equal(schedule.category, 'schedule');
assert.match(schedule.timeText, /^明天上午 09:00（\d{4}年\d{1,2}月\d{1,2}日）$/);
assert.ok(schedule.scheduledAt);
assert.equal(schedule.missing, '');
assert.equal(schedule.status, 'needs_confirmation');

const morningSchedule = manager.classify('明天早上9点和销售团队开会');
assert.equal(morningSchedule.category, 'schedule');
assert.match(morningSchedule.timeText, /^明天早上 09:00（\d{4}年\d{1,2}月\d{1,2}日）$/);
assert.equal(morningSchedule.content, '和销售团队开会');

const afternoonSchedule = manager.classify('后天下午三点复盘');
assert.equal(afternoonSchedule.category, 'schedule');
assert.match(afternoonSchedule.timeText, /^后天下午 15:00（\d{4}年\d{1,2}月\d{1,2}日）$/);

const colloquialCases = [
  ['今晚8点', { time: '20:00', content: '', needsConfirmation: true, normalized: '今天晚上8点' }],
  ['今晚八点', { time: '20:00', content: '', needsConfirmation: true, normalized: '今天晚上八点' }],
  ['今晚8点开会', { time: '20:00', content: '开会', needsConfirmation: false, normalized: '今天晚上8点开会' }],
  ['明早9点提醒我', { time: '09:00', content: '', needsConfirmation: true, normalized: '明天上午9点提醒我' }],
  ['周五晚8点见客户', { time: '20:00', content: '见客户', needsConfirmation: false, normalized: '本周五晚上8点见客户' }],
  ['下午3点打电话', { time: '15:00', content: '打电话', needsConfirmation: false, normalized: '下午3点打电话' }],
  ['晚8点吃饭', { time: '20:00', content: '吃饭', needsConfirmation: false, normalized: '今天晚上8点吃饭' }],
  ['20点开会', { time: '20:00', content: '开会', needsConfirmation: false, normalized: '20点开会' }],
  ['八点半出门', { time: '08:30', content: '出门', needsConfirmation: false, normalized: '八点半出门' }],
  ['凌晨一点提醒我', { time: '01:00', content: '', needsConfirmation: true, normalized: '凌晨一点提醒我' }]
];

const colloquialResults = colloquialCases.map(([input, expected]) => {
  const result = manager.classify(input);
  assert.equal(result.normalizedText, expected.normalized, input);
  assert.equal(result.time, expected.time, input);
  assert.equal(result.content, expected.content, input);
  assert.equal(result.needsConfirmation, expected.needsConfirmation, input);
  assert.ok(result.date, input);
  return {
    input,
    normalizedText: result.normalizedText,
    date: result.date,
    time: result.time,
    content: result.content,
    needsConfirmation: result.needsConfirmation
  };
});

const supportedExpressions = [
  ['今天晚上8点', '20:00'],
  ['今天晚上八点', '20:00'],
  ['今夜8点', '20:00'],
  ['晚上8点', '20:00'],
  ['20:00', '20:00'],
  ['明晚7点半', '19:30'],
  ['后天上午10点', '10:00'],
  ['下周一早上9点', '09:00'],
  ['中午12点', '12:00']
];

supportedExpressions.forEach(([input, expectedTime]) => {
  const result = manager.classify(input);
  assert.equal(result.time, expectedTime, input);
  assert.ok(result.date, input);
});

const reminder = manager.classify('周五跟进张总');
assert.equal(reminder.category, 'reminder');
assert.equal(reminder.status, 'needs_confirmation');
assert.match(reminder.missing, /时间/);

assert.equal(manager.classify('今天完成了新品方案').category, 'work_log');
assert.equal(manager.classify('记一下客户喜欢浅色实木家具').category, 'note');

const saved = manager.save({ ...schedule, category: 'schedule', status: 'confirmed' });
assert.equal(saved.status, 'confirmed');
assert.equal(manager.listNotes().length, 1);
assert.equal(events[0].title, 'quick_note_saved');
assert.equal(events[0].metadata.category, 'schedule');

const assistedManager = new QuickNoteManager({
  repository: createRepository(),
  events: { createEvent() {} },
  ai: { async classify() { return { content: 'category: reminder' }; } }
});
const assisted = await assistedManager.classifyWithAI('记一下客户更喜欢浅色实木家具');
assert.equal(assisted.category, 'reminder');

console.table(colloquialResults);
console.log('Quick note manager tests PASS');
