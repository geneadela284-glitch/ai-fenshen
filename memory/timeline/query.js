import { TimelineEventStatus, TimelineQueryPreset, deepFreezeTimeline } from './contracts.js';

function localParts(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
}

function zonedToUtc(year, month, day, timezone) {
  const desired = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = localParts(new Date(guess), timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    guess -= represented - desired;
  }
  return new Date(guess).toISOString();
}

function addCalendarDays(year, month, day, count) {
  const date = new Date(Date.UTC(year, month - 1, day + count));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export function timelinePresetRange(preset, timestamp, timezone) {
  if (preset === TimelineQueryPreset.ALL) return { from: null, to: null };
  const now = localParts(new Date(timestamp), timezone);
  if (preset === TimelineQueryPreset.TODAY || preset === TimelineQueryPreset.YESTERDAY) {
    const startDay = addCalendarDays(now.year, now.month, now.day, preset === TimelineQueryPreset.YESTERDAY ? -1 : 0);
    const endDay = addCalendarDays(startDay.year, startDay.month, startDay.day, 1);
    return { from: zonedToUtc(startDay.year, startDay.month, startDay.day, timezone), to: zonedToUtc(endDay.year, endDay.month, endDay.day, timezone) };
  }
  const year = preset === TimelineQueryPreset.LAST_YEAR ? now.year - 1 : now.year;
  return { from: zonedToUtc(year, 1, 1, timezone), to: zonedToUtc(year + 1, 1, 1, timezone) };
}

function same(value, expected) {
  return JSON.stringify(value) === JSON.stringify(expected);
}

function inRange(event, from, to) {
  const time = Date.parse(event.beginTime);
  return (!from || time >= Date.parse(from)) && (!to || time < Date.parse(to));
}

export class TimelineFilter {
  apply(data, query, context) {
    const preset = timelinePresetRange(query.preset, context.timestamp, context.timezone);
    const from = query.from || preset.from;
    const to = query.to || preset.to;
    let events = [...(data.events || [])]
      .filter((event) => query.includeHistorical || event.status !== TimelineEventStatus.HISTORICAL)
      .filter((event) => inRange(event, from, to))
      .filter((event) => !query.memoryTypes.length || query.memoryTypes.includes(event.type))
      .filter((event) => !query.subject || event.metadata.subject === query.subject)
      .filter((event) => !query.predicate || event.metadata.predicate === query.predicate)
      .filter((event) => query.normalizedValue === null || same(event.metadata.normalizedValue, query.normalizedValue))
      .filter((event) => !query.tags.length || query.tags.every((tag) => event.metadata.tags?.includes(tag)))
      .filter((event) => !query.memoryIds.length || event.memoryIds.some((id) => query.memoryIds.includes(id)))
      .filter((event) => !query.periodId || event.metadata.periodIds?.includes(query.periodId));
    events.sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id));
    events = events.slice(0, query.limit);
    const selectedMemoryIds = new Set(events.flatMap((event) => event.memoryIds));
    const periods = selectedMemoryIds.size === 0 ? [] : (data.periods || []).filter((period) => (
      (!query.periodId || period.id === query.periodId) &&
      period.memoryIds.some((id) => selectedMemoryIds.has(id))
    ));
    return deepFreezeTimeline({
      events,
      periods,
      conflicts: (data.conflicts || []).filter((conflict) => conflict.memoryIds.some((id) => selectedMemoryIds.has(id))),
      excluded: [...(data.excluded || [])],
      range: { from, to }
    });
  }
}
