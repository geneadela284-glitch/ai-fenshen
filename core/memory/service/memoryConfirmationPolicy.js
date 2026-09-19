const AUTO_SAVE_TYPES = new Set(['expense', 'income', 'schedule', 'todo', 'reminder']);
const EXPLICIT_REMEMBER_RE = /记住|记一下|记录一下|保存一下|帮我保存/;
const DO_NOT_REMEMBER_RE = /(?:不要|不|别)记住/;
const AMBIGUOUS_AMOUNT_RE = /(?:可能|大约|约|左右).{0,20}(?:或者|或|还是|至|到).{0,20}(?:万|元|块)/;

export const memoryConfirmationModes = {
  AUTO_SAVE: 'auto_save',
  CONFIRM_BEFORE_SAVE: 'confirm_before_save',
  DO_NOT_SAVE: 'do_not_save'
};

export class MemoryConfirmationPolicy {
  constructor({ minimumConfidence = 0.75 } = {}) {
    this.minimumConfidence = minimumConfidence;
  }

  evaluate(analysis = {}) {
    const input = String(analysis.normalizedInput || '');
    const candidate = analysis.memoryCandidate;
    const decision = analysis.decision || {};

    if (!input) {
      return { mode: memoryConfirmationModes.DO_NOT_SAVE, code: 'MEMORY_INPUT_EMPTY', reason: 'empty_input' };
    }
    if (DO_NOT_REMEMBER_RE.test(input)) {
      return { mode: memoryConfirmationModes.DO_NOT_SAVE, code: 'MEMORY_NOT_WORTH_REMEMBERING', reason: 'user_opted_out' };
    }
    if (!decision.remember || !candidate) {
      return { mode: memoryConfirmationModes.DO_NOT_SAVE, code: 'MEMORY_NOT_WORTH_REMEMBERING', reason: decision.reason || 'not_worth_remembering' };
    }
    if (candidate.sensitivity === 'high') {
      return { mode: memoryConfirmationModes.CONFIRM_BEFORE_SAVE, code: 'MEMORY_CONFIRMATION_REQUIRED', reason: 'high_sensitivity' };
    }
    if (candidate.needsConfirmation || (candidate.eventTime && !candidate.summary)) {
      return { mode: memoryConfirmationModes.CONFIRM_BEFORE_SAVE, code: 'MEMORY_CONFIRMATION_REQUIRED', reason: 'incomplete_content' };
    }
    if (AMBIGUOUS_AMOUNT_RE.test(input)) {
      return { mode: memoryConfirmationModes.CONFIRM_BEFORE_SAVE, code: 'MEMORY_CONFIRMATION_REQUIRED', reason: 'ambiguous_amount' };
    }
    if (Number(candidate.confidence || 0) < this.minimumConfidence) {
      return { mode: memoryConfirmationModes.CONFIRM_BEFORE_SAVE, code: 'MEMORY_CONFIRMATION_REQUIRED', reason: 'low_confidence' };
    }
    if (AUTO_SAVE_TYPES.has(candidate.memoryType) || EXPLICIT_REMEMBER_RE.test(input)) {
      return { mode: memoryConfirmationModes.AUTO_SAVE, code: 'MEMORY_READY_TO_SAVE', reason: 'low_risk_complete_memory' };
    }
    return { mode: memoryConfirmationModes.CONFIRM_BEFORE_SAVE, code: 'MEMORY_CONFIRMATION_REQUIRED', reason: 'requires_user_confirmation' };
  }
}
