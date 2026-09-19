import assert from 'node:assert/strict';
import { NotificationManager } from './notificationManager.js';

function createRepository() {
  return {
    items: [],
    create(item) { this.items.unshift(item); return item; },
    read(id) { return this.items.find((item) => item.id === id) || null; }
  };
}

const current = new Date('2026-07-11T08:00:00+08:00');
const notes = [
  {
    id: 'note-1',
    status: 'confirmed',
    category: 'schedule',
    content: '和销售团队开会',
    scheduledAt: '2026-07-11T09:00:00+08:00',
    dateText: '2026年7月11日'
  },
  {
    id: 'note-2',
    status: 'confirmed',
    category: 'reminder',
    content: '过期事项',
    scheduledAt: '2026-07-12T09:00:00+08:00'
  }
];

const calls = [];
class FakeNotification {
  static permission = 'granted';

  static async requestPermission() {
    return 'granted';
  }

  constructor(title, options) {
    calls.push({ title, options });
  }
}

const manager = new NotificationManager({ repository: createRepository(), notificationClass: FakeNotification });
assert.equal(manager.listTodayReminders(notes, current).length, 1);
assert.equal(manager.listTodayReminders(notes, current)[0].content, '和销售团队开会');
assert.equal(manager.notifyDueReminders(notes, new Date('2026-07-11T09:01:00+08:00')).length, 1);
assert.equal(calls[0].options.body, '和销售团队开会');
assert.equal(manager.notifyDueReminders(notes, new Date('2026-07-11T09:02:00+08:00')).length, 0);
assert.equal(manager.getStatus(), 'granted');

console.log('Notification manager tests PASS');
