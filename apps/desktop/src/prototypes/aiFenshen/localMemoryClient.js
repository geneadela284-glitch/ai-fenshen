import { explicitMemoryText, validateLocalMemoryEvidence } from '../../../../../core/memory/localEvidence.js';
const fail = code => Object.assign(new Error(code), { code });
export const memoryErrorText = error => ({ LOCAL_MEMORY_AUTH_REQUIRED:'请先完成登录，再读取本机记忆。', LOCAL_MEMORY_UNAVAILABLE:'当前版本无法读取本机长期记忆。',
  LOCAL_MEMORY_CORRUPT:'本机记忆校验失败，原文件已保留。请勿清空或重新安装应用。', LOCAL_MEMORY_CONFLICT:'记忆已发生变化，请刷新后重试。',
  CAS_CONFLICT:'这条记忆已更新，请刷新后再操作。', MEMORY_REQUEST_OBSOLETE:'这条记忆后来已更正或删除，不会重复保存旧内容。',
  MEMORY_CONFIRMATION_EXPIRED:'这次确认已过期，请重新发起保存。', LOCAL_MEMORY_WRITE_FAILED:'没有保存成功，请稍后重试。',
  OWNER_SCOPE_MISMATCH:'账号已变化，请返回后重新进入。' }[error?.code || error?.message] || '本机记忆暂时不可用，请稍后重试。');
export function createLocalMemoryClient({ ownerId, native = () => {
  const cap = globalThis.Capacitor;
  return cap?.isNativePlatform?.() ? (cap.Plugins?.MobileMemory || cap.registerPlugin?.('MobileMemory')) : null;
}, onResult = () => {}, onChanged = () => {}, clock = () => performance.now(), onTiming = () => {} }) {
  let closed = false;
  async function execute(command) {
    if (closed || !ownerId) throw fail('LOCAL_MEMORY_AUTH_REQUIRED');
    const plugin = native(); if (!plugin?.execute) throw fail('LOCAL_MEMORY_UNAVAILABLE');
    let result;
    try { result = await plugin.execute({ expectedOwner: ownerId, command: { ...command, ownerUserId: ownerId, spaceId: 'personal' } }); }
    catch (error) { throw fail(error?.code || error?.message || 'LOCAL_MEMORY_FAILED'); }
    if (closed) throw fail('OWNER_SCOPE_MISMATCH');
    if (['stored', 'corrected', 'deleted'].includes(result?.status)) {
      const receipt = result.receipt;
      if (receipt?.durable !== true || receipt.ownerUserId !== ownerId || receipt.spaceId !== 'personal' || receipt.memoryId !== result.memoryId || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1) throw fail('LOCAL_MEMORY_RECEIPT_INVALID');
      if (['remember', 'confirm', 'correct', 'delete'].includes(command.operation)) onChanged();
    }
    return result;
  }
  return { execute, activate() { closed = false; }, close() { closed = true; }, async prepare({ text, requestId, source = 'user_text', captureEligible = true, signal }) {
    const started = clock();
    const check = () => { if (closed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); }; check();
    let state = 'available', data = { revision: 0, items: [], revoked: [] };
    try {
      if (explicitMemoryText(text)) {
        const result = captureEligible ? await execute({ operation: 'remember', requestId, text, source: { type: source, id: requestId } }) : { status: 'rejected', reason: 'attachment_not_memory' };
        check(); onResult(requestId, result);
      }
      check(); data = await execute({ operation: 'query', text }); check();
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      state = ['LOCAL_MEMORY_UNAVAILABLE', 'LOCAL_MEMORY_AUTH_REQUIRED'].includes(error.code) ? 'unavailable' : 'error';
      if (explicitMemoryText(text)) onResult(requestId, { status: 'error', message: memoryErrorText(error) });
    }
    onTiming({ stage: 'memory_prepared', durationMs: Math.max(0, clock() - started), state, count: data.items?.length || 0 });
    return validateLocalMemoryEvidence({ schema:'local-memory-evidence:1', ownerId, spaceId:'personal', question:text,
      state, revision:data.revision || 0, items:state === 'available' ? data.items || [] : [], revoked:data.revoked || [] }, { ownerId, question:text });
  } };
}
