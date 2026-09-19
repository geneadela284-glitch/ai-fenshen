import { notificationRepository } from './notificationRepository.js';

const REMINDER_WINDOW_MS = 5 * 60 * 1000;

function validDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameLocalDay(first, second) {
  return first.getFullYear() === second.getFullYear()
    && first.getMonth() === second.getMonth()
    && first.getDate() === second.getDate();
}

function deliveryId(note) {
  return `${note.id}:${note.scheduledAt}`;
}

function reminderText(note) {
  return String(note.content || note.input || '你有一条待处理事项').trim();
}

export class NotificationManager {
  constructor({ repository = notificationRepository, notificationClass = null } = {}) {
    this.repository = repository;
    this.notificationClass = notificationClass;
  }

  getNotificationClass() {
    return this.notificationClass || (typeof Notification !== 'undefined' ? Notification : null);
  }

  getStatus() {
    const NotificationClass = this.getNotificationClass();
    if (!NotificationClass) return 'unsupported';
    return NotificationClass.permission || 'default';
  }

  async requestPermission() {
    const NotificationClass = this.getNotificationClass();
    if (!NotificationClass) return { status: 'unsupported', message: '当前环境不支持桌面通知。' };
    if (NotificationClass.permission === 'granted') return { status: 'granted', message: '桌面提醒已开启。' };
    if (NotificationClass.permission === 'denied') return { status: 'denied', message: '桌面通知已被浏览器禁止，请在浏览器设置中允许。' };
    const permission = await NotificationClass.requestPermission();
    return permission === 'granted'
      ? { status: 'granted', message: '桌面提醒已开启。' }
      : { status: permission, message: '未开启桌面提醒，应用内今日提醒仍可使用。' };
  }

  listTodayReminders(notes = [], currentDate = new Date()) {
    return notes
      .filter((note) => note.status === 'confirmed' && note.scheduledAt)
      .map((note) => ({ note, date: validDate(note.scheduledAt) }))
      .filter(({ date }) => date && sameLocalDay(date, currentDate))
      .sort((first, second) => first.date - second.date)
      .map(({ note }) => note);
  }

  listDueReminders(notes = [], currentDate = new Date()) {
    const currentTime = currentDate.getTime();
    return notes.filter((note) => {
      const date = validDate(note.scheduledAt);
      if (!date) return false;
      const elapsed = currentTime - date.getTime();
      return note.status === 'confirmed' && elapsed >= 0 && elapsed <= REMINDER_WINDOW_MS;
    });
  }

  wasDelivered(note) {
    return Boolean(this.repository.read(deliveryId(note)));
  }

  markDelivered(note) {
    const deliveredAt = new Date().toISOString();
    this.repository.create({
      id: deliveryId(note),
      noteId: note.id,
      scheduledAt: note.scheduledAt,
      deliveredAt
    });
    return deliveredAt;
  }

  notifyDueReminders(notes = [], currentDate = new Date()) {
    const NotificationClass = this.getNotificationClass();
    if (!NotificationClass || NotificationClass.permission !== 'granted') return [];

    return this.listDueReminders(notes, currentDate)
      .filter((note) => !this.wasDelivered(note))
      .flatMap((note) => {
        try {
          new NotificationClass('AI Work Center · 工作提醒', {
            body: reminderText(note),
            tag: deliveryId(note),
            renotify: false
          });
          this.markDelivered(note);
          return [note];
        } catch {
          return [];
        }
      });
  }
}

export const notificationManager = new NotificationManager();
