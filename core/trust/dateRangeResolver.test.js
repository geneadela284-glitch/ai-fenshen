import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDateRange, resolveDateRangeOrToday } from './dateRangeResolver.js';

const context = {
  now: '2026-07-14T01:30:00.000Z',
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  userId: 'user-a',
  workspaceId: 'workspace-a'
};

function assertRange(expression, expected) {
  const result = resolveDateRange(expression, context);
  assert.equal(result.rangeType, expected.rangeType, expression);
  assert.equal(result.startDate, expected.startDate, expression);
  assert.equal(result.endDateExclusive, expected.endDateExclusive, expression);
  assert.equal(result.label, expected.label, expression);
  assert.equal(result.timezone, 'Asia/Shanghai', expression);
  assert.equal(result.requiresConfirmation, false, expression);
  assert.match(result.startAt, /Z$/, expression);
  assert.match(result.endAt, /Z$/, expression);
}

test('resolves Chinese relative day, week, month and year ranges as half-open local ranges', () => {
  const cases = [
    ['今天', { rangeType: 'today', startDate: '2026-07-14', endDateExclusive: '2026-07-15', label: '今天' }],
    ['昨天', { rangeType: 'yesterday', startDate: '2026-07-13', endDateExclusive: '2026-07-14', label: '昨天' }],
    ['前天', { rangeType: 'day_before_yesterday', startDate: '2026-07-12', endDateExclusive: '2026-07-13', label: '前天' }],
    ['大前天', { rangeType: 'three_days_ago', startDate: '2026-07-11', endDateExclusive: '2026-07-12', label: '大前天' }],
    ['三天前', { rangeType: 'three_days_ago', startDate: '2026-07-11', endDateExclusive: '2026-07-12', label: '三天前' }],
    ['明天', { rangeType: 'tomorrow', startDate: '2026-07-15', endDateExclusive: '2026-07-16', label: '明天' }],
    ['周末', { rangeType: 'this_weekend', startDate: '2026-07-18', endDateExclusive: '2026-07-20', label: '本周末' }],
    ['这个周末', { rangeType: 'this_weekend', startDate: '2026-07-18', endDateExclusive: '2026-07-20', label: '本周末' }],
    ['本周', { rangeType: 'this_week', startDate: '2026-07-13', endDateExclusive: '2026-07-20', label: '本周' }],
    ['上周', { rangeType: 'last_week', startDate: '2026-07-06', endDateExclusive: '2026-07-13', label: '上周' }],
    ['本月', { rangeType: 'this_month', startDate: '2026-07-01', endDateExclusive: '2026-08-01', label: '本月' }],
    ['上月', { rangeType: 'last_month', startDate: '2026-06-01', endDateExclusive: '2026-07-01', label: '上月' }],
    ['今年', { rangeType: 'this_year', startDate: '2026-01-01', endDateExclusive: '2027-01-01', label: '今年' }],
    ['去年', { rangeType: 'last_year', startDate: '2025-01-01', endDateExclusive: '2026-01-01', label: '去年' }],
    ['最近7天', { rangeType: 'last_7_days', startDate: '2026-07-08', endDateExclusive: '2026-07-15', label: '最近7天' }],
    ['最近30天', { rangeType: 'last_30_days', startDate: '2026-06-15', endDateExclusive: '2026-07-15', label: '最近30天' }]
  ];

  cases.forEach(([expression, expected]) => assertRange(expression, expected));
});

test('resolves explicit Chinese dates without guessing another year', () => {
  assertRange('7月13日', {
    rangeType: 'explicit_date',
    startDate: '2026-07-13',
    endDateExclusive: '2026-07-14',
    label: '2026年7月13日'
  });
  assertRange('2025年12月31日', {
    rangeType: 'explicit_date',
    startDate: '2025-12-31',
    endDateExclusive: '2026-01-01',
    label: '2025年12月31日'
  });
});

test('resolves explicit Chinese date ranges as half-open intervals', () => {
  assertRange('7月1日到7月10日', {
    rangeType: 'explicit_date_range',
    startDate: '2026-07-01',
    endDateExclusive: '2026-07-11',
    label: '2026年7月1日至2026年7月10日'
  });

  const ambiguousCrossYear = resolveDateRange('12月30日到1月2日', context);
  assert.equal(ambiguousCrossYear.requiresConfirmation, true);
  assert.ok(ambiguousCrossYear.warnings.includes('explicit_date_range_ambiguous'));
});

test('keeps month-end and year-end boundaries exact', () => {
  const monthEnd = resolveDateRange('昨天', { ...context, now: '2026-03-01T04:00:00.000Z' });
  assert.equal(monthEnd.startDate, '2026-02-28');
  assert.equal(monthEnd.endDateExclusive, '2026-03-01');

  const yearEnd = resolveDateRange('三天前', { ...context, now: '2027-01-02T04:00:00.000Z' });
  assert.equal(yearEnd.startDate, '2026-12-30');
  assert.equal(yearEnd.endDateExclusive, '2026-12-31');
});

test('uses the requested timezone at cross-day boundaries', () => {
  const instant = '2026-07-13T16:30:00.000Z';
  const shanghai = resolveDateRange('今天', { ...context, now: instant, timezone: 'Asia/Shanghai' });
  const losAngeles = resolveDateRange('今天', { ...context, now: instant, timezone: 'America/Los_Angeles' });

  assert.equal(shanghai.startDate, '2026-07-14');
  assert.equal(losAngeles.startDate, '2026-07-13');
});

test('does not crash across a daylight-saving transition', () => {
  const result = resolveDateRange('今天', {
    ...context,
    now: '2026-03-08T12:00:00.000Z',
    timezone: 'America/Los_Angeles'
  });

  assert.equal(result.startDate, '2026-03-08');
  assert.equal(result.endDateExclusive, '2026-03-09');
  assert.equal(new Date(result.endAt).getTime() - new Date(result.startAt).getTime(), 23 * 60 * 60 * 1000);
});

test('returns confirmation state for an unsupported or invalid expression', () => {
  const unresolved = resolveDateRange('有空的时候', context);
  const invalidTimezone = resolveDateRange('今天', { ...context, timezone: 'Mars/Olympus' });

  assert.equal(unresolved.rangeType, 'unresolved');
  assert.equal(unresolved.requiresConfirmation, true);
  assert.equal(unresolved.startAt, '');
  assert.ok(unresolved.warnings.includes('date_range_unresolved'));
  assert.equal(invalidTimezone.requiresConfirmation, true);
  assert.ok(invalidTimezone.warnings.includes('timezone_invalid'));
});

test('RED: classifies date expressions as RESOLVED, ABSENT, or INVALID without treating transaction descriptions as dates', () => {
  for (const expression of ['早餐', '午餐', '晚餐', '加油', '买菜', '停车']) {
    const result = resolveDateRange(expression, context);
    assert.equal(result.dateStatus, 'ABSENT', expression);
  }

  for (const [expression, startDate] of [
    ['今天早餐花了30元', '2026-07-14'],
    ['昨天早餐花了30元', '2026-07-13'],
    ['7月20日早餐花了30元', '2026-07-20']
  ]) {
    const result = resolveDateRange(expression, context);
    assert.equal(result.dateStatus, 'RESOLVED', expression);
    assert.equal(result.startDate, startDate, expression);
  }

  for (const expression of ['2月30日早餐花了30元', '昨天和今天早餐花了30元']) {
    const result = resolveDateRange(expression, context);
    assert.equal(result.dateStatus, 'INVALID', expression);
    assert.equal(result.requiresConfirmation, true, expression);
  }
});

test('RED: resolveDateRangeOrToday defaults only ABSENT expressions and preserves invalid dates', () => {
  const absent = resolveDateRangeOrToday('早餐', context);
  const invalid = resolveDateRangeOrToday('2月30日早餐花了30元', context);

  assert.equal(absent.dateStatus, 'RESOLVED');
  assert.equal(absent.rangeType, 'today');
  assert.equal(invalid.dateStatus, 'INVALID');
  assert.equal(invalid.rangeType, 'unresolved');
});
