export const ACTION_RESULT_STATUS = Object.freeze({
  SUCCESS: 'success',
  PENDING: 'pending',
  NEED_CONFIRMATION: 'need_confirmation',
  FAILED: 'failed',
  ROLLED_BACK: 'rolled_back'
});

const STATUS_VALUES = Object.values(ACTION_RESULT_STATUS);

export function createActionResult({
  status,
  code = '',
  message = '',
  data = null,
  proposalId = '',
  actionName = '',
  auditId = '',
  durationMs = 0,
  error = null
} = {}) {
  if (!STATUS_VALUES.includes(status)) {
    throw new Error(`Invalid Action Result status: ${String(status || '')}`);
  }

  return Object.freeze({
    ok: status === ACTION_RESULT_STATUS.SUCCESS,
    status,
    code: String(code || ''),
    message: String(message || ''),
    data,
    proposalId: String(proposalId || ''),
    actionName: String(actionName || ''),
    auditId: String(auditId || ''),
    durationMs: Math.max(0, Number(durationMs || 0)),
    error: error ? String(error) : null
  });
}
