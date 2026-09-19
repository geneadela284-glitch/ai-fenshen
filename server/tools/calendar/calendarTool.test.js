import assert from 'node:assert/strict';
import test from 'node:test';

import { createCalendarTool } from './calendarTool.js';
import { createAssistantToolRegistry } from '../assistantToolRegistry.js';

const NOW = new Date('2026-07-23T04:00:00.000Z');

function plan(overrides = {}) {
  return {
    domain: 'tool', action: 'convert_calendar_date', tool: 'calendar.convert',
    arguments: {
      source_calendar: 'lunar', target_calendar: 'gregorian',
      target_year_reference: 'this_year', occurrence: 'specified_year',
      ...overrides
    },
    required_evidence: [{ entity_relation: 'mother', predicate: 'birthday', required_qualifiers: ['calendar_type', 'month', 'day', 'lunar_leap_month'] }],
    inherited_context: { previous_entity: 'mother', previous_predicate: 'birthday', previous_tool: null },
    confidence: 0.98, ambiguity: [], requires_confirmation: false, source_message_id: 'source-1'
  };
}

function evidence({ ownerId = 'owner-a', month = 7, day = 16, leap = 'unknown' } = {}) {
  return {
    source: 'memory_database', owner_id: ownerId,
    evidence: [{
      evidence_id: 'evidence-birthday', owner_id: ownerId, entity_id: 'mother-entity', predicate: 'birthday',
      value: { kind: 'calendar_date', calendar_type: 'lunar', date: { year: null, month, day }, lunar_leap_month: leap, recurrence: 'yearly' },
      qualifiers: { calendar_type: 'lunar', year: null, month, day, lunar_leap_month: leap, recurrence: 'yearly' },
      confidence: 0.99, source_message_id: 'memory-source', version: 3, status: 'confirmed'
    }]
  };
}

function gregorianPlan(overrides = {}) {
  return {
    ...plan(),
    action: overrides.action || 'days_until',
    arguments: {
      source_calendar: overrides.sourceCalendar || 'gregorian',
      target_calendar: 'gregorian',
      target_year_reference: overrides.targetYearReference || 'next_occurrence',
      occurrence: overrides.occurrence || 'next_occurrence',
      ...(Number.isInteger(overrides.targetYear) ? { target_year: overrides.targetYear } : {})
    },
    required_evidence: [{
      entity_relation: overrides.relation || 'self',
      predicate: 'birthday',
      required_qualifiers: ['calendar_type', 'month', 'day']
    }],
    inherited_context: {
      previous_entity: overrides.relation || 'self',
      previous_predicate: 'birthday',
      previous_tool: 'calendar.convert'
    }
  };
}

function gregorianEvidence({
  ownerId = 'owner-a',
  calendarType = 'gregorian',
  year = 1979,
  month = 5,
  day = 12
} = {}) {
  return {
    source: 'memory_database',
    owner_id: ownerId,
    evidence: [{
      evidence_id: 'evidence-gregorian-birthday',
      owner_id: ownerId,
      entity_id: 'self-entity',
      predicate: 'birthday',
      value: {
        kind: 'calendar_date',
        calendar_type: calendarType,
        date: { year, month, day },
        lunar_leap_month: 'unknown',
        recurrence: 'yearly'
      },
      qualifiers: {
        calendar_type: calendarType,
        year,
        month,
        day,
        lunar_leap_month: 'unknown',
        recurrence: 'yearly'
      },
      confidence: 0.99,
      source_message_id: 'memory-gregorian-source',
      version: 1,
      status: 'confirmed'
    }]
  };
}

test('RED: Calendar Tool supports a confirmed Gregorian birthday for date and days-until actions', async () => {
  const tool = createCalendarTool();
  const nextDate = await tool.run({
    plan: gregorianPlan({ action: 'next_occurrence' }),
    evidenceBundle: gregorianEvidence(),
    ownerId: 'owner-a',
    timezone: 'Asia/Shanghai',
    now: NOW
  });
  assert.equal(nextDate.decision, 'ACCEPT');
  assert.equal(nextDate.result.data.gregorian_date, '2027-05-12');
  assert.equal(nextDate.result.data.days_until, 293);
  assert.equal(nextDate.result.safe_user_message, '你是公历5月12日生日，下一次生日是2027年5月12日，还有293天。');

  const thisYear = await tool.run({
    plan: gregorianPlan({
      action: 'convert_calendar_date',
      targetYearReference: 'this_year',
      occurrence: 'specified_year',
      sourceCalendar: 'solar'
    }),
    evidenceBundle: gregorianEvidence(),
    ownerId: 'owner-a',
    timezone: 'Asia/Shanghai',
    now: NOW
  });
  assert.equal(thisYear.decision, 'ACCEPT');
  assert.equal(thisYear.result.data.gregorian_date, '2026-05-12');
  assert.equal(thisYear.result.data.days_until, null);
});

test('RED: Gregorian next occurrence handles birthday today, already-passed dates, and year boundary', async () => {
  const tool = createCalendarTool();
  const cases = [
    ['2026-05-12T04:00:00.000Z', '2026-05-12', 0],
    ['2026-05-13T04:00:00.000Z', '2027-05-12', 364],
    ['2026-12-31T04:00:00.000Z', '2027-05-12', 132]
  ];
  for (const [now, expectedDate, expectedDays] of cases) {
    const result = await tool.run({
      plan: gregorianPlan(),
      evidenceBundle: gregorianEvidence(),
      ownerId: 'owner-a',
      timezone: 'Asia/Shanghai',
      now: new Date(now)
    });
    assert.equal(result.decision, 'ACCEPT', now);
    assert.equal(result.result.data.gregorian_date, expectedDate, now);
    assert.equal(result.result.data.days_until, expectedDays, now);
  }
});

test('RED: Gregorian February 29 anniversaries use February 28 in non-leap years', async () => {
  const tool = createCalendarTool();
  const nonLeap = await tool.run({
    plan: gregorianPlan(),
    evidenceBundle: gregorianEvidence({ year: 2000, month: 2, day: 29 }),
    ownerId: 'owner-a',
    timezone: 'Asia/Shanghai',
    now: new Date('2025-01-01T04:00:00.000Z')
  });
  assert.equal(nonLeap.decision, 'ACCEPT');
  assert.equal(nonLeap.result.data.gregorian_date, '2025-02-28');
  assert.equal(nonLeap.result.data.days_until, 58);

  const leap = await tool.run({
    plan: gregorianPlan({
      action: 'convert_calendar_date',
      targetYearReference: 'explicit_year',
      targetYear: 2028,
      occurrence: 'specified_year'
    }),
    evidenceBundle: gregorianEvidence({ year: 2000, month: 2, day: 29 }),
    ownerId: 'owner-a',
    timezone: 'Asia/Shanghai',
    now: NOW
  });
  assert.equal(leap.decision, 'ACCEPT');
  assert.equal(leap.result.data.gregorian_date, '2028-02-29');
});

test('RED: Gregorian invalid dates reject and missing calendar qualifier asks one necessary question', async () => {
  const tool = createCalendarTool();
  const invalid = await tool.run({
    plan: gregorianPlan(),
    evidenceBundle: gregorianEvidence({ month: 4, day: 31 }),
    ownerId: 'owner-a',
    timezone: 'Asia/Shanghai',
    now: NOW
  });
  assert.deepEqual(invalid, { decision: 'REJECT', code: 'CALENDAR_EVIDENCE_INVALID' });

  const unknown = await tool.run({
    plan: gregorianPlan(),
    evidenceBundle: gregorianEvidence({ calendarType: 'unknown' }),
    ownerId: 'owner-a',
    timezone: 'Asia/Shanghai',
    now: NOW
  });
  assert.deepEqual(unknown, {
    decision: 'ASK',
    code: 'CALENDAR_TYPE_REQUIRED',
    question: '这个生日是公历还是农历？'
  });
});

test('Calendar Tool converts lunar birthday for this year and next year deterministically', async () => {
  const tool = createCalendarTool();
  const current = await tool.run({ plan: plan(), evidenceBundle: evidence(), ownerId: 'owner-a', timezone: 'Asia/Shanghai', now: NOW });
  assert.equal(current.decision, 'ACCEPT');
  assert.equal(current.result.data.gregorian_date, '2026-08-28');
  assert.equal(current.result.safe_user_message, '你妈妈是农历七月十六生日，2026年对应的公历日期是8月28日。');
  const next = await tool.run({
    plan: plan({ target_year_reference: 'next_year' }), evidenceBundle: evidence(),
    ownerId: 'owner-a', timezone: 'Asia/Shanghai', now: NOW
  });
  assert.equal(next.result.data.gregorian_date, '2027-08-17');
});

test('Calendar Tool computes next occurrence and days until from account timezone', async () => {
  const tool = createCalendarTool();
  const result = await tool.run({
    plan: plan({ target_year_reference: 'next_occurrence', occurrence: 'next_occurrence' }),
    evidenceBundle: evidence(), ownerId: 'owner-a', timezone: 'Asia/Shanghai', now: NOW
  });
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.result.data.gregorian_date, '2026-08-28');
  assert.equal(result.result.data.days_until, 36);
  assert.match(result.result.safe_user_message, /还有36天/);
});

test('Calendar Contract gives current trusted semantic year precedence over a conflicting Tool Plan', async () => {
  const tool = createCalendarTool();
  const result = await tool.run({
    plan: plan({ target_year_reference: 'next_occurrence', occurrence: 'next_occurrence' }),
    evidenceBundle: evidence(), ownerId: 'owner-a', timezone: 'Asia/Shanghai', now: NOW,
    semanticContext: {
      intent: 'memory_query', relation_to_owner: 'mother', predicate: 'birthday',
      qualifiers: { calendar_type: 'lunar', year: null, temporal_scope: '2027' }
    }
  });
  assert.equal(result.decision, 'ACCEPT');
  assert.equal(result.result.data.gregorian_date, '2027-08-17');
  assert.equal(result.result.data.days_until, null);
});

test('Calendar Contract asks only when unknown leap-month status changes the result', async () => {
  const fakeEngine = {
    getLeapMonth: (year) => year === 2044 ? 7 : 0,
    convertLunarToGregorian: ({ year, month, day, leap }) => ({ year, month: leap ? 9 : 8, day })
  };
  const tool = createCalendarTool({ engine: fakeEngine });
  const ambiguous = await tool.run({
    plan: plan({ target_year_reference: 'explicit_year', target_year: 2044 }),
    evidenceBundle: evidence({ leap: 'unknown' }), ownerId: 'owner-a', timezone: 'Asia/Shanghai', now: NOW
  });
  assert.deepEqual(ambiguous, { decision: 'ASK', question: '这个生日是普通七月还是闰七月？', code: 'CALENDAR_LEAP_MONTH_REQUIRED' });
  const explicit = await tool.run({
    plan: plan({ target_year_reference: 'explicit_year', target_year: 2044 }),
    evidenceBundle: evidence({ leap: true }), ownerId: 'owner-a', timezone: 'Asia/Shanghai', now: NOW
  });
  assert.equal(explicit.decision, 'ACCEPT');
  assert.equal(explicit.result.data.gregorian_date, '2044-09-16');
});

test('Calendar Contract rejects owner mismatch, missing evidence and model-supplied final dates', async () => {
  const tool = createCalendarTool();
  assert.equal((await tool.run({
    plan: plan(), evidenceBundle: evidence({ ownerId: 'owner-b' }), ownerId: 'owner-a', timezone: 'Asia/Shanghai', now: NOW
  })).code, 'CALENDAR_OWNER_MISMATCH');
  assert.equal((await tool.run({
    plan: plan(), evidenceBundle: { owner_id: 'owner-a', evidence: [] }, ownerId: 'owner-a', timezone: 'Asia/Shanghai', now: NOW
  })).code, 'CALENDAR_EVIDENCE_REQUIRED');
  assert.equal((await tool.run({
    plan: plan({ gregorian_date: '2026-01-01' }), evidenceBundle: evidence(), ownerId: 'owner-a', timezone: 'Asia/Shanghai', now: NOW
  })).code, 'CALENDAR_ARGUMENTS_INVALID');
});

test('Calendar Tool failure returns a safe deterministic error without repeating Memory as completion', async () => {
  const tool = createCalendarTool({ engine: {
    getLeapMonth: () => 0,
    convertLunarToGregorian() { throw new Error('internal calendar detail'); }
  } });
  const result = await tool.run({ plan: plan(), evidenceBundle: evidence(), ownerId: 'owner-a', timezone: 'Asia/Shanghai', now: NOW });
  assert.deepEqual(result, { decision: 'ERROR', code: 'CALENDAR_TOOL_FAILED', content: '暂时无法完成日期换算，请稍后再试。' });
});

test('Calendar registered Plan Schema requires a semantic conversion goal or trusted tool continuation', () => {
  const registry = createAssistantToolRegistry();
  registry.register(createCalendarTool());
  const ordinaryBirthdayQuery = registry.validatePlan('calendar.convert', {
    ...plan(), confidence: 0.7, ambiguity: ['用户没有明确要求日期换算'], requires_confirmation: true
  }, { contextPack: {
    memory_context: { intent: 'memory_query', relation_to_owner: 'mother', predicate: 'birthday', qualifiers: { calendar_type: 'unknown' } },
    tool_context: null
  } });
  assert.equal(ordinaryBirthdayQuery.ok, false);
  const explicitAgentConversion = registry.validatePlan('calendar.convert', plan(), { contextPack: {
    memory_context: { intent: 'memory_query', relation_to_owner: 'mother', predicate: 'birthday', qualifiers: { calendar_type: 'unknown', temporal_scope: 'stable' } },
    tool_context: null
  } });
  assert.equal(explicitAgentConversion.ok, true);
  const conversion = registry.validatePlan('calendar.convert', plan(), { contextPack: {
    memory_context: { intent: 'memory_query', relation_to_owner: 'mother', predicate: 'birthday', qualifiers: { calendar_type: 'gregorian' } },
    tool_context: null
  } });
  assert.equal(conversion.ok, true);
  const yearSpecificLunarOccurrence = registry.validatePlan('calendar.convert', plan(), { contextPack: {
    memory_context: {
      intent: 'memory_query', relation_to_owner: 'mother', predicate: 'birthday',
      qualifiers: { calendar_type: 'lunar', year: 2026, temporal_scope: '2026' }
    },
    tool_context: null
  } });
  assert.equal(yearSpecificLunarOccurrence.ok, true);
  const continuation = registry.validatePlan('calendar.convert', plan({ target_year_reference: 'next_year' }), { contextPack: {
    memory_context: { intent: 'memory_query', relation_to_owner: 'mother', predicate: 'birthday', qualifiers: { calendar_type: 'unknown' } },
    tool_context: { previous_entity: 'mother', previous_predicate: 'birthday', previous_tool: 'calendar.convert' }
  } });
  assert.equal(continuation.ok, true);
});
