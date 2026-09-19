function invalidTimezone(timezone) {
  return Object.assign(new Error('TASK_TIMEZONE_INVALID'), { code: 'TASK_TIMEZONE_INVALID' });
}

export function assertTimezone(value) {
  const timezone = String(value || '').trim();
  if (!timezone || timezone.length > 100) throw invalidTimezone(timezone);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw invalidTimezone(timezone);
  }
  return timezone;
}

export function localDateKey(value, timezone) {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw Object.assign(new Error('TASK_SCHEDULE_INVALID'), { code: 'TASK_SCHEDULE_INVALID' });
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: assertTimezone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(instant).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addCalendarDays(dateKey, days) {
  const [year, month, day] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, '0'),
    String(next.getUTCDate()).padStart(2, '0')
  ].join('-');
}

export function groupTodayTomorrow(tasks, { timezone, now }) {
  const zone = assertTimezone(timezone);
  const todayKey = localDateKey(now, zone);
  const tomorrowKey = addCalendarDays(todayKey, 1);
  const today = [];
  const tomorrow = [];
  for (const task of tasks) {
    const key = localDateKey(task.scheduledAt, zone);
    if (key === todayKey) today.push(task);
    if (key === tomorrowKey) tomorrow.push(task);
  }
  return {
    state: today.length || tomorrow.length ? 'ready' : 'empty',
    today,
    tomorrow,
    range: { timezone: zone, today: todayKey, tomorrow: tomorrowKey }
  };
}
