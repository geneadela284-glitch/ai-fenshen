import {
  addDays,
  baseDateFromContext,
  formatDate,
  formatTime,
  normalizeMemoryInput,
  parseChineseNumber,
  removeTrailingPunctuation
} from './memoryNormalizer.js';
import { localDateTimeToUtc, resolveDateRange, resolveDateRangeOrToday } from '../trust/dateRangeResolver.js';

const amountPattern = /((?:\d+(?:\.\d+)?)|(?:[一二两三四五六七八九十百千万零〇点]+))\s*(万元|万|元|块)/;
const yuanJiaoFenPattern = /(?:(\d+|[一二两三四五六七八九十百千万零〇]+)\s*元)?\s*(?:(\d|[一二两三四五六七八九])\s*角)?\s*(?:(\d|[一二两三四五六七八九])\s*分)(?!钟)/;
const yuanJiaoPattern = /(\d+|[一二两三四五六七八九十百千万零〇]+)\s*元\s*(\d|[一二两三四五六七八九])\s*角/;
const jiaoPattern = /(\d|[一二两三四五六七八九])\s*角(?!落|度)/;
const weekdayMap = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function classifyCategory(text = '') {
  if (/喜欢|偏好|习惯|常用|不喜欢/.test(text)) return 'preference';
  if (/报价|价格|报\s*价/.test(text)) return 'quote';
  if (/收入|收到|收款|到账|货款|回款|进账|营收/.test(text)) return 'income';
  if (/支出|(?:又|再|另外|还)?花(?:了)?|花费|消费|付款|买|支付|成本|停车|零食|买菜|超市|购物|吃饭|午饭|晚饭|早饭|早餐|午餐|晚餐|饭钱|餐饮|外卖|打车|车费/.test(text)) return 'expense';
  if (/提醒|记得|别忘/.test(text)) return 'reminder';
  if (/待办|要做|需要完成|提交|处理/.test(text)) return 'todo';
  if (/今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]|上午|下午|晚上|点|:\d{2}|见|开会|会议/.test(text)) return 'schedule';
  if (/客户|张总|李总|王总|赵总/.test(text)) return 'customer_fact';
  if (/项目|方案|版本|上线|交付/.test(text)) return 'project_fact';
  return 'generic_memory';
}

export function extractAmount(text = '') {
  const normalized = normalizeMemoryInput(text);
  if (/-\s*\d+(?:\.\d+)?\s*(?:万元|万|元|块|角|分)/.test(normalized)) return null;
  const yuanJiaoFen = normalized.match(yuanJiaoFenPattern);
  if (yuanJiaoFen) {
    const yuan = yuanJiaoFen[1] ? parseChineseNumber(yuanJiaoFen[1]) : 0;
    const jiao = yuanJiaoFen[2] ? parseChineseNumber(yuanJiaoFen[2]) : 0;
    const fen = parseChineseNumber(yuanJiaoFen[3]);
    const amountMinor = yuan * 100 + jiao * 10 + fen;
    if (Number.isSafeInteger(amountMinor)) {
      return { amount: amountMinor / 100, amountMinor, currency: 'CNY', raw: yuanJiaoFen[0] };
    }
  }
  const yuanJiao = normalized.match(yuanJiaoPattern);
  if (yuanJiao) {
    const amountMinor = parseChineseNumber(yuanJiao[1]) * 100 + parseChineseNumber(yuanJiao[2]) * 10;
    if (Number.isSafeInteger(amountMinor)) return { amount: amountMinor / 100, amountMinor, currency: 'CNY', raw: yuanJiao[0] };
  }
  const jiao = normalized.match(jiaoPattern);
  if (jiao) {
    const amountMinor = parseChineseNumber(jiao[1]) * 10;
    if (Number.isSafeInteger(amountMinor)) return { amount: amountMinor / 100, amountMinor, currency: 'CNY', raw: jiao[0] };
  }
  const match = normalized.match(amountPattern);
  if (!match) {
    const bare = normalized.match(/(?:(?:又|再|另外|还)?花(?:了)?|花费|支出|消费|付款|支付|收到|收款|到账|货款|回款|进账|收入|吃饭|午饭|晚饭|早饭|早餐|午餐|晚餐|饭钱|餐饮|外卖|打车|车费)\D{0,8}(\d+(?:\.\d+)?)(?!\s*(?:点|时|:))/);
    if (!bare) return null;
    if ((bare[1].split('.')[1] || '').length > 2) return null;
    const amount = Number(bare[1]);
    if (!Number.isFinite(amount)) return null;
    return {
      amount,
      amountMinor: Math.round(amount * 100),
      currency: 'CNY',
      raw: bare[1]
    };
  }
  const rawNumber = match[1];
  const unit = match[2];
  if (/\d/.test(rawNumber) && (rawNumber.split('.')[1] || '').length > 2) return null;
  const parsed = parseChineseNumber(rawNumber);
  if (!Number.isFinite(parsed)) return null;
  const amount = unit.includes('万') ? parsed * 10000 : parsed;
  return {
    amount,
    amountMinor: Math.round(amount * 100),
    currency: 'CNY',
    raw: match[0]
  };
}

function financeCategory(text = '') {
  if (/吃饭|午饭|晚饭|早饭|早餐|午餐|晚餐|饭钱|餐饮|外卖/.test(text)) return '餐饮';
  if (/打车|车费|停车费|地铁|公交/.test(text)) return '交通';
  if (/买菜|超市|购物|买/.test(text)) return '购物';
  return '未分类';
}

function weekdayDate(base, weekday = '') {
  const target = weekdayMap[weekday];
  if (!Number.isInteger(target)) return base;
  const current = base.getDay();
  let delta = (target - current + 7) % 7;
  if (delta === 0) delta = 7;
  return addDays(base, delta);
}

function normalizeHour(hour, period = '') {
  if (['下午', '晚上'].includes(period) && hour < 12) return hour + 12;
  if (period === '中午' && hour < 11) return hour + 12;
  if (period === '凌晨' && hour === 12) return 0;
  return hour;
}

export function extractTime(text = '', context = {}) {
  const source = normalizeMemoryInput(text);
  const base = baseDateFromContext(context);
  const match = source.match(/(?:(今天|明天|后天)|(?:周|星期)([一二三四五六日天]))?\s*(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2}|[一二两三四五六七八九十]+)(?::([0-5]\d)|\s*(?:点钟|点|时)(?:\s*(半|\d{1,2}|[一二两三四五六七八九十]+)\s*分?)?)/);
  if (!match) return null;

  const relative = match[1] || '';
  const weekday = match[2] || '';
  const period = match[3] || '';
  const hour = parseChineseNumber(match[4]);
  const minute = match[5] ? Number(match[5]) : (match[6] === '半' ? 30 : (match[6] ? parseChineseNumber(match[6]) : 0));
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let date = new Date(base);
  date.setHours(0, 0, 0, 0);
  if (relative === '明天') date = addDays(date, 1);
  if (relative === '后天') date = addDays(date, 2);
  if (weekday) date = weekdayDate(date, weekday);
  const normalizedHour = normalizeHour(hour, period);
  const resolvedRange = resolveDateRange(source, context);
  const eventDate = resolvedRange.requiresConfirmation ? formatDate(date) : resolvedRange.startDate;
  const eventTime = formatTime(normalizedHour, minute);
  const timezone = context.timezone || context.timeZone || '';
  const start = timezone
    ? localDateTimeToUtc(eventDate, timezone, `${eventTime}:00`)
    : new Date(date);
  if (!timezone) start.setHours(normalizedHour, minute, 0, 0);

  return {
    eventDate,
    eventTime,
    startAt: start.toISOString(),
    raw: match[0]
  };
}

export function extractPeople(text = '') {
  return unique([...normalizeMemoryInput(text).matchAll(/[\u4e00-\u9fa5]{1,4}(?:总|经理|老师|同事|客户|主任)/g)]
    .map((match) => normalizePersonName(match[0]))
    .filter((name) => !['客户'].includes(name)));
}

function normalizePersonName(value = '') {
  const name = String(value || '');
  if (name.endsWith('总') && name.length > 2) return name.slice(-2);
  if (name.endsWith('经理') && name.length > 3) return name.slice(-3);
  if (name.endsWith('老师') && name.length > 3) return name.slice(-3);
  if (name.endsWith('主任') && name.length > 3) return name.slice(-3);
  return name;
}

export function extractOrganizations(text = '') {
  return unique([...normalizeMemoryInput(text).matchAll(/[\u4e00-\u9fa5A-Za-z0-9]{2,16}(?:客户|公司|集团|团队|部门)/g)]
    .map((match) => match[0]));
}

export function extractProjects(text = '') {
  return unique([...normalizeMemoryInput(text).matchAll(/[\u4e00-\u9fa5A-Za-z0-9]{2,20}(?:项目|方案|版本|系统)/g)]
    .map((match) => match[0]));
}

function cleanSummary(text = '', extracted = {}) {
  let summary = normalizeMemoryInput(text)
    .replace(/^(请|帮我)?(记住|记一下|记录一下|保存一下|帮我保存)\s*/u, '')
    .replace(/[，,。；;]+$/g, '');
  if (extracted.time?.raw) summary = summary.replace(extracted.time.raw, '');
  summary = summary.replace(/^(提醒我|提醒|记得|别忘|要)\s*/g, '');
  return removeTrailingPunctuation(summary);
}

export function extractMemoryFields(input = '', context = {}) {
  const normalizedText = normalizeMemoryInput(input);
  const amount = extractAmount(normalizedText);
  const time = extractTime(normalizedText, context);
  const people = extractPeople(normalizedText);
  const organizations = extractOrganizations(normalizedText);
  const projects = extractProjects(normalizedText);
  const category = classifyCategory(normalizedText);
  const direction = category === 'income' ? 'income' : (category === 'expense' ? 'expense' : 'neutral');
  const transactionDate = ['expense', 'income'].includes(category)
    ? resolveDateRangeOrToday(normalizedText, context).startDate
    : '';
  const timezone = context.timezone || context.timeZone || '';
  const transactionStartAt = transactionDate && timezone
    ? localDateTimeToUtc(transactionDate, timezone).toISOString()
    : '';
  const summary = cleanSummary(normalizedText, { time });
  const title = summary.slice(0, 32) || normalizedText.slice(0, 32);

  return {
    normalizedText,
    memoryType: category,
    category,
    title,
    summary,
    people,
    organizations,
    projects,
    amount: amount?.amount ?? null,
    currency: amount ? amount.currency : '',
    direction,
    eventDate: time?.eventDate || transactionDate,
    eventTime: time?.eventTime || '',
    startAt: time?.startAt || transactionStartAt,
    tags: unique([category, amount ? 'amount' : '', time ? 'time' : '']),
    confidence: [amount, time, people.length, organizations.length, projects.length].filter(Boolean).length ? 0.82 : 0.58,
    importance: ['income', 'expense', 'schedule', 'quote', 'customer_fact', 'project_fact', 'preference'].includes(category) ? 0.8 : 0.5,
    retentionPolicy: category === 'preference' ? 'long_term' : 'short_term',
    metadata: {
      extractedAmountText: amount?.raw || '',
      extractedTimeText: time?.raw || '',
      amountMinor: Number.isSafeInteger(amount?.amountMinor) ? amount.amountMinor : null,
      financeCategory: ['expense', 'income'].includes(category) ? financeCategory(normalizedText) : '',
      occurredAtPrecision: ['expense', 'income'].includes(category) ? (time ? 'minute' : 'day') : ''
    }
  };
}
