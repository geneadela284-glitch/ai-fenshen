import { ACTION_RESULT_STATUS, createActionResult } from './actionResult.js';

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || 'Action execution failed');
}

export class ActionExecutor {
  constructor({ registry, auditRepository, now = () => new Date() } = {}) {
    if (!registry) throw new Error('ActionExecutor 缺少 registry');
    if (!auditRepository) throw new Error('ActionExecutor 缺少 auditRepository');
    this.registry = registry;
    this.auditRepository = auditRepository;
    this.now = now;
  }

  async run(proposal, context = {}) {
    const startedAt = this.now();
    const action = this.registry.get(proposal?.actionName);
    if (!action) {
      return this.finalize(null, proposal, startedAt, {
        status: ACTION_RESULT_STATUS.FAILED,
        code: 'ACTION_NOT_REGISTERED',
        message: '当前行动尚未注册。'
      }, context);
    }

    let prepared = null;
    let execution = null;
    try {
      const validation = await action.validate(proposal, context);
      if (validation?.ok === false) {
        return this.finalize(action, proposal, startedAt, {
          status: ACTION_RESULT_STATUS.PENDING,
          code: validation.code || 'ACTION_INPUT_REQUIRED',
          message: validation.message || '还需要补充信息。',
          data: validation.data || null
        }, context);
      }

      prepared = await action.prepare(proposal, context);
      const confirmation = await action.confirm(prepared, context);
      if (confirmation?.required && !context.confirmed) {
        return this.finalize(action, proposal, startedAt, {
          status: ACTION_RESULT_STATUS.NEED_CONFIRMATION,
          code: confirmation.code || 'ACTION_CONFIRMATION_REQUIRED',
          message: confirmation.message || '需要确认后执行。',
          data: confirmation.data || null
        }, context);
      }

      execution = await action.execute(prepared, context);
      return this.finalize(action, proposal, startedAt, {
        status: ACTION_RESULT_STATUS.SUCCESS,
        code: execution?.code || 'ACTION_SUCCEEDED',
        message: execution?.message || '',
        data: execution?.data ?? execution ?? null
      }, context);
    } catch (error) {
      try {
        await action.rollback({ proposal, prepared, execution, error }, context);
        return this.finalize(action, proposal, startedAt, {
          status: ACTION_RESULT_STATUS.ROLLED_BACK,
          code: 'ACTION_ROLLED_BACK',
          message: '行动未完成，已回滚。',
          error: errorMessage(error)
        }, context);
      } catch (rollbackError) {
        return this.finalize(action, proposal, startedAt, {
          status: ACTION_RESULT_STATUS.FAILED,
          code: 'ACTION_FAILED',
          message: '行动执行失败。',
          error: `${errorMessage(error)}; rollback: ${errorMessage(rollbackError)}`
        }, context);
      }
    }
  }

  async finalize(action, proposal = {}, startedAt, fields, context) {
    const durationMs = Math.max(0, this.now().getTime() - startedAt.getTime());
    const baseResult = createActionResult({
      ...fields,
      proposalId: proposal?.proposalId,
      actionName: proposal?.actionName,
      durationMs
    });
    const auditDraft = {
      proposalId: proposal?.proposalId,
      actionName: proposal?.actionName,
      actionType: proposal?.actionType,
      userId: proposal?.userId,
      resultStatus: baseResult.status,
      resultCode: baseResult.code,
      sourceType: proposal?.source?.type,
      sourceId: proposal?.source?.id,
      durationMs
    };

    if (action) {
      try {
        await action.audit(auditDraft, context);
      } catch {
        // Action-specific audit hooks cannot suppress the framework audit.
      }
    }
    try {
      const audit = this.auditRepository.record(auditDraft);
      return createActionResult({ ...baseResult, auditId: audit.auditId });
    } catch {
      return baseResult;
    }
  }
}
