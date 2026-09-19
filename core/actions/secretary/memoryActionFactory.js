import { getConfirmationPolicy } from './confirmationPolicy.js';

export function createMemoryAction({ name, type, memoryService }) {
  if (!memoryService || typeof memoryService.remember !== 'function') {
    throw new Error(`${name} 缺少 MemoryService`);
  }

  return {
    name,
    type,

    validate(proposal) {
      const input = String(proposal?.arguments?.input || '').trim();
      if (proposal?.actionName !== name || proposal?.actionType !== type) {
        return { ok: false, code: 'ACTION_PROPOSAL_MISMATCH', message: '行动提案不匹配。' };
      }
      if (!input) {
        return { ok: false, code: 'ACTION_INPUT_REQUIRED', message: '还需要补充要记录的内容。' };
      }
      return { ok: true, code: 'ACTION_VALID' };
    },

    prepare(proposal) {
      return Object.freeze({
        input: String(proposal.arguments.input).trim(),
        memoryContext: Object.freeze({ ...(proposal.arguments.memoryContext || {}) })
      });
    },

    confirm() {
      const policy = getConfirmationPolicy(type);
      return {
        required: policy.mode === 'confirm',
        code: policy.mode === 'confirm' ? 'ACTION_CONFIRMATION_REQUIRED' : 'ACTION_DIRECT',
        message: policy.mode === 'confirm' ? '需要确认后执行。' : ''
      };
    },

    execute(prepared) {
      const memoryWrite = memoryService.remember(prepared.input, {
        context: prepared.memoryContext
      });
      if (memoryWrite?.code === 'MEMORY_DUPLICATE_FOUND') {
        return {
          code: memoryWrite.code,
          data: { memoryWrite, record: null }
        };
      }
      if (memoryWrite?.ok && memoryWrite.code === 'MEMORY_SAVED') {
        return {
          code: memoryWrite.code,
          data: {
            memoryWrite,
            record: memoryWrite.data || null
          }
        };
      }
      throw new Error(memoryWrite?.code || 'MEMORY_STORAGE_FAILED');
    },

    async rollback({ execution } = {}) {
      const memoryId = execution?.data?.record?.id;
      if (memoryId && typeof memoryService.deleteMemory === 'function') {
        await memoryService.deleteMemory(memoryId);
      }
      return { ok: true };
    },

    audit(record) {
      return record;
    }
  };
}
