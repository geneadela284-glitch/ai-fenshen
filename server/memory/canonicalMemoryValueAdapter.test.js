import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalizeMemoryValue } from './canonicalMemoryValueAdapter.js';

test('adapts a legacy date-only birthday without inventing a calendar type', () => {
  const result = canonicalizeMemoryValue({
    predicate: 'birthday',
    structuredValue: { date: '2000-07-16' }
  });

  assert.deepEqual(result, {
    ok: true,
    value: {
      kind: 'calendar_date',
      date: { year: null, month: 7, day: 16 },
      calendar_type: 'unknown',
      lunar_leap_month: 'unknown',
      recurrence: 'unknown'
    }
  });
});

test('keeps a new lunar birthday canonical and complete', () => {
  const result = canonicalizeMemoryValue({
    predicate: 'birthday',
    structuredValue: {
      date: '2000-07-16', calendarType: 'lunar', year: null, month: 7, day: 16,
      lunarLeapMonth: 'unknown', recurrence: 'yearly'
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.value.calendar_type, 'lunar');
  assert.deepEqual(result.value.date, { year: null, month: 7, day: 16 });
});

test('deduplicates already atomic preference values by canonical exact key', () => {
  const result = canonicalizeMemoryValue({
    predicate: 'preference_statement',
    structuredValue: { value: '苹果、苹果、草莓', values: ['苹果', '苹果', '草莓'] }
  });

  assert.deepEqual(result, {
    ok: true,
    value: { kind: 'string_set', items: ['苹果', '草莓'] }
  });
});

test('recovers the exact online legacy overlap into source-bound atomic values', () => {
  const result = canonicalizeMemoryValue({
    predicate: 'preference_statement',
    structuredValue: {
      value: '水果是苹果、苹果和草莓',
      values: ['水果是苹果', '苹果和草莓']
    }
  });

  assert.deepEqual(result, {
    ok: true,
    value: { kind: 'string_set', items: ['苹果', '草莓'] }
  });
});

test('keeps a complex favorite as one value', () => {
  const result = canonicalizeMemoryValue({
    predicate: 'favorite_preference_statement',
    structuredValue: { value: '我煮的沸腾鱼' }
  });

  assert.deepEqual(result, {
    ok: true,
    value: { kind: 'single_string', item: '我煮的沸腾鱼' }
  });
});

test('fails closed for incomplete or unbound legacy values', () => {
  assert.deepEqual(canonicalizeMemoryValue({ predicate: 'birthday', structuredValue: { date: 'invalid' } }), {
    ok: false, code: 'CANONICAL_BIRTHDAY_INCOMPLETE'
  });
  assert.deepEqual(canonicalizeMemoryValue({ predicate: 'preference_statement', structuredValue: { value: '' } }), {
    ok: false, code: 'CANONICAL_PREFERENCE_INCOMPLETE'
  });
});
