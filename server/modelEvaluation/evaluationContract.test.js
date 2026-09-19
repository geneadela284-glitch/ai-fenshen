import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEvaluationMessages,
  EVALUATION_PARAMETERS,
  EVALUATION_VERSION,
  FORMAL_PROVIDER_IDS,
  FORMAL_CALL_LIMIT,
  FORMAL_INITIAL_CALLS,
  HARD_CALL_LIMIT,
  validateFrozenEvaluationSuite
} from './evaluationContract.js';
import { EVALUATION_CASES } from './evaluationCases.js';

test('frozen suite catches missing, duplicate, or category-shifted evaluation cases', () => {
  assert.equal(EVALUATION_VERSION, 'model-evaluation-m12-b1-v1');
  assert.deepEqual(FORMAL_PROVIDER_IDS, ['deepseek', 'qwen', 'kimi', 'zhipu']);
  assert.equal(EVALUATION_CASES.length, 24);
  assert.equal(new Set(EVALUATION_CASES.map(({ id }) => id)).size, 24);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(Object.groupBy(EVALUATION_CASES, ({ category }) => category))
        .map(([category, entries]) => [category, entries.length])
    ),
    { ordinary_chat: 4, semantic: 6, finance: 4, memory: 4, calendar: 4, stability: 2 }
  );
  assert.deepEqual(validateFrozenEvaluationSuite(EVALUATION_CASES), {
    valid: true,
    case_count: 24,
    provider_count: 4,
    initial_call_count: 96
  });
});

test('common contract fixes fair parameters and bounded calls for every provider', () => {
  assert.deepEqual(EVALUATION_PARAMETERS, {
    temperature: 0,
    max_tokens: 768,
    timeout_ms: 30000,
    timezone: 'Asia/Shanghai',
    now: '2026-07-27T12:00:00.000+08:00'
  });
  assert.equal(FORMAL_INITIAL_CALLS, 96);
  assert.equal(FORMAL_CALL_LIMIT, 96);
  assert.equal(HARD_CALL_LIMIT, 120);

  const messages = FORMAL_PROVIDER_IDS.map((providerId) =>
    buildEvaluationMessages(EVALUATION_CASES[0], { providerId })
  );
  assert.deepEqual(messages[0], messages[1]);
  assert.deepEqual(messages[1], messages[2]);
  assert.deepEqual(messages[2], messages[3]);
  assert.doesNotMatch(JSON.stringify(messages[0]), /deepseek|qwen|kimi|zhipu|doubao/i);
});

test('fixtures are synthetic and never carry owner authority or credential-shaped fields', () => {
  const serialized = JSON.stringify(EVALUATION_CASES);
  assert.doesNotMatch(
    serialized,
    /api.?key|authorization|cookie|password|private.?key|ownerUserId|owner_id|真实用户/i
  );
  assert.ok(EVALUATION_CASES.every(({ synthetic }) => synthetic === true));
});
