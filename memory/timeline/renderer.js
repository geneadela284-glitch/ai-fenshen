import { TimelineGranularity, createTimelineSegment, deepFreezeTimeline } from './contracts.js';

function parts(date, timezone) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  return Object.fromEntries(values.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function pad(value) { return String(value).padStart(2, '0'); }

function zonedStart(year, month, day, timezone) {
  const desired = Date.UTC(year, month - 1, day);
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date(guess));
    const value = Object.fromEntries(actual.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    guess -= Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second) - desired;
  }
  return new Date(guess).toISOString();
}

function calendarAdd(year, month, day, days) {
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function isoWeek(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil((((date - yearStart) / 86400000) + 1) / 7) };
}

function segmentInfo(date, granularity, timezone) {
  const value = parts(date, timezone);
  if (granularity === TimelineGranularity.YEAR) {
    return { label: `${value.year}`, beginTime: zonedStart(value.year, 1, 1, timezone), endTime: zonedStart(value.year + 1, 1, 1, timezone) };
  }
  if (granularity === TimelineGranularity.QUARTER) {
    const quarter = Math.floor((value.month - 1) / 3) + 1;
    const month = (quarter - 1) * 3 + 1;
    const nextYear = month === 10 ? value.year + 1 : value.year;
    const nextMonth = month === 10 ? 1 : month + 3;
    return { label: `${value.year}-Q${quarter}`, beginTime: zonedStart(value.year, month, 1, timezone), endTime: zonedStart(nextYear, nextMonth, 1, timezone) };
  }
  if (granularity === TimelineGranularity.MONTH) {
    const nextYear = value.month === 12 ? value.year + 1 : value.year;
    const nextMonth = value.month === 12 ? 1 : value.month + 1;
    return { label: `${value.year}-${pad(value.month)}`, beginTime: zonedStart(value.year, value.month, 1, timezone), endTime: zonedStart(nextYear, nextMonth, 1, timezone) };
  }
  if (granularity === TimelineGranularity.WEEK) {
    const localDate = new Date(Date.UTC(value.year, value.month - 1, value.day));
    const monday = calendarAdd(value.year, value.month, value.day, 1 - (localDate.getUTCDay() || 7));
    const next = calendarAdd(monday.year, monday.month, monday.day, 7);
    const week = isoWeek(value.year, value.month, value.day);
    return { label: `${week.year}-W${pad(week.week)}`, beginTime: zonedStart(monday.year, monday.month, monday.day, timezone), endTime: zonedStart(next.year, next.month, next.day, timezone) };
  }
  const next = calendarAdd(value.year, value.month, value.day, 1);
  return { label: `${value.year}-${pad(value.month)}-${pad(value.day)}`, beginTime: zonedStart(value.year, value.month, value.day, timezone), endTime: zonedStart(next.year, next.month, next.day, timezone) };
}

export class TimelineRenderer {
  render(data, { granularity = TimelineGranularity.MONTH, timezone = 'UTC' } = {}) {
    if (!Object.values(TimelineGranularity).includes(granularity)) throw new TypeError('TIMELINE_INVALID_GRANULARITY');
    const groups = new Map();
    for (const event of data.events || []) {
      const info = segmentInfo(new Date(event.beginTime), granularity, timezone);
      if (!groups.has(info.label)) groups.set(info.label, { info, events: [], periods: [] });
      groups.get(info.label).events.push(event);
    }
    for (const period of data.periods || []) {
      const info = segmentInfo(new Date(period.beginTime), granularity, timezone);
      if (!groups.has(info.label)) groups.set(info.label, { info, events: [], periods: [] });
      groups.get(info.label).periods.push(period);
    }
    const segments = [...groups.values()].map(({ info, events, periods }) => createTimelineSegment({
      id: `timeline-segment-${granularity}-${info.label}`,
      granularity,
      label: info.label,
      beginTime: info.beginTime,
      endTime: info.endTime,
      events: events.sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id)),
      periods: periods.sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id)),
      count: events.length,
      metadata: { timezone }
    })).sort((left, right) => left.beginTime.localeCompare(right.beginTime));
    return deepFreezeTimeline({ granularity, segments, eventCount: (data.events || []).length, periodCount: (data.periods || []).length });
  }
}
