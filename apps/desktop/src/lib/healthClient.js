const fallbackMessages = {
  AUTH_REQUIRED: '请先登录，再打开健康。',
  HEALTH_UNAVAILABLE: '健康功能暂时不可用，请稍后重试。',
  HEALTH_REVISION_CONFLICT: '记录已被修改。当前输入仍保留，请刷新核对。',
  HEALTH_CONSENT_REQUIRED: '请先在健康档案确认保存授权。',
  HEALTH_STORAGE_CONSENT_REQUIRED: '请先在健康档案确认保存授权。',
  NETWORK_ERROR: '连接中断，操作尚未确认成功。当前输入仍保留，请重试。',
  INVALID_RESPONSE: '没有收到有效结果，请稍后重试。'
};
const select = (input, keys) => Object.fromEntries(keys.filter(key => input?.[key] !== undefined).map(key => [key, input[key]]));
const recordPath = id => `/records/${encodeURIComponent(id)}`;
export const healthIdempotencyKey = () => globalThis.crypto?.randomUUID?.() || `health-${Date.now()}-${Math.random().toString(36).slice(2)}`;
export function healthLocalDateTimeToIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请填写完整的日期和时间。');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('日期或时间无效，请重新选择。');
  const offset = -date.getTimezoneOffset(),
    sign = offset >= 0 ? '+' : '-',
    pad = n => String(Math.abs(n)).padStart(2, '0');
  return `${value}:00${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}
export function healthIsoToLocal(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function createHealthClient({
  fetchImpl = globalThis.fetch
} = {}) {
  async function request(path = '', method = 'GET', input) {
    let response;
    try {
      response = await fetchImpl(`/api/health${path}`, {
        method,
        credentials: 'same-origin',
        ...(input === undefined ? {} : {
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(input)
        })
      });
    } catch {
      const error = new Error(fallbackMessages.NETWORK_ERROR);
      error.code = 'NETWORK_ERROR';
      throw error;
    }
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) {
      const code = body?.code || (response.status === 401 ? 'AUTH_REQUIRED' : 'HEALTH_UNAVAILABLE');
      const error = new Error(body?.message || fallbackMessages[code] || fallbackMessages.HEALTH_UNAVAILABLE);
      error.code = code;
      error.status = response.status;
      throw error;
    }
    if (!body || body.ok !== true) {
      const error = new Error(fallbackMessages.INVALID_RESPONSE);
      error.code = 'INVALID_RESPONSE';
      throw error;
    }
    return body;
  }
  async function recordRequest(...args) {
    const body = await request(...args);
    if (!body.record?.id) {
      const error = new Error(fallbackMessages.INVALID_RESPONSE);
      error.code = 'INVALID_RESPONSE';
      throw error;
    }
    return body.record;
  }
  return {
    load: () => request(),
    catalog: () => request('/catalog'),
    recipes: servings => request(`/recipes?servings=${encodeURIComponent(servings)}`).then(r => r.recipes),
    saveProfile: input => recordRequest('/profile', 'PUT', select(input, ['payload', 'revision', 'idempotencyKey'])),
    createRecord: input => recordRequest('/records', 'POST', select(input, ['kind', 'occurredOn', 'payload', 'idempotencyKey'])),
    getRecord: id => recordRequest(recordPath(id)),
    updateRecord: (id, input) => recordRequest(recordPath(id), 'PATCH', select(input, ['revision', 'payload', 'occurredOn'])),
    removeRecord: (id, revision) => request(recordPath(id), 'DELETE', {
      revision,
      confirmed: true
    }),
    reminderAction: (id, input) => recordRequest(`/reminders/${encodeURIComponent(id)}/action`, 'POST', select(input, ['revision', 'action', 'scheduledAt'])),
    draftPlan: input => recordRequest('/plans/draft', 'POST', select(input, ['request', 'startDate', 'mode', 'idempotencyKey'])),
    confirmPlan: (id, revision) => recordRequest(`/plans/${encodeURIComponent(id)}/confirm`, 'POST', {
      revision
    }),
    changePlan: (id, input) => recordRequest(`/plans/${encodeURIComponent(id)}/change`, 'POST', select(input, ['revision', 'date', 'slot', 'recipeId', 'exerciseIds', 'minutes', 'servings', 'idempotencyKey'])),
    shopping: id => request(`/plans/${encodeURIComponent(id)}/shopping`).then(r => r.items),
    summary: ({
      from,
      to
    }) => request(`/summary?${new URLSearchParams({
      from,
      to
    })}`).then(r => r.summary),
    importReport: input => recordRequest('/reports/import', 'POST', select(input, ['filename', 'dataBase64', 'consent', 'idempotencyKey'])),
    confirmReport: (id, input) => recordRequest(`/reports/${encodeURIComponent(id)}/confirm`, 'POST', select(input, ['revision', 'examDate', 'institution', 'items', 'confirmedSelf'])),
    reportFileUrl: id => `/api/health/reports/${encodeURIComponent(id)}/file`,
    exportAll: () => request('/export'),
    deleteAll: () => request('', 'DELETE', {
      confirmed: true
    })
  };
}
