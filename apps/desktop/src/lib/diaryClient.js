const messages = {
  AUTH_REQUIRED: '请先登录，再打开日记。',
  VERSION_CONFLICT: '这篇日记已在别处更新。你的草稿仍保留在这里，请先核对最新原文。',
  NOT_FOUND: '这篇日记已不存在，请刷新目录。',
  NETWORK_ERROR: '连接中断，操作尚未确认成功。请保留当前草稿并重试。',
  INVALID_RESPONSE: '未收到有效结果，操作尚未确认成功，请重试。',
  DIARY_UNAVAILABLE: '日记暂时不可用，请稍后重试。',
  INVALID_INPUT: '日期、正文或提醒信息不完整，请检查后重试。'
};
function fail(code, status) { const error = new Error(messages[code] || messages.DIARY_UNAVAILABLE); error.code = code; error.status = status; return error; }
function select(input, keys) { return Object.fromEntries(keys.filter(key => input[key] !== undefined).map(key => [key, input[key]])); }
export function createDiaryClient({fetchImpl = globalThis.fetch} = {}) {
  async function request(path = '', method = 'GET', input) {
    let response;
    try { response = await fetchImpl(`/api/diary${path}`, {method, credentials:'include', ...(input === undefined ? {} : {headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})}); }
    catch { throw fail('NETWORK_ERROR'); }
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.ok === false) {
      throw fail(response.status === 401 ? 'AUTH_REQUIRED' : response.status === 409 ? 'VERSION_CONFLICT' : response.status === 404 ? 'NOT_FOUND' : response.status === 400 ? 'INVALID_INPUT' : 'DIARY_UNAVAILABLE', response.status);
    }
    if (!body || body.ok !== true) throw fail('INVALID_RESPONSE');
    return body;
  }
  async function entryRequest(...args) { const result = await request(...args); if (!result.entry?.id) throw fail('INVALID_RESPONSE'); return result.entry; }
  const entryPath = id => `/${encodeURIComponent(id)}`;
  return {
    async list(filters = {}) { const search = new URLSearchParams(select(filters, ['date','q'])); const result = await request(search.size ? `?${search}` : ''); if (!Array.isArray(result.entries)) throw fail('INVALID_RESPONSE'); return result.entries; },
    get: id => entryRequest(entryPath(id)),
    create: input => entryRequest('', 'POST', select(input, ['title','body','occurredOn','source','reminder','idempotencyKey'])),
    update: (id, input) => entryRequest(entryPath(id), 'PATCH', select(input, ['revision','title','body','occurredOn','reminder'])),
    remove: (id, revision) => request(entryPath(id), 'DELETE', {revision, confirmed:true}),
    reminderAction: (id, input) => entryRequest(`${entryPath(id)}/reminder`, 'POST', select(input, ['revision','action','scheduledAt'])),
    exportAll: () => request('/export')
  };
}
export function diaryIsoToLocal(iso, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(iso)).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function diaryLocalToIso(value, timezone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请填写完整的提醒日期和时间。');
  const wall = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(wall)) throw new Error('提醒日期无效。');
  let instant = wall;
  for (let i=0; i<4; i+=1) {
    const shown = Date.parse(`${diaryIsoToLocal(instant,timezone)}:00Z`);
    instant += wall - shown;
  }
  if (diaryIsoToLocal(instant,timezone) !== value) throw new Error('该时区的这个时间不存在，请调整提醒时间。');
  if ([-3600000, 3600000].some(offset => diaryIsoToLocal(instant + offset, timezone) === value)) throw new Error('该时区的这个时间因夏令时出现两次，请选择一个不重复的时间。');
  return new Date(instant).toISOString();
}

export function diaryTimezoneLabel(timezone) {
  return ({'Asia/Shanghai':'北京时间','Asia/Chongqing':'北京时间','Asia/Harbin':'北京时间','Asia/Hong_Kong':'香港时间','Asia/Tokyo':'东京时间','Europe/London':'伦敦时间','America/New_York':'纽约时间','America/Los_Angeles':'洛杉矶时间','UTC':'协调世界时'})[timezone] || timezone;
}
