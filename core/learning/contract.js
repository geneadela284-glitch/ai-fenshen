export function learningError(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}
export function requiredText(value, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw learningError('LEARNING_INPUT_INVALID');
  return value.trim();
}
export function validateStart(input = {}) {
  if (input.consentAI !== true) throw learningError('LEARNING_CONSENT_REQUIRED', 403);
  const language = input.language || 'en';
  if (language !== 'en') throw learningError('LANGUAGE_UNAVAILABLE');
  const level = input.level || 'beginner';
  if (!['beginner', 'intermediate', 'advanced'].includes(level)) throw learningError('LEVEL_INVALID');
  return { language, level, lessonId: requiredText(input.lessonId || (level === 'beginner' ? 'hello' : 'coffee'), 100),
    persist: input.persist === true, consentAI: true, operationId: requiredText(input.operationId, 160), helpLanguage: 'zh-CN' };
}
export function validateTeacherReply(value, transcript) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['replyEn', 'helpZh', 'feedback', 'goalReached'].includes(key)) ||
      typeof value.goalReached !== 'boolean' || !Array.isArray(value.feedback) || value.feedback.length > 3) throw learningError('TEACHER_REPLY_INVALID', 502);
  const replyEn = requiredText(value.replyEn, 1200);
  const helpZh = requiredText(value.helpZh, 1200);
  const feedback = value.feedback.map(item => {
    if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['original', 'suggestion', 'reasonZh'].includes(key))) throw learningError('TEACHER_REPLY_INVALID', 502);
    const original = requiredText(item.original, 500);
    if (!String(transcript).includes(original)) throw learningError('FEEDBACK_SOURCE_INVALID', 502);
    return { original, suggestion: requiredText(item.suggestion, 500), reasonZh: requiredText(item.reasonZh, 500) };
  });
  return { replyEn, helpZh, feedback, goalReached: value.goalReached };
}
const transitions = {
  ready: { start: 'active', delete: 'deleted' },
  active: { pause: 'paused', complete: 'completed', end: 'ended_early', delete: 'deleted' },
  paused: { resume: 'active', end: 'ended_early', delete: 'deleted' },
  completed: { delete: 'deleted' }, ended_early: { delete: 'deleted' }, deleted: {}
};
export function transitionSession(state, action) {
  const next = transitions[state]?.[action];
  if (!next) throw learningError('LEARNING_STATE_CONFLICT', 409);
  return next;
}
export function evidenceOutcome({ inputMode, hint, transcriptCorrected = false, goalReached }) {
  if (!goalReached) return 'needs_practice';
  if (inputMode !== 'voice') return 'text_practice';
  if (transcriptCorrected) return 'transcript_corrected';
  if (hint !== 'none') return 'supported_practice';
  return 'independent_this_attempt';
}
