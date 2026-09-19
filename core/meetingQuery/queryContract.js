// Device-local meeting recall. Pure read/projection contract; no model or domain writes.
export const MEETING_QUERY_SCHEMA = 'meeting-chat-query-v1';
export const MEETING_QUERY_LIMIT = 10;
export const MEETING_QUERY_TEXT_LIMIT = 1800;

function invalid() { return Object.assign(new Error('MEETING_QUERY_INVALID'), { code: 'MEETING_QUERY_INVALID' }); }
export function meetingLocalDay(value, timezone = 'Asia/Shanghai') {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalid();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = key => parts.find(p => p.type === key)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function exactDay(year, month, day) {
  const d = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 2199 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day
    ? d.toISOString().slice(0, 10) : null;
}
export function classifyMeetingQuery(question, { timezone = 'Asia/Shanghai', now = new Date() } = {}) {
  const text = String(question || '').trim();
  // Creating tasks, capturing facts and changing meetings are outside this read capability.
  if (/(提醒我|记住|记一下|记录一下|帮我记|告诉你|删除|删掉|修改|改成|改为|新建|创建|开始录|继续录|暂停录|结束录|转写|转文字|生成|重新整理|帮我整理|安排.*开会)/.test(text)) return null;
  if (/(模板|范文|示例|如何|怎么|怎样|什么是|润色|改写|翻译|扩写|缩写|撰写|写一份|写个|编辑|优化|以下|下面|这段)/.test(text)) return null;
  if (/^(?:会议纪要|会议记录|会议总结)是什么[？?]?$/.test(text)) return null;
  // Match a whole retrieval question, not keywords embedded in writing/advice requests.
  const readingShape = text
    .replace(/\s/g, '')
    .replace(/^(?:(?:请|麻烦)(?:你)?|帮我)*(?:查询|查看|查一下|查查|找一下|找出|回顾|调出|调取|看一下|看看|告诉我|给我看|列出)?/, '')
    .replace(/\d{4}(?:年|[-/])\d{1,2}(?:月|[-/])\d{1,2}(?:日|号)?/g, '')
    .replace(/今天|昨天|前天|本周|上周|最近|昨晚|上午|下午|晚上|早上|\s/g, '')
    .replace(/^(?:和|与|及|的)+/, '');
  const topicQuery = /^(?:我的|已保存的|之前的)?(?:会议|开会|会谈)(?:的|上)?(?:内容|纪要|记录|总结|重点|结论|决策|待办)(?:是什么|有哪些|有什么|呢)?[？?]?$/.test(readingShape);
  const contentQuestion = /^(?:我|我们)?(?:会议|开会|会谈)(?:的|上|里)?(?:都)?(?:(?:开(?:了|过)|说(?:了|过)?|讲(?:了|过)?|谈(?:了|过)?|讨论(?:了|过)?|决定(?:了|过)?)(?:些)?(?:什么|啥|哪些)(?:内容|事情|重点|结论|决定|决策|待办)?(?:了)?|有哪些(?:内容|决定|待办|重点))(?:呢)?[？?]?$/.test(readingShape);
  // Existence/list questions are also reads. Require a question form for 有/没有;
  // statements such as 今天没有会议 must keep their existing intent.
  const existenceQuestion = /^(?:我|我们)?(?:(?:有没有|是否有)(?:会议|会谈|开会)(?:记录)?(?:呢|吗)?|(?:有|没有)(?:会议|会谈|开会)(?:记录)?(?:吗|么|嘛|[？?])|(?:没(?:有)?开(?:过)?会|开(?:过|了)?会|开会了)(?:吗|么|嘛))[？?]?$/.test(readingShape);
  const listQuestion = /^(?:(?:有)?(?:哪些|什么|几场|多少场)会议|开(?:了|过)?(?:什么|哪些|哪几场|几场|多少场)会)[？?]?$/.test(readingShape);
  if (!topicQuery && !contentQuestion && !existenceQuestion && !listQuestion) return null;
  const relative = [...text.matchAll(/(今天|昨天|前天)/g)].map(m => m[1]);
  const absolute = [...text.matchAll(/(\d{4})(?:年|[-/])(\d{1,2})(?:月|[-/])(\d{1,2})(?:日|号)?/g)];
  const dates = [];
  let bad = false;
  const today = meetingLocalDay(now, timezone);
  for (const word of relative) {
    const offset = { 今天: 0, 昨天: -1, 前天: -2 }[word];
    dates.push(new Date(Date.parse(`${today}T12:00:00Z`) + offset * 86400000).toISOString().slice(0, 10));
  }
  for (const m of absolute) {
    const date = exactDay(Number(m[1]), Number(m[2]), Number(m[3]));
    if (date) dates.push(date); else bad = true;
  }
  const unique = [...new Set(dates)];
  if (bad || unique.length !== 1 || /本周|上周|最近|昨晚|上午|下午|晚上|早上|[一二三四五六七八九十0-9]+点/.test(text.replace(/找到|查到/g, ''))) {
    return { state: 'needs_date', date: null, timezone };
  }
  return { state: 'ready', date: unique[0], timezone };
}
function keysOnly(object, allowed) {
  return object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).every(k => allowed.includes(k));
}
export function validateMeetingEvidence(value, { ownerId, question, timezone = 'Asia/Shanghai', now = new Date() }) {
  if (!keysOnly(value, ['schema', 'ownerId', 'question', 'timezone', 'date', 'queriedAt', 'state', 'total', 'meetings']) || JSON.stringify(value).length > 24000) throw invalid();
  const queryTime = typeof value.queriedAt === 'string' && value.queriedAt.length <= 64 ? Date.parse(value.queriedAt) : NaN;
  if (!Number.isFinite(queryTime) || !Number.isFinite(new Date(now).getTime()) || Math.abs(new Date(now).getTime() - queryTime) > 300000) throw invalid();
  const plan = classifyMeetingQuery(question, { timezone, now: new Date(queryTime) });
  if (!plan || value.schema !== MEETING_QUERY_SCHEMA || value.ownerId !== ownerId || value.question !== String(question).trim() || value.timezone !== timezone || value.date !== plan.date) throw invalid();
  if (!['ready', 'needs_date', 'unavailable'].includes(value.state) || (plan.state === 'needs_date' && value.state !== 'needs_date') || (plan.state === 'ready' && value.state === 'needs_date')) throw invalid();
  if (!Array.isArray(value.meetings) || value.meetings.length > MEETING_QUERY_LIMIT || !Number.isSafeInteger(value.total) || value.total < value.meetings.length || value.total > 1000000) throw invalid();
  if (value.state !== 'ready' && (value.total || value.meetings.length)) throw invalid();
  if (value.state === 'ready' && value.meetings.length !== Math.min(value.total, MEETING_QUERY_LIMIT)) throw invalid();
  const ids = new Set();
  for (const meeting of value.meetings) {
    if (!keysOnly(meeting, ['meetingId', 'title', 'createdAt', 'kind', 'text', 'sourceUpdatedAt', 'truncated'])) throw invalid();
    if (typeof meeting.meetingId !== 'string' || !meeting.meetingId || meeting.meetingId.length > 200 || ids.has(meeting.meetingId)) throw invalid();
    ids.add(meeting.meetingId);
    if (typeof meeting.title !== 'string' || !meeting.title || meeting.title.length > 120 || typeof meeting.text !== 'string' || meeting.text.length > MEETING_QUERY_TEXT_LIMIT) throw invalid();
    if (typeof meeting.createdAt !== 'string' || meeting.createdAt.length > 64 || meetingLocalDay(meeting.createdAt, timezone) !== value.date) throw invalid();
    if (!['saved_summary', 'transcript', 'mixed', 'no_text', 'unavailable'].includes(meeting.kind) || typeof meeting.truncated !== 'boolean') throw invalid();
    if (typeof meeting.sourceUpdatedAt !== 'string' || meeting.sourceUpdatedAt.length > 64 || (meeting.sourceUpdatedAt && !Number.isFinite(Date.parse(meeting.sourceUpdatedAt)))) throw invalid();
    if (['saved_summary', 'transcript', 'mixed'].includes(meeting.kind) !== Boolean(meeting.text.trim())) throw invalid();
  }
  return structuredClone(value);
}
function plain(value) {
  // Quote local source as text, not HTML, links or executable Markdown.
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[\\`*_{}\[\]()<>!#|~]/g, '\\$&');
}
export function formatMeetingReply(value) {
  if (value.state === 'needs_date') return '请指定要查看哪一天的会议，例如“昨天开会内容是什么？”或“2026年9月7日的会议纪要”。目前支持按天查询。';
  if (value.state === 'unavailable') return '暂时无法读取这台设备保存的会议记录。这不代表会议不存在；请确认使用的是录音时的账号和浏览器，也可以从会议列表查看。';
  if (!value.total) return `这台设备的当前账号中，没有找到 ${value.date} 创建的会议记录。其他设备或浏览器保存的会议暂时不会出现在这里。`;
  const lines = [`在这台设备的当前账号中，找到 ${value.date} 创建的 ${value.total} 场会议记录${value.total > value.meetings.length ? `，先显示其中 ${value.meetings.length} 场` : ''}：`];
  for (const [index, meeting] of value.meetings.entries()) {
    const time = new Intl.DateTimeFormat('zh-CN', { timeZone: value.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(meeting.createdAt));
    const label = { saved_summary: '已保存纪要', transcript: '转文字节选', mixed: '已有会议文字', no_text: '暂无文字', unavailable: '文字暂不可读' }[meeting.kind];
    lines.push('', `${index + 1}. **${plain(meeting.title)}**（${time}）`, '');
    if (meeting.text) {
      if (meeting.kind === 'saved_summary') lines.push(`已保存纪要${meeting.sourceUpdatedAt ? `（生成日期：${meetingLocalDay(meeting.sourceUpdatedAt, value.timezone)}）` : ''}：`);
      else lines.push(meeting.kind === 'mixed' ? '以下为已有会议文字：' : '以下为已有转文字节选：');
      lines.push(...plain(meeting.text).split('\n').map(line => `> ${line}`));
      if (meeting.truncated) lines.push('内容较长，此处仅展示部分文字，完整内容可在会议列表查看。');
    } else lines.push(meeting.kind === 'no_text' ? '这场会议还没有可读取的转文字或纪要，因此暂时无法回答具体内容。' : '这场会议的文字暂时无法读取，未据此生成内容。');
    lines.push(`来源：${value.date} ${time}《${plain(meeting.title)}》 · ${label}`);
  }
  return lines.join('\n');
}
