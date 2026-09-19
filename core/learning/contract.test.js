import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStart, validateTeacherReply, transitionSession, evidenceOutcome } from './contract.js';
import { scheduleReview } from './reviewSchedule.js';

test('a zero knowledge learner starts English with Chinese help without a placement exam', () => {
  assert.deepEqual(validateStart({ consentAI: true, operationId: 'start-0001' }), {
    language: 'en', level: 'beginner', lessonId: 'hello', persist: false,
    consentAI: true, operationId: 'start-0001', helpLanguage: 'zh-CN'
  });
  assert.throws(() => validateStart({ language: 'fr', consentAI: true, operationId: 'start-0001' }), { code: 'LANGUAGE_UNAVAILABLE' });
  assert.throws(() => validateStart({ consentAI: false, operationId: 'start-0001' }), { code: 'LEARNING_CONSENT_REQUIRED' });
});

test('teacher feedback must quote this turn and cannot invent pronunciation scores or unbounded feedback', () => {
  const value = { replyEn: 'Would you like a small cup?', helpZh: '你想要小杯吗？', feedback: [{ original: 'I wants coffee', suggestion: 'I want coffee', reasonZh: 'I 后用 want。' }], goalReached: false };
  assert.equal(validateTeacherReply(value, 'I wants coffee').feedback[0].original, 'I wants coffee');
  assert.throws(() => validateTeacherReply(value, 'Hello'), { code: 'FEEDBACK_SOURCE_INVALID' });
  assert.throws(() => validateTeacherReply({ ...value, pronunciationScore: 99 }, 'I wants coffee'), { code: 'TEACHER_REPLY_INVALID' });
  assert.throws(() => validateTeacherReply({ ...value, feedback: Array(4).fill(value.feedback[0]) }, 'I wants coffee'), { code: 'TEACHER_REPLY_INVALID' });
});

test('pausing is resumable, but deleted or completed learning cannot be replayed into active progress', () => {
  assert.equal(transitionSession('active', 'pause'), 'paused');
  assert.equal(transitionSession('paused', 'resume'), 'active');
  assert.throws(() => transitionSession('deleted', 'resume'), { code: 'LEARNING_STATE_CONFLICT' });
  assert.throws(() => transitionSession('completed', 'complete'), { code: 'LEARNING_STATE_CONFLICT' });
});

test('typed, corrected or fully prompted answers cannot earn independent spoken evidence', () => {
  assert.equal(evidenceOutcome({ inputMode: 'voice', hint: 'none', transcriptCorrected: false, goalReached: true }), 'independent_this_attempt');
  for (const input of [{ inputMode: 'text' }, { hint: 'full' }, { transcriptCorrected: true }]) {
    assert.notEqual(evidenceOutcome({ inputMode: 'voice', hint: 'none', goalReached: true, ...input }), 'independent_this_attempt');
  }
});

test('review dates follow evidence and failures do not increase mastery', () => {
  assert.deepEqual(scheduleReview({ stage: 0, independent: true, now: '2026-09-10T00:00:00.000Z' }), { stage: 1, dueAt: '2026-09-11T00:00:00.000Z', scheduleVersion: 1 });
  assert.deepEqual(scheduleReview({ stage: 1, independent: true, now: '2026-09-11T00:00:00.000Z' }), { stage: 2, dueAt: '2026-09-14T00:00:00.000Z', scheduleVersion: 1 });
  assert.deepEqual(scheduleReview({ stage: 2, independent: false, now: '2026-09-12T00:00:00.000Z' }), { stage: 0, dueAt: '2026-09-12T00:00:00.000Z', scheduleVersion: 1 });
});
