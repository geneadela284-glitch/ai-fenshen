function parts(date, timezone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).filter((item) => item.type !== 'literal').map((item) => [item.type, Number(item.value)]));
  return values;
}

export function localDateKey(date, timezone) {
  const value = parts(date, timezone);
  return `${value.year}-${String(value.month).padStart(2, '0')}-${String(value.day).padStart(2, '0')}`;
}

function zonedDateFromParts(value, timezone) {
  const assumedUtc = Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second, value.millisecond || 0);
  const observed = parts(new Date(assumedUtc), timezone);
  const observedUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
  return new Date(assumedUtc - (observedUtc - assumedUtc));
}

export function shiftLocalDays(date, timezone, dayDelta) {
  const value = parts(date, timezone);
  const calendar = new Date(Date.UTC(value.year, value.month - 1, value.day + dayDelta, value.hour, value.minute, value.second, date.getUTCMilliseconds()));
  return zonedDateFromParts({
    year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate(),
    hour: calendar.getUTCHours(), minute: calendar.getUTCMinutes(), second: calendar.getUTCSeconds(), millisecond: calendar.getUTCMilliseconds()
  }, timezone);
}

export function dateForMonthDay(now, timezone, month, day) {
  const current = parts(now, timezone);
  return zonedDateFromParts({ ...current, month, day, millisecond: now.getUTCMilliseconds() }, timezone);
}

export function periodIncludes(occurredAt, period, now, timezone) {
  const targetKey = localDateKey(new Date(occurredAt), timezone);
  const nowKey = localDateKey(now, timezone);
  if (period === 'today') return targetKey === nowKey;
  const target = new Date(`${targetKey}T00:00:00Z`);
  const current = new Date(`${nowKey}T00:00:00Z`);
  if (period === 'month') return targetKey.slice(0, 7) === nowKey.slice(0, 7);
  if (period === 'week') {
    const weekday = current.getUTCDay() || 7;
    const start = new Date(current);
    start.setUTCDate(current.getUTCDate() - weekday + 1);
    const end = new Date(start);
    end.setUTCDate(start.getUTCDate() + 7);
    return target >= start && target < end;
  }
  return true;
}
