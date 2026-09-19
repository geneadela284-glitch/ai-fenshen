function validTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    return timezone;
  } catch {
    return 'UTC';
  }
}

function calendarParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: validTimeZone(timezone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
}

function dateKey(date, timezone) {
  const parts = calendarParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function midnightUtc(dateText, timezone) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(target)) return null;
  if (new Date(target).toISOString().slice(0, 10) !== dateText) return null;
  let resolved = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = calendarParts(new Date(resolved), timezone);
    const perceived = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    resolved += target - perceived;
  }
  return new Date(resolved);
}

export function groupFinanceEntriesByDate(entries = []) {
  const groups = [];
  const lookup = new Map();
  for (const entry of entries) {
    const instant = new Date(entry?.occurredAt);
    if (Number.isNaN(instant.getTime())) continue;
    const timezone = validTimeZone(entry?.timezone || 'UTC');
    const key = dateKey(instant, timezone);
    let group = lookup.get(key);
    if (!group) {
      group = {
        key,
        label: new Intl.DateTimeFormat('zh-CN', {
          timeZone: timezone,
          month: 'long',
          day: 'numeric',
          weekday: 'short'
        }).format(instant),
        entries: []
      };
      lookup.set(key, group);
      groups.push(group);
    }
    group.entries.push(entry);
  }
  return groups;
}

export function customDateRange(startDate, endDate, timezone = 'UTC') {
  if (!String(startDate || '').trim() || !String(endDate || '').trim() || startDate > endDate) return null;
  const start = midnightUtc(startDate, timezone);
  const end = midnightUtc(endDate, timezone);
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const inclusiveEnd = new Date(`${endDate}T00:00:00.000Z`);
  inclusiveEnd.setUTCDate(inclusiveEnd.getUTCDate() + 1);
  const nextDate = inclusiveEnd.toISOString().slice(0, 10);
  const endExclusive = midnightUtc(nextDate, timezone);
  return {
    period: 'custom',
    startAt: start.toISOString(),
    endAt: endExclusive.toISOString()
  };
}

export function financeEntryState(entry = {}) {
  if (entry.deletedAt || entry.status === 'deleted') return 'deleted';
  if (entry.archivedAt) return 'archived';
  return 'active';
}

export function financeRevisionLabel(revision = {}) {
  if (revision.mutationType === 'update') return '修改账目';
  if (revision.mutationType === 'delete') return '删除账目';
  if (revision.mutationType === 'restore') return '恢复账目';
  if (revision.mutationType !== 'archive') return '账目状态变更';
  const archivedAt = revision.changes?.archivedAt;
  if (!archivedAt || !Object.hasOwn(archivedAt, 'before') || !Object.hasOwn(archivedAt, 'after')) {
    return '归档状态变更';
  }
  if (!archivedAt.before && archivedAt.after) return '归档账目';
  if (archivedAt.before && !archivedAt.after) return '取消归档';
  return '归档状态变更';
}
