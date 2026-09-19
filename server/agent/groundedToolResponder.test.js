import assert from 'node:assert/strict';
import test from 'node:test';

import { finalizeGroundedToolResponse } from './groundedToolResponder.js';

const evidenceBundle = {
  owner_id: 'owner-a',
  evidence: [{ evidence_id: 'evidence-1', predicate: 'birthday', value: { kind: 'calendar_date' } }]
};

const result = {
  ok: true, tool: 'calendar.convert', action: 'convert_calendar_date',
  evidence_ids: ['evidence-1'],
  data: { gregorian_date: '2026-08-28', target_year: 2026 },
  safe_user_message: '你妈妈是农历七月十六生日，2026年对应的公历日期是8月28日。'
};

test('Result Coverage requires Memory Evidence and deterministic Tool Result', () => {
  const covered = finalizeGroundedToolResponse({ evidenceBundle, toolResult: result });
  assert.deepEqual(covered, { ok: true, content: result.safe_user_message, coverage: 'memory_and_tool' });
  const repeatedMemoryOnly = finalizeGroundedToolResponse({
    evidenceBundle,
    toolResult: { ...result, data: null, safe_user_message: '你妈妈是农历七月十六生日。' }
  });
  assert.deepEqual(repeatedMemoryOnly, { ok: false, code: 'TOOL_RESULT_COVERAGE_FAILED' });
  const omittedToolDate = finalizeGroundedToolResponse({
    evidenceBundle,
    toolResult: { ...result, safe_user_message: '你妈妈是农历七月十六生日。' }
  });
  assert.deepEqual(omittedToolDate, { ok: false, code: 'TOOL_RESULT_COVERAGE_FAILED' });
});

test('Result Coverage rejects unbound evidence and unsafe visible values', () => {
  assert.equal(finalizeGroundedToolResponse({
    evidenceBundle,
    toolResult: { ...result, evidence_ids: ['other'] }
  }).ok, false);
  assert.equal(finalizeGroundedToolResponse({
    evidenceBundle,
    toolResult: { ...result, safe_user_message: 'undefined' }
  }).ok, false);
});
