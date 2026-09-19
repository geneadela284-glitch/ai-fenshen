import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import {
  EvaluationCache,
  redactEvaluationValue
} from './evaluationCache.js';
import {
  buildPreflightBudget,
  classifyEvaluationError,
  runEvaluation,
  shouldRetryTechnicalFailure
} from './evaluationRunner.js';
import {
  EVALUATION_PARAMETERS,
  HARD_CALL_LIMIT
} from './evaluationContract.js';

test('redaction catches credential escape in keys and nested response text', () => {
  const redacted = redactEvaluationValue({
    authorization: 'Bearer secret-token',
    nested: {
      content: 'answer contains secret-token',
      cookie: 'session-cookie',
      safe: 'ok'
    }
  }, ['secret-token', 'session-cookie']);
  assert.deepEqual(redacted, {
    authorization: '[REDACTED]',
    nested: {
      content: 'answer contains [REDACTED]',
      cookie: '[REDACTED]',
      safe: 'ok'
    }
  });
  assert.deepEqual(
    redactEvaluationValue({
      input_tokens: 123,
      output_tokens: 45,
      total_tokens: 168,
      max_tokens: 768,
      estimated_input_tokens_formal: 141908,
      estimated_input_tokens_hard: 177385,
      max_output_tokens_formal: 73728,
      max_output_tokens_hard: 92160,
      estimated_total_tokens_formal: 215636,
      estimated_total_tokens_hard: 269545,
      hard_token_budget: 500000,
      within_hard_token_budget: true,
      token_value: 'secret-token'
    }, ['secret-token']),
    {
      input_tokens: 123,
      output_tokens: 45,
      total_tokens: 168,
      max_tokens: 768,
      estimated_input_tokens_formal: 141908,
      estimated_input_tokens_hard: 177385,
      max_output_tokens_formal: 73728,
      max_output_tokens_hard: 92160,
      estimated_total_tokens_formal: 215636,
      estimated_total_tokens_hard: 269545,
      hard_token_budget: 500000,
      within_hard_token_budget: true,
      token_value: '[REDACTED]'
    }
  );
});

test('formal cache is append-only and refuses a second formal run', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'model-eval-cache-'));
  try {
    const cache = new EvaluationCache({ directory: dir });
    await cache.beginFormalRun({ evaluation_version: 'v1' });
    await cache.append({ provider_id: 'deepseek', case_id: 'A01', content: 'ok' });
    await assert.rejects(
      cache.beginFormalRun({ evaluation_version: 'v1' }),
      /FORMAL_EVALUATION_ALREADY_STARTED/
    );
    const lines = (await readFile(path.join(dir, 'raw-cache.ndjson'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).case_id, 'A01');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('retry classifier permits only one technical transport retry', () => {
  for (const value of [
    { error_type: 'timeout' },
    { error_type: 'network_error' },
    { error_type: 'http_502' },
    { error_type: 'http_503' },
    { error_type: 'http_504' }
  ]) {
    assert.equal(shouldRetryTechnicalFailure(value, 0), true);
    assert.equal(shouldRetryTechnicalFailure(value, 1), false);
  }
  for (const value of [
    { error_type: 'rate_limit' },
    { error_type: 'auth_failed' },
    { error_type: 'quota_exhausted' },
    { error_type: 'invalid_request' },
    { error_type: 'schema_invalid' }
  ]) {
    assert.equal(shouldRetryTechnicalFailure(value, 0), false);
  }
});

test('error classification keeps stable secret-free types', () => {
  assert.deepEqual(classifyEvaluationError({ code: 'TIMEOUT' }), {
    error_type: 'timeout', error_code: 'TIMEOUT', http_status: null
  });
  assert.equal(classifyEvaluationError({ code: 'HTTP_ERROR', status: 429 }).error_type, 'rate_limit');
  assert.equal(classifyEvaluationError({ code: 'INVALID_API_KEY', status: 401 }).error_type, 'auth_failed');
  assert.equal(classifyEvaluationError({ code: 'INSUFFICIENT_BALANCE', status: 402 }).error_type, 'quota_exhausted');
  assert.equal(classifyEvaluationError({ code: 'HTTP_ERROR', status: 503 }).error_type, 'http_503');
});

test('preflight reports 96 calls and a bounded token ceiling', () => {
  const cases = Array.from({ length: 24 }, (_, index) => ({
    id: `C${index}`, message: '合成消息', context: {}
  }));
  const budget = buildPreflightBudget({ cases });
  assert.equal(budget.initial_calls, 96);
  assert.equal(budget.hard_calls, HARD_CALL_LIMIT);
  assert.equal(budget.max_output_tokens_formal, 96 * EVALUATION_PARAMETERS.max_tokens);
  assert.equal(budget.max_output_tokens_hard, 120 * EVALUATION_PARAMETERS.max_tokens);
  assert.ok(budget.estimated_total_tokens_hard <= budget.hard_token_budget);
});

test('runner stops at hard limit and retries only the affected technical case once', async () => {
  const calls = [];
  const records = [];
  const cases = [{ id: 'A', message: 'x', context: {}, synthetic: true }];
  await runEvaluation({
    cases,
    providerTargets: [{ provider_id: 'deepseek', model_id: 'm' }],
    mode: 'canary',
    cache: { append: async (record) => records.push(record) },
    invoke: async ({ attempt }) => {
      calls.push(attempt);
      if (attempt === 1) throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' });
      return { content: '{"ok":true}', httpStatus: 200, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    }
  });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(records.length, 2);
  assert.equal(records[0].error_type, 'timeout');
  assert.equal(records[1].http_success, true);

  await assert.rejects(
    runEvaluation({
      cases: Array.from({ length: HARD_CALL_LIMIT + 1 }, (_, index) => ({
        id: `H${index}`, message: 'x', context: {}, synthetic: true
      })),
      providerTargets: [{ provider_id: 'deepseek', model_id: 'm' }],
      mode: 'canary',
      cache: { append: async () => {} },
      invoke: async () => ({ content: '{}', httpStatus: 200 })
    }),
    /EVALUATION_HARD_CALL_LIMIT_EXCEEDED/
  );
});
