const UNKNOWN_YEAR_SENTINEL = 2000;
const CALENDAR_TYPES = new Set(['gregorian', 'lunar', 'unknown']);

function normalizedText(value) {
  return typeof value === 'string' ? value.normalize('NFKC').trim() : '';
}

function canonicalKey(value) {
  return normalizedText(value).replaceAll(' ', '');
}

function uniqueSourceValues(values) {
  const seen = new Set();
  const result = [];
  for (const candidate of values) {
    const text = normalizedText(candidate);
    const key = canonicalKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function digits(value) {
  return value.length > 0 && [...value].every((character) => character >= '0' && character <= '9');
}

function validGregorianDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateParts(value, calendarType) {
  const parts = normalizedText(value).split('-');
  if (parts.length !== 3 || parts.some((part) => !digits(part))) return null;
  const [year, month, day] = parts.map(Number);
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12) return null;
  if (calendarType === 'lunar') return day >= 1 && day <= 30 ? { year, month, day } : null;
  return validGregorianDate(year, month, day) ? { year, month, day } : null;
}

function birthdayValue(structuredValue) {
  const source = structuredValue && typeof structuredValue === 'object' && !Array.isArray(structuredValue)
    ? structuredValue
    : {};
  const calendarType = CALENDAR_TYPES.has(source.calendarType) ? source.calendarType : 'unknown';
  const parsed = dateParts(source.date, calendarType);
  const month = Number.isInteger(source.month) ? source.month : parsed?.month;
  const day = Number.isInteger(source.day) ? source.day : parsed?.day;
  const explicitYear = Object.hasOwn(source, 'year') ? source.year : undefined;
  const year = Number.isInteger(explicitYear)
    ? explicitYear
    : explicitYear === null || parsed?.year === UNKNOWN_YEAR_SENTINEL
      ? null
      : parsed?.year ?? null;
  const dayLimit = calendarType === 'lunar' ? 30 : 31;
  if (!Number.isInteger(month) || month < 1 || month > 12 ||
      !Number.isInteger(day) || day < 1 || day > dayLimit) return null;
  return {
    kind: 'calendar_date',
    date: { year, month, day },
    calendar_type: calendarType,
    lunar_leap_month: [true, false, 'unknown'].includes(source.lunarLeapMonth)
      ? source.lunarLeapMonth
      : 'unknown',
    recurrence: ['yearly', 'one_time', 'unknown'].includes(source.recurrence)
      ? source.recurrence
      : 'unknown'
  };
}

function longestCommonSourceSpan(left, right) {
  const a = [...left];
  const b = [...right];
  let best = [];
  for (let start = 0; start < a.length; start += 1) {
    for (let other = 0; other < b.length; other += 1) {
      const candidate = [];
      for (let offset = 0; a[start + offset] === b[other + offset] && a[start + offset] !== undefined; offset += 1) {
        candidate.push(a[start + offset]);
      }
      if (candidate.length > best.length) best = candidate;
    }
  }
  return best.length >= 2 ? best.join('') : null;
}

function sourceBoundLegacyOverlap(fragments) {
  if (fragments.length !== 2) return null;
  const anchor = longestCommonSourceSpan(fragments[0], fragments[1]);
  if (!anchor) return null;
  const secondIndex = fragments[1].indexOf(anchor);
  if (secondIndex < 0) return null;
  const before = [...fragments[1].slice(0, secondIndex)];
  const after = [...fragments[1].slice(secondIndex + anchor.length)];
  const recovered = [anchor];
  if (before.length > 1) recovered.unshift(before.slice(0, -1).join(''));
  if (after.length > 1) recovered.push(after.slice(1).join(''));
  const items = uniqueSourceValues(recovered);
  if (items.length < 2 || items.some((item) => !fragments.some((source) => source.includes(item)))) return null;
  return items;
}

function preferenceItems(structuredValue) {
  const source = structuredValue && typeof structuredValue === 'object' && !Array.isArray(structuredValue)
    ? structuredValue
    : {};
  const raw = Array.isArray(source.values)
    ? source.values
    : normalizedText(source.value).split('、');
  const fragments = raw.map(normalizedText).filter(Boolean);
  if (!fragments.length) return null;
  const exact = uniqueSourceValues(fragments);
  if (exact.length < fragments.length) return exact;
  return sourceBoundLegacyOverlap(exact) || exact;
}

export function canonicalizeMemoryValue({ predicate, structuredValue } = {}) {
  if (predicate === 'birthday') {
    const value = birthdayValue(structuredValue);
    return value
      ? { ok: true, value }
      : { ok: false, code: 'CANONICAL_BIRTHDAY_INCOMPLETE' };
  }
  if (predicate === 'preference_statement') {
    const items = preferenceItems(structuredValue);
    return items?.length
      ? { ok: true, value: { kind: 'string_set', items } }
      : { ok: false, code: 'CANONICAL_PREFERENCE_INCOMPLETE' };
  }
  if (predicate === 'favorite_preference_statement') {
    const item = normalizedText(structuredValue?.value);
    return item
      ? { ok: true, value: { kind: 'single_string', item } }
      : { ok: false, code: 'CANONICAL_FAVORITE_INCOMPLETE' };
  }
  return { ok: false, code: 'CANONICAL_PREDICATE_UNSUPPORTED' };
}
