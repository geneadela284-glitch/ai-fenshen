const DEFAULT_LOCALE = 'zh-CN';

function systemTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function zonedParts(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function toDateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function fromDateKey(key) {
  const [year, month, day] = String(key || '').split('-').map(Number);
  return { year, month, day };
}

function validCalendarDate(parts) {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  return date.getUTCFullYear() === parts.year
    && date.getUTCMonth() + 1 === parts.month
    && date.getUTCDate() === parts.day;
}

function shiftDate(key, days) {
  const parts = fromDateKey(key);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return toDateKey({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}

function monthStart(key, offset = 0) {
  const parts = fromDateKey(key);
  const date = new Date(Date.UTC(parts.year, parts.month - 1 + offset, 1));
  return toDateKey({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: 1 });
}

function yearStart(key, offset = 0) {
  const { year } = fromDateKey(key);
  return `${year + offset}-01-01`;
}

function weekStartMonday(key) {
  const parts = fromDateKey(key);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = date.getUTCDay() || 7;
  return shiftDate(key, 1 - day);
}

export function localDateTimeToUtc(dateKey, timezone, time = '00:00:00') {
  const date = fromDateKey(dateKey);
  const [hour = 0, minute = 0, second = 0] = String(time).split(':').map(Number);
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute, second);
  let instant = target;
  for (let index = 0; index < 4; index += 1) {
    const actual = zonedParts(new Date(instant), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const next = instant + (target - actualAsUtc);
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

function unresolved(timezone, warnings = ['date_range_unresolved']) {
  return {
    dateStatus: warnings.length === 1 && warnings[0] === 'date_range_unresolved' ? 'ABSENT' : 'INVALID',
    rangeType: 'unresolved',
    startAt: '',
    endAt: '',
    startDate: '',
    endDateExclusive: '',
    endDateInclusive: '',
    timezone,
    label: '',
    confidence: 0,
    warnings,
    requiresConfirmation: true,
    interval: '[startAt,endAt)'
  };
}

function resolved({ rangeType, startDate, endDateExclusive, timezone, label, confidence = 1, warnings = [] }) {
  return {
    dateStatus: 'RESOLVED',
    rangeType,
    startAt: localDateTimeToUtc(startDate, timezone).toISOString(),
    endAt: localDateTimeToUtc(endDateExclusive, timezone).toISOString(),
    startDate,
    endDateExclusive,
    endDateInclusive: shiftDate(endDateExclusive, -1),
    timezone,
    label,
    confidence,
    warnings,
    requiresConfirmation: false,
    interval: '[startAt,endAt)'
  };
}

function explicitDate(text, todayKey) {
  const match = text.match(/(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (!match) return null;
  const today = fromDateKey(todayKey);
  const parts = { year: Number(match[1] || today.year), month: Number(match[2]), day: Number(match[3]) };
  if (!validCalendarDate(parts)) return { invalid: true };
  return {
    startDate: toDateKey(parts),
    label: `${parts.year}年${parts.month}月${parts.day}日`
  };
}

function explicitDateRange(text, todayKey) {
  const match = text.match(/(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日\s*(?:到|至|[-—])\s*(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日/);
  if (!match) return null;
  const currentYear = fromDateKey(todayKey).year;
  const sharedYear = Number(match[1] || match[4] || currentYear);
  const start = { year: Number(match[1] || sharedYear), month: Number(match[2]), day: Number(match[3]) };
  const end = { year: Number(match[4] || sharedYear), month: Number(match[5]), day: Number(match[6]) };
  if (!validCalendarDate(start) || !validCalendarDate(end)) return { invalid: true };
  const startDate = toDateKey(start);
  const endDate = toDateKey(end);
  if (endDate < startDate) {
    return { ambiguous: !match[1] || !match[4], invalid: Boolean(match[1] && match[4]) };
  }
  return {
    startDate,
    endDateExclusive: shiftDate(endDate, 1),
    label: `${start.year}年${start.month}月${start.day}日至${end.year}年${end.month}月${end.day}日`
  };
}

function singleDayReferences(text, todayKey) {
  const dates = [];
  let invalid = false;
  const today = fromDateKey(todayKey);
  const explicitPattern = /(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日/g;
  for (const match of text.matchAll(explicitPattern)) {
    const parts = {
      year: Number(match[1] || today.year),
      month: Number(match[2]),
      day: Number(match[3])
    };
    if (!validCalendarDate(parts)) invalid = true;
    else dates.push(toDateKey(parts));
  }

  const relativePattern = /(大前天|三天前|前天|昨天|昨日|今天|今日|明天|明日|后天)/g;
  const offsets = {
    大前天: -3,
    三天前: -3,
    前天: -2,
    昨天: -1,
    昨日: -1,
    今天: 0,
    今日: 0,
    明天: 1,
    明日: 1,
    后天: 2
  };
  for (const match of text.matchAll(relativePattern)) dates.push(shiftDate(todayKey, offsets[match[1]]));
  return { dates, invalid };
}

export function resolveDateRange(expression = '', context = {}) {
  const text = String(expression || '').trim();
  const timezone = context.timezone || context.timeZone || systemTimezone();
  if (!isValidTimezone(timezone)) return unresolved(String(timezone || ''), ['timezone_invalid']);

  const now = new Date(context.now || context.currentTime || Date.now());
  if (Number.isNaN(now.getTime())) return unresolved(timezone, ['current_time_invalid']);
  const today = toDateKey(zonedParts(now, timezone));
  const dateRange = explicitDateRange(text, today);
  if (dateRange?.ambiguous) return unresolved(timezone, ['explicit_date_range_ambiguous']);
  if (dateRange?.invalid) return unresolved(timezone, ['explicit_date_range_invalid']);
  if (dateRange) {
    return resolved({
      rangeType: 'explicit_date_range',
      startDate: dateRange.startDate,
      endDateExclusive: dateRange.endDateExclusive,
      timezone,
      label: dateRange.label
    });
  }
  const references = singleDayReferences(text, today);
  if (references.invalid) return unresolved(timezone, ['explicit_date_invalid']);
  if (new Set(references.dates).size > 1) return unresolved(timezone, ['date_expression_conflict']);
  const explicit = explicitDate(text, today);
  if (explicit?.invalid) return unresolved(timezone, ['explicit_date_invalid']);
  if (explicit) {
    return resolved({
      rangeType: 'explicit_date',
      startDate: explicit.startDate,
      endDateExclusive: shiftDate(explicit.startDate, 1),
      timezone,
      label: explicit.label
    });
  }

  if (/最近\s*30\s*天/.test(text)) return resolved({ rangeType: 'last_30_days', startDate: shiftDate(today, -29), endDateExclusive: shiftDate(today, 1), timezone, label: '最近30天' });
  if (/最近\s*7\s*天/.test(text)) return resolved({ rangeType: 'last_7_days', startDate: shiftDate(today, -6), endDateExclusive: shiftDate(today, 1), timezone, label: '最近7天' });
  if (/大前天/.test(text)) return resolved({ rangeType: 'three_days_ago', startDate: shiftDate(today, -3), endDateExclusive: shiftDate(today, -2), timezone, label: '大前天' });
  if (/三天前/.test(text)) return resolved({ rangeType: 'three_days_ago', startDate: shiftDate(today, -3), endDateExclusive: shiftDate(today, -2), timezone, label: '三天前' });
  if (/前天/.test(text)) return resolved({ rangeType: 'day_before_yesterday', startDate: shiftDate(today, -2), endDateExclusive: shiftDate(today, -1), timezone, label: '前天' });
  if (/昨天|昨日/.test(text)) return resolved({ rangeType: 'yesterday', startDate: shiftDate(today, -1), endDateExclusive: today, timezone, label: '昨天' });
  if (/明天|明日/.test(text)) return resolved({ rangeType: 'tomorrow', startDate: shiftDate(today, 1), endDateExclusive: shiftDate(today, 2), timezone, label: '明天' });
  if (/后天/.test(text)) return resolved({ rangeType: 'day_after_tomorrow', startDate: shiftDate(today, 2), endDateExclusive: shiftDate(today, 3), timezone, label: '后天' });
  if (/下周末/.test(text)) {
    const startDate = shiftDate(weekStartMonday(today), 12);
    return resolved({ rangeType: 'next_weekend', startDate, endDateExclusive: shiftDate(startDate, 2), timezone, label: '下周末' });
  }
  if (/本周末|这个周末|周末/.test(text)) {
    const startDate = shiftDate(weekStartMonday(today), 5);
    return resolved({ rangeType: 'this_weekend', startDate, endDateExclusive: shiftDate(startDate, 2), timezone, label: '本周末' });
  }
  if (/上周|上一周/.test(text)) {
    const thisWeek = weekStartMonday(today);
    return resolved({ rangeType: 'last_week', startDate: shiftDate(thisWeek, -7), endDateExclusive: thisWeek, timezone, label: '上周' });
  }
  if (/本周|这周|这一周/.test(text)) {
    const startDate = weekStartMonday(today);
    return resolved({ rangeType: 'this_week', startDate, endDateExclusive: shiftDate(startDate, 7), timezone, label: '本周' });
  }
  if (/上月|上个月/.test(text)) return resolved({ rangeType: 'last_month', startDate: monthStart(today, -1), endDateExclusive: monthStart(today), timezone, label: '上月' });
  if (/本月|这个月/.test(text)) return resolved({ rangeType: 'this_month', startDate: monthStart(today), endDateExclusive: monthStart(today, 1), timezone, label: '本月' });
  if (/去年/.test(text)) return resolved({ rangeType: 'last_year', startDate: yearStart(today, -1), endDateExclusive: yearStart(today), timezone, label: '去年' });
  if (/今年/.test(text)) return resolved({ rangeType: 'this_year', startDate: yearStart(today), endDateExclusive: yearStart(today, 1), timezone, label: '今年' });
  if (/今天|今日/.test(text)) return resolved({ rangeType: 'today', startDate: today, endDateExclusive: shiftDate(today, 1), timezone, label: '今天' });

  return unresolved(timezone);
}

export function resolveDateRangeOrToday(expression = '', context = {}) {
  const resolvedRange = resolveDateRange(expression, context);
  return resolvedRange.dateStatus === 'ABSENT' ? resolveDateRange('今天', context) : resolvedRange;
}
