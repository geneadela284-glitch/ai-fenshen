export const RECOVERY_GENERATION_STATUSES = Object.freeze(['idle', 'generating', 'generated', 'failed']);

function safeState(state = {}) {
  const status = RECOVERY_GENERATION_STATUSES.includes(state.status) ? state.status : 'idle';
  return { status, errorCode: String(state.errorCode || '') };
}

export function beginRecoveryGeneration(state = {}) {
  const current = safeState(state);
  if (current.status === 'generating' || current.status === 'generated') return { accepted: false, state: current };
  return { accepted: true, state: { status: 'generating', errorCode: '' } };
}

export function completeRecoveryGeneration(state = {}) {
  const current = safeState(state);
  if (current.status !== 'generating') return current;
  return { status: 'generated', errorCode: '' };
}

export function failRecoveryGeneration(state = {}, errorCode = 'RECOVERY_GENERATION_FAILED') {
  const current = safeState(state);
  return { status: 'failed', errorCode: String(errorCode || 'RECOVERY_GENERATION_FAILED') };
}

export function recoveryGenerationButtonLabel(status) {
  if (status === 'generating') return '正在生成…';
  if (status === 'generated') return '恢复凭据已生成';
  if (status === 'failed') return '重新生成恢复凭据';
  return '生成一次性恢复凭据';
}

