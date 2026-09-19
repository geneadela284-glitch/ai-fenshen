const ALLOWED_ARGUMENTS = new Set([
  'source_calendar', 'target_calendar', 'target_year_reference', 'target_year', 'occurrence'
]);
const SOURCE_CALENDARS = new Set(['gregorian', 'solar', 'lunar']);

function localDateParts(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
  } catch {
    return null;
  }
}

function dateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysBetween(left, right) {
  return Math.round((Date.UTC(right.year, right.month - 1, right.day) - Date.UTC(left.year, left.month - 1, left.day)) / 86_400_000);
}

function normalizedCalendar(value) {
  return value === 'solar' ? 'gregorian' : value;
}

function validGregorianDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function gregorianAnniversary(year, month, day) {
  const anniversaryDay = month === 2 && day === 29 && !validGregorianDate(year, month, day)
    ? 28
    : day;
  return validGregorianDate(year, month, anniversaryDay)
    ? { year, month, day: anniversaryDay }
    : null;
}

function reject(code) {
  return { decision: 'REJECT', code };
}

export function evaluateCalendarToolContract({ plan, evidenceBundle, ownerId, timezone, now = new Date(), engine, semanticContext = null } = {}) {
  if (!ownerId || evidenceBundle?.owner_id !== ownerId || evidenceBundle?.evidence?.some((item) => item.owner_id !== ownerId)) {
    return reject('CALENDAR_OWNER_MISMATCH');
  }
  if (plan?.domain !== 'tool' || plan?.tool !== 'calendar.convert' || !['convert_calendar_date', 'next_occurrence', 'days_until'].includes(plan?.action)) {
    return reject('CALENDAR_PLAN_INVALID');
  }
  const args = plan.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !ALLOWED_ARGUMENTS.has(key)) ||
      !SOURCE_CALENDARS.has(args.source_calendar) || args.target_calendar !== 'gregorian' ||
      !['this_year', 'next_year', 'explicit_year', 'next_occurrence'].includes(args.target_year_reference) ||
      !['specified_year', 'next_occurrence'].includes(args.occurrence)) {
    return reject('CALENDAR_ARGUMENTS_INVALID');
  }
  const evidence = evidenceBundle.evidence?.find((item) => item.predicate === 'birthday' && item.status === 'confirmed');
  if (!evidence) return reject('CALENDAR_EVIDENCE_REQUIRED');
  const qualifiers = evidence.qualifiers || {};
  const calendarType = normalizedCalendar(qualifiers.calendar_type);
  if (calendarType === 'unknown' || !calendarType) {
    return {
      decision: 'ASK',
      code: 'CALENDAR_TYPE_REQUIRED',
      question: '这个生日是公历还是农历？'
    };
  }
  if (!['gregorian', 'lunar'].includes(calendarType)) return reject('CALENDAR_EVIDENCE_INVALID');
  if (normalizedCalendar(args.source_calendar) !== calendarType) return reject('CALENDAR_SOURCE_MISMATCH');
  const month = Number(qualifiers.month);
  const day = Number(qualifiers.day);
  if (!Number.isInteger(month) || month < 1 || month > 12 ||
      !Number.isInteger(day) || day < 1 ||
      (calendarType === 'lunar' ? day > 30 : !validGregorianDate(2000, month, day))) {
    return reject('CALENDAR_EVIDENCE_INVALID');
  }
  const today = localDateParts(now, timezone);
  if (!today) return reject('CALENDAR_TIMEZONE_INVALID');
  const semanticYearValue = Number(semanticContext?.qualifiers?.year ?? semanticContext?.qualifiers?.temporal_scope);
  const semanticYear = [today.year, today.year + 1].includes(semanticYearValue) ? semanticYearValue : null;
  let targetYear = semanticYear ?? (args.target_year_reference === 'next_year' ? today.year + 1 : today.year);
  if (!semanticYear && args.target_year_reference === 'explicit_year') {
    targetYear = Number(args.target_year);
    if (!Number.isInteger(targetYear) || targetYear < 1900 || targetYear > 2100) return reject('CALENDAR_TARGET_YEAR_INVALID');
  }

  if (calendarType === 'gregorian') {
    let converted = gregorianAnniversary(targetYear, month, day);
    if (!converted) return reject('CALENDAR_EVIDENCE_INVALID');
    if (!semanticYear && args.target_year_reference === 'next_occurrence' && dateKey(converted) < dateKey(today)) {
      targetYear += 1;
      converted = gregorianAnniversary(targetYear, month, day);
      if (!converted) return reject('CALENDAR_EVIDENCE_INVALID');
    }
    return {
      decision: 'ACCEPT',
      input: {
        action: semanticYear && plan.action !== 'days_until' ? 'convert_calendar_date' : plan.action,
        calendarType,
        targetYear,
        converted,
        daysUntil: plan.action === 'days_until' || (!semanticYear && args.target_year_reference === 'next_occurrence')
          ? daysBetween(today, converted)
          : null,
        month,
        day,
        leap: null,
        evidenceId: evidence.evidence_id,
        entityRelation: plan.required_evidence?.[0]?.entity_relation || plan.inherited_context?.previous_entity || null
      }
    };
  }

  let leap = qualifiers.lunar_leap_month;
  const leapMonth = engine.getLeapMonth(targetYear);
  if (leap === 'unknown' || leap === null || leap === undefined) {
    if (leapMonth === month) {
      return { decision: 'ASK', question: `这个生日是普通${month === 7 ? '七' : month}月还是闰${month === 7 ? '七' : month}月？`, code: 'CALENDAR_LEAP_MONTH_REQUIRED' };
    }
    leap = false;
  }
  if (typeof leap !== 'boolean') return reject('CALENDAR_LEAP_MONTH_INVALID');
  if (leap && leapMonth !== month) return reject('CALENDAR_LEAP_MONTH_INVALID');

  let converted;
  try { converted = engine.convertLunarToGregorian({ year: targetYear, month, day, leap }); } catch {
    return { decision: 'ERROR', code: 'CALENDAR_TOOL_FAILED', content: '暂时无法完成日期换算，请稍后再试。' };
  }
  if (!semanticYear && args.target_year_reference === 'next_occurrence' && dateKey(converted) < dateKey(today)) {
    targetYear += 1;
    const nextLeapMonth = engine.getLeapMonth(targetYear);
    if ((qualifiers.lunar_leap_month === 'unknown' || qualifiers.lunar_leap_month === null) && nextLeapMonth === month) {
      return { decision: 'ASK', question: `这个生日是普通${month === 7 ? '七' : month}月还是闰${month === 7 ? '七' : month}月？`, code: 'CALENDAR_LEAP_MONTH_REQUIRED' };
    }
    try { converted = engine.convertLunarToGregorian({ year: targetYear, month, day, leap }); } catch {
      return { decision: 'ERROR', code: 'CALENDAR_TOOL_FAILED', content: '暂时无法完成日期换算，请稍后再试。' };
    }
  }
  return {
    decision: 'ACCEPT',
    input: {
      action: semanticYear && plan.action !== 'days_until' ? 'convert_calendar_date' : plan.action,
      calendarType,
      targetYear,
      converted,
      daysUntil: plan.action === 'days_until' || (!semanticYear && args.target_year_reference === 'next_occurrence') ? daysBetween(today, converted) : null,
      month,
      day,
      leap,
      evidenceId: evidence.evidence_id,
      entityRelation: plan.required_evidence?.[0]?.entity_relation || plan.inherited_context?.previous_entity || null
    }
  };
}
