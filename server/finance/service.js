import { categoriesForType, isAllowedCategory } from './constants.js';
import { normalizeChineseMoney } from './chineseMoneyNormalizer.js';
import { dateForMonthDay, localDateKey, shiftLocalDays } from './time.js';
import { planFinanceMessage } from './queryPlan.js';
import { coverFinanceResult } from './financeResultCoverage.js';

const EXPENSE_SIGNALS = /(?:花了?|支出|买了?|付款|支付|早餐|午餐|晚餐|打车|公交|地铁|停车|加油|油费|过路费|高速费|路桥费|通行费|服务费|手续费|门票|修理|餐|饭|购物|看病|学费|红包|宠物|旅行|房租|水电)/;
const INCOME_SIGNALS = /(?:收到|收入|工资|奖金|入账|进账|还我|转给我|客户(?:款|回款|转给我)|回款|退款|转入|到账|经营)/;
const FINANCE_SIGNAL = /(?:元|块|收入|支出|花钱|花了|账|工资|客户款|回款|退款|转入|撤销上一笔|删除刚才|改成|收支)/;
const MODEL_ONLY_FINANCE_SIGNALS = /(?:分析|总结|预测|趋势|对比|分类|统计|查询|明细|合计|建议|解释|多少|多少钱|几笔|哪些|结余|情况|怎么样|知道)/;
const MONEY_CHARACTERS = '零〇一二两三四五六七八九十百千万亿';
const CHINESE_DECIMAL_TOKEN = `[${MONEY_CHARACTERS}]+点[零〇一二两三四五六七八九]+`;
const MONEY_TOKEN_WITH_CURRENCY = new RegExp(`(?:${CHINESE_DECIMAL_TOKEN}|\\d+(?:\\.\\d+)?(?:\\s*[十百千万亿])?|[${MONEY_CHARACTERS}]+)\\s*(?:元|块钱?|人民币)`, 'gu');
// A bare single Chinese numeral is only accepted as the distinctive “十”.
// Accepting every single numeral inside arbitrary text would turn names such
// as “张三” into a false amount. Exact one-character replies are handled
// separately below, so slot replies like “一” remain deterministic too.
const MONEY_TOKEN_AT_END = new RegExp(`(?:${CHINESE_DECIMAL_TOKEN}|\\d+(?:\\.\\d+)?(?:\\s*[十百千万亿])?|[${MONEY_CHARACTERS}]{2,}|十)(?=\\s*[。！？!?，,；;]?\\s*$)`, 'u');
const MONEY_TOKEN_ANYWHERE = new RegExp(`(?:${CHINESE_DECIMAL_TOKEN}|\\d+(?:\\.\\d+)?(?:\\s*[十百千万亿])?|[${MONEY_CHARACTERS}]{2,})`, 'gu');
const AMBIGUOUS_RELATION = /[\u4e00-\u9fff]{2,6}借我/u;

const CATEGORY_RULES = [
  ['餐饮', /早餐|午餐|晚餐|餐|饭|咖啡|奶茶|外卖/],
  ['交通', /打车|出租|出租车|网约车|公交|地铁|车票|车费|高铁|火车|机票|停车|停车费|加油|油费|过路费|高速费|路桥费|通行费/],
  ['购物', /购物|买衣|买鞋|网购|淘宝|京东/],
  ['居家', /房租|水电|物业|家居|日用品/],
  ['娱乐', /电影|游戏|唱歌|娱乐/],
  ['医疗', /看病|医院|药|医疗/],
  ['教育', /学费|课程|书籍|教育/],
  ['人情', /红包|礼金|人情|礼物/],
  ['宠物', /宠物|猫|狗/],
  ['旅行', /旅行|旅游|酒店/],
  ['工资', /工资|薪资|薪水|奖金/],
  ['经营', /经营|营业|销售收入/],
  ['客户回款', /客户(?:款|回款|转给我)/],
  ['退款', /退款/],
  ['转入', /转入/]
];

function emptyAmountEvidence(status = 'absent', amountText = null) {
  return { status, amountMinor: null, amountText };
}

function normalizeMoneyToken(token) {
  const result = normalizeChineseMoney(token);
  if (result.status === 'resolved' && result.amountMinor > 0) {
    return { status: 'resolved', amountMinor: result.amountMinor, amountText: String(token).trim() };
  }
  if (result.status === 'ambiguous') return emptyAmountEvidence('ambiguous', String(token).trim());
  if (result.status === 'invalid') return emptyAmountEvidence('invalid', String(token).trim());
  return emptyAmountEvidence('absent');
}

export function extractAmountMinorEvidence(text, {
  allowUnitless = false,
  preferredAmountText = null
} = {}) {
  const source = String(text || '');
  if (preferredAmountText) {
    const preferred = String(preferredAmountText).trim();
    const preferredIndex = preferred ? source.indexOf(preferred) : -1;
    const preferredPrefix = preferredIndex >= 0 ? source.slice(Math.max(0, preferredIndex - 2), preferredIndex) : '';
    if (preferred && preferredIndex >= 0 && !/[负+\-]\s*$/u.test(preferredPrefix)) {
      const resolved = normalizeMoneyToken(preferred);
      if (resolved.status !== 'absent') return resolved;
    }
  }
  const explicit = [...source.matchAll(MONEY_TOKEN_WITH_CURRENCY)]
    .map((match) => {
      const prefix = source.slice(Math.max(0, match.index - 2), match.index);
      if (/[负+\-]\s*$/u.test(prefix)) return emptyAmountEvidence('invalid', match[0].trim());
      return normalizeMoneyToken(match[0]);
    })
    .filter((result) => result.status !== 'absent');
  if (explicit.length > 1) return emptyAmountEvidence('ambiguous');
  if (explicit.length === 1) return explicit[0];
  if (!allowUnitless) return emptyAmountEvidence();

  // Calendar numbers are date evidence, never a unitless money amount.
  const unitlessSource = source.replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}日/gu, '');
  const shortReply = unitlessSource.trim();
  if (/^[零〇一二两三四五六七八九十]$/u.test(shortReply)) {
    return normalizeMoneyToken(shortReply);
  }

  const suffix = unitlessSource.match(MONEY_TOKEN_AT_END);
  if (suffix) {
    const suffixIndex = unitlessSource.lastIndexOf(suffix[0]);
    const prefix = unitlessSource.slice(Math.max(0, suffixIndex - 2), suffixIndex);
    if (/[负+\-]\s*$/u.test(prefix)) return emptyAmountEvidence('invalid', suffix[0].trim());
    return normalizeMoneyToken(suffix[0]);
  }
  const anywhere = [...unitlessSource.matchAll(MONEY_TOKEN_ANYWHERE)]
    .map((match) => {
      const prefix = source.slice(Math.max(0, match.index - 2), match.index);
      if (/[负+\-]\s*$/u.test(prefix)) return emptyAmountEvidence('invalid', match[0].trim());
      return normalizeMoneyToken(match[0]);
    })
    .filter((result) => result.status !== 'absent');
  if (anywhere.length > 1) return emptyAmountEvidence('ambiguous');
  return anywhere[0] || emptyAmountEvidence();
}

export function parseAmountMinor(text, { allowUnitless = false } = {}) {
  const evidence = extractAmountMinorEvidence(text, { allowUnitless });
  return evidence.status === 'resolved' ? evidence.amountMinor : null;
}

function allAmounts(text) {
  return [...String(text || '').matchAll(MONEY_TOKEN_WITH_CURRENCY)]
    .map((match) => parseAmountMinor(match[0]))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
}

function formatMinor(value) {
  const minor = Number(value) || 0;
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2).replace(/0$/, '');
}

function cleanCounterparty(value) {
  const candidate = String(value || '').trim().replace(/[的那位]+$/u, '');
  if (!candidate || /^(?:我|我的|自己|本人)$/u.test(candidate)) return null;
  return candidate;
}

function captureCounterparty(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    const candidate = cleanCounterparty(match?.groups?.counterparty || match?.[1]);
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Parse only high-confidence owner/counterparty loan and repayment wording.
 * Ambiguous “李伟借我一千” is intentionally returned as ambiguous rather than
 * guessing whether Li Wei lent to the owner or borrowed from the owner.
 */
export function parseFinanceRelation(message) {
  const text = String(message || '').replace(/[\s，,。！？!?]/gu, '');
  if (!text || !/[借还]/u.test(text)) return null;
  if (AMBIGUOUS_RELATION.test(text) && !/(?:向我借|从我这里借|借给我|还我|还给我)/u.test(text)) {
    const counterparty = captureCounterparty(text, [/^(?<counterparty>[\u4e00-\u9fff]{2,6}?)借我/u]);
    return { status: 'ambiguous', subtype: null, direction: null, counterparty };
  }

  const loanOutCounterparty = captureCounterparty(text, [
    /借给(?!我)(?<counterparty>[\u4e00-\u9fff]{2,6}?)(?=(?:\d|[零〇一二两三四五六七八九十百千万亿]|$))/u,
    /(?:^|我)借(?!出去|给)(?<counterparty>[\u4e00-\u9fff]{2,6}?)(?=(?:\d|[零〇一二两三四五六七八九十百千万亿]|$))/u,
    /^(?<counterparty>[\u4e00-\u9fff]{2,6}?)向我借/u,
    /^(?<counterparty>[\u4e00-\u9fff]{2,6}?)从我这里借/u,
    /我借出去(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿]+)(?:元|块钱?|人民币)?给(?<counterparty>[\u4e00-\u9fff]{2,6}?)(?=$)/u
  ]);
  if (loanOutCounterparty) {
    return { status: 'clear', subtype: 'loan_out', direction: 'expense', counterparty: loanOutCounterparty };
  }

  const loanInCounterparty = captureCounterparty(text, [
    /向(?<counterparty>[\u4e00-\u9fff]{2,6}?)(?=借)/u,
    /从(?<counterparty>[\u4e00-\u9fff]{2,6}?)那里借/u,
    /我从(?<counterparty>[\u4e00-\u9fff]{2,6}?)那里借/u,
    /^(?<counterparty>[\u4e00-\u9fff]{2,6}?)借给我/u
  ]);
  if (loanInCounterparty) {
    return { status: 'clear', subtype: 'loan_in', direction: 'income', counterparty: loanInCounterparty };
  }

  const repaymentInCounterparty = captureCounterparty(text, [
    /^(?<counterparty>[\u4e00-\u9fff]{2,6}?)(?:还我|还给我)/u
  ]);
  if (repaymentInCounterparty) {
    return { status: 'clear', subtype: 'repayment_in', direction: 'income', counterparty: repaymentInCounterparty };
  }

  const repaymentOutCounterparty = captureCounterparty(text, [
    /^我还(?:给)?(?<counterparty>[\u4e00-\u9fff]{2,6}?)(?=(?:\d|[零〇一二两三四五六七八九十百千万亿]|$))/u
  ]);
  if (repaymentOutCounterparty) {
    return { status: 'clear', subtype: 'repayment_out', direction: 'expense', counterparty: repaymentOutCounterparty };
  }
  return null;
}

export function classifyFinanceType(message) {
  const relation = parseFinanceRelation(String(message || ''));
  if (relation?.status === 'clear') return relation.direction;
  if (relation?.status === 'ambiguous') return null;
  const income = INCOME_SIGNALS.test(message);
  const expense = EXPENSE_SIGNALS.test(message);
  if (income === expense) return null;
  return income ? 'income' : 'expense';
}

function occurredExpressionFor(text) {
  return String(text || '').match(/前天|昨天|今天|本月\s*\d{1,2}日|(?:\d{4}年)?\d{1,2}月\d{1,2}日/u)?.[0] || null;
}

function deterministicPlan({ text, direction, subtype = null, counterparty = null, amount = null,
  occurredExpression = null, requiresConfirmation = false, ambiguityReason = null, sourceText = null,
  timezone = 'Asia/Shanghai', now = new Date() } = {}) {
  const planFinance = planFinanceMessage(text, { timezone, now });
  const changes = {};
  if (subtype) {
    changes.subtype = subtype;
    changes.cash_direction = direction === 'income' ? 'inflow' : 'outflow';
  }
  if (ambiguityReason) changes.ambiguity_reason = ambiguityReason;
  if (sourceText && sourceText !== text) changes.source_text = sourceText;
  return {
    domain: 'finance',
    action: 'create',
    metrics: direction ? [direction] : [],
    period_type: null,
    period_expression: null,
    category: planFinance?.category || classifyCategory(text, direction || 'expense'),
    counterparty: counterparty || null,
    keyword: null,
    transaction_candidate: {
      direction: direction || null,
      amount_text: amount?.status === 'resolved' ? amount.amountText : null,
      occurred_expression: occurredExpression || null
    },
    entry_reference: null,
    changes,
    inherited_context: {
      previous_action: null,
      previous_metrics: [],
      previous_period_type: null
    },
    confidence: requiresConfirmation ? 0.99 : 1,
    source_spans: [{ text, start: 0, end: text.length }],
    requires_confirmation: Boolean(requiresConfirmation)
  };
}

/**
 * Build a Finance create command from facts that are unambiguous in the user
 * message. This is deliberately independent of any Provider plan: simple
 * ledger writes must not make a model decide whether a known amount or
 * direction is safe to persist.
 */
export function planDeterministicFinanceCreate(message, {
  timezone = 'Asia/Shanghai',
  now = new Date(),
  previousSlots = null
} = {}) {
  const text = String(message || '').trim();
  if (!text) return null;
  if (MODEL_ONLY_FINANCE_SIGNALS.test(text)) return null;
  if (/(?:改成|改为|修改|不是|删除|撤销|刚才|上一笔|那笔)/u.test(text)) return null;
  const relation = parseFinanceRelation(text);
  const amountSource = relation?.counterparty ? text.replace(relation.counterparty, '') : text;
  const amount = extractAmountMinorEvidence(amountSource, { allowUnitless: true, preferredAmountText: previousSlots?.amountText });
  const direction = relation?.status === 'clear'
    ? relation.direction
    : relation?.status === 'ambiguous'
      ? null
      : previousSlots?.direction || classifyFinanceType(text);
  const hasRelationContext = relation?.status === 'clear' || relation?.status === 'ambiguous' || previousSlots?.subtype;
  if (!hasRelationContext && amount.status !== 'resolved') {
    // Keep the historical clarification/provider route for generic “记一笔收入”.
    // Ambiguous amounts that already have an explicit direction are handled here
    // so a model can never silently guess a high-risk amount.
    return amount.status === 'ambiguous' && direction
      ? deterministicPlan({ text, direction, amount, occurredExpression: occurredExpressionFor(text),
        requiresConfirmation: true, ambiguityReason: 'amount_ambiguous', timezone, now })
      : null;
  }
  if (!hasRelationContext && !direction) return null;
  if (relation?.status === 'ambiguous') {
    return deterministicPlan({
      text,
      amount,
      counterparty: relation.counterparty,
      occurredExpression: occurredExpressionFor(text),
      requiresConfirmation: true,
      ambiguityReason: 'loan_direction_ambiguous', timezone, now
    });
  }
  const subtype = relation?.status === 'clear' ? relation.subtype : previousSlots?.subtype || null;
  const counterparty = relation?.status === 'clear' ? relation.counterparty : previousSlots?.counterparty || null;
  const resolvedAmount = amount.status === 'resolved'
    ? amount
    : previousSlots?.amountMinor
      ? { status: 'resolved', amountMinor: previousSlots.amountMinor, amountText: previousSlots.amountText }
      : amount;
  return deterministicPlan({
    text,
    direction,
    subtype,
    counterparty,
    amount: resolvedAmount,
    occurredExpression: occurredExpressionFor(text) || previousSlots?.occurredExpression || null,
    requiresConfirmation: amount.status === 'ambiguous',
    ambiguityReason: amount.status === 'ambiguous' ? 'amount_ambiguous' : null,
    sourceText: previousSlots?.sourceText || null,
    timezone,
    now
  });
}

function splitDeterministicFinanceClauses(message) {
  const source = String(message || '').trim();
  const normalized = source.replace(/[。！？!?]+$/u, '').trim();
  const clauses = normalized.split(/\s*[,，、；;。！？\n]+\s*/u).map((clause) => clause.trim()).filter(Boolean);
  return { source, clauses };
}

export function planDeterministicFinanceBatch(message, {
  timezone = 'Asia/Shanghai',
  now = new Date()
} = {}) {
  const { source, clauses } = splitDeterministicFinanceClauses(message);
  if (!source || clauses.length < 2) return null;
  if (/(?:其中|或者|还是|不是|改成|改为)/u.test(source)) return null;
  const commands = clauses.map((clause) => planDeterministicFinanceCreate(clause, { timezone, now }));
  if (commands.some((command) => !command)) return null;
  return {
    domain: 'finance',
    action: 'create_batch',
    commands,
    source_texts: clauses,
    source_spans: [{ text: source, start: 0, end: source.length }],
    confidence: 1,
    requires_confirmation: false
  };
}

export function classifyCategory(message, type) {
  const match = CATEGORY_RULES.find(([, pattern]) => pattern.test(message))?.[0];
  if (match && isAllowedCategory(type, match)) return match;
  return type === 'income' ? '其他收入' : '其他';
}

export function resolveOccurredAt(message, now, timezone) {
  if (/前天/.test(message)) return shiftLocalDays(now, timezone, -2).toISOString();
  if (/昨天/.test(message)) return shiftLocalDays(now, timezone, -1).toISOString();
  const currentMonth = message.match(/本月\s*(\d{1,2})日/);
  if (currentMonth) {
    const [, month] = localDateKey(now, timezone).split('-').map(Number);
    return dateForMonthDay(now, timezone, month, Number(currentMonth[1])).toISOString();
  }
  const explicit = message.match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/);
  if (explicit) return dateForMonthDay(now, timezone, Number(explicit[2]), Number(explicit[3])).toISOString();
  return now.toISOString();
}

function targetHints(message) {
  const ignored = new Set(['刚才', '那笔', '上一笔', '支出', '收入', '账目', '分类', '修改', '删除', '撤销', '改成', '不是', '把', '的', '为', '是']);
  return [...message.matchAll(/[\u4e00-\u9fff]{2,6}/g)].map((match) => match[0]).filter((value) => !ignored.has(value));
}

function candidatesFor(repository, ownerId, message, { type = null } = {}) {
  let entries = repository.list({ ownerId, limit: 20 });
  if (type) entries = entries.filter((entry) => entry.type === type);
  const hints = targetHints(message).filter((hint) => !/(?:改成|删除|修改|撤销|刚才|上一笔)/.test(hint));
  const knownCategory = [...categoriesForType('expense'), ...categoriesForType('income')].find((category) => message.includes(category));
  const semanticTokens = ['早餐', '午餐', '晚餐', '打车', '公交', '地铁', '工资', '客户款', '回款', '退款', '房租']
    .filter((token) => message.includes(token));
  const oldAmount = allAmounts(message)[0];
  const matched = entries.filter((entry) => {
    if (knownCategory && entry.category !== knownCategory) return false;
    if (allAmounts(message).length > 1 && oldAmount && entry.amountMinor !== oldAmount) return false;
    if (semanticTokens.length) {
      const searchable = `${entry.note || ''} ${entry.category} ${entry.merchant || ''} ${entry.counterparty || ''}`;
      return semanticTokens.some((token) => searchable.includes(token));
    }
    if (!hints.length) return true;
    const searchable = `${entry.note || ''} ${entry.category} ${entry.merchant || ''} ${entry.counterparty || ''}`;
    return hints.some((hint) => searchable.includes(hint) || hint.includes(entry.category));
  });
  return matched.length ? matched : entries.length === 1 ? entries : [];
}

function clarification(entries) {
  const choices = entries.slice(0, 3).map((entry) => `${localDateKey(new Date(entry.occurredAt), entry.timezone)} ${entry.category}${formatMinor(entry.amountMinor)}元`);
  return `找到多笔可能的账目，请确认：${choices.join('；')}。`;
}

function contextKey(ownerId, conversationId) {
  return `${String(ownerId || '')}\u0000${String(conversationId || '')}`;
}

function slotSnapshotFromPlan(plan) {
  const candidate = plan?.transaction_candidate || {};
  const amount = candidate.amount_text
    ? extractAmountMinorEvidence(candidate.amount_text, { allowUnitless: true })
    : emptyAmountEvidence();
  return {
    direction: candidate.direction || plan?.type || null,
    subtype: plan?.changes?.subtype || null,
    counterparty: plan?.counterparty || null,
    amountMinor: amount.status === 'resolved' ? amount.amountMinor : Number.isSafeInteger(plan?.amount_minor) ? plan.amount_minor : null,
    amountText: amount.status === 'resolved' ? amount.amountText : candidate.amount_text || null,
    occurredExpression: candidate.occurred_expression || null,
    sourceText: plan?.changes?.source_text || plan?.source_spans?.[0]?.text || null
  };
}

function dateOnlyMessage(text) {
  return Boolean(occurredExpressionFor(text)) &&
    !extractAmountMinorEvidence(text, { allowUnitless: true }).amountMinor &&
    !/[借还花买收支工资奖金早餐午餐晚餐打车房租]/u.test(String(text || ''));
}

function dateRefinementPlan(text, operation) {
  const expression = occurredExpressionFor(text);
  const slots = operation?.slots || {};
  return {
    domain: 'finance',
    action: 'update',
    metrics: slots.direction ? [slots.direction] : [],
    period_type: null,
    period_expression: null,
    category: null,
    counterparty: slots.counterparty || null,
    keyword: null,
    transaction_candidate: {
      direction: slots.direction || null,
      amount_text: slots.amountText || null,
      occurred_expression: expression
    },
    entry_reference: operation.entryId,
    changes: { occurred_expression: expression },
    inherited_context: {
      previous_action: 'create',
      previous_metrics: slots.direction ? [slots.direction] : [],
      previous_period_type: null
    },
    confidence: 1,
    source_spans: [{ text, start: 0, end: text.length }],
    requires_confirmation: false
  };
}

function rememberBounded(map, key, value) {
  if (!map.has(key) && map.size >= 1_000) map.delete(map.keys().next().value);
  map.set(key, value);
}

function lifecycleRequest(repository, entry, clientRequestId) {
  return repository.f201Enabled
    ? { expectedVersion: entry.version, mutationRequestId: clientRequestId }
    : {};
}

export class FinanceService {
  constructor({ repository, clock = () => new Date(), timezone = 'Asia/Shanghai' } = {}) {
    this.repository = repository;
    this.clock = clock;
    this.timezone = timezone;
    this.queryContexts = new Map();
    this.lastCreatedEntries = new Map();
    this.pendingOperations = new Map();
    this.lastOperations = new Map();
  }

  rememberPendingPlan({ ownerId, conversationId, plan } = {}) {
    if (!ownerId || !conversationId || !plan || plan.requires_confirmation) return false;
    const slots = slotSnapshotFromPlan(plan);
    if (!slots.subtype || !slots.direction) return false;
    rememberBounded(this.pendingOperations, contextKey(ownerId, conversationId), Object.freeze({
      slots: Object.freeze(slots), plan: structuredClone(plan)
    }));
    return true;
  }

  recoverPendingSlots({ conversationMessages = [] } = {}) {
    let slots = null;
    for (const message of Array.isArray(conversationMessages) ? conversationMessages : []) {
      if (message?.role !== 'user') continue;
      const content = String(message.content || '').trim();
      const relation = parseFinanceRelation(content);
      if (relation?.status === 'clear') {
        const amount = extractAmountMinorEvidence(content.replace(relation.counterparty || '', ''), { allowUnitless: true });
        slots = {
          direction: relation.direction,
          subtype: relation.subtype,
          counterparty: relation.counterparty,
          amountMinor: amount.status === 'resolved' ? amount.amountMinor : null,
          amountText: amount.status === 'resolved' ? amount.amountText : null,
          occurredExpression: occurredExpressionFor(content),
          sourceText: content
        };
        continue;
      }
      if (!slots) continue;
      const amount = extractAmountMinorEvidence(content, { allowUnitless: true });
      if (amount.status === 'resolved' && !Number.isSafeInteger(slots.amountMinor)) {
        slots.amountMinor = amount.amountMinor;
        slots.amountText = amount.amountText;
      }
      const occurredExpression = occurredExpressionFor(content);
      if (occurredExpression) slots.occurredExpression = occurredExpression;
    }
    return slots;
  }

  clearPendingOperation(ownerId, conversationId) {
    return this.pendingOperations.delete(contextKey(ownerId, conversationId));
  }

  trustedContext(ownerId, conversationId) {
    const plan = this.queryContexts.get(contextKey(ownerId, conversationId));
    return plan ? {
      previous_action: plan.action,
      previous_metrics: [...plan.metrics],
      previous_period_type: plan.period_type
    } : null;
  }

  isFinanceCandidate(message) {
    const text = String(message || '');
    return Boolean(parseFinanceRelation(text)) || FINANCE_SIGNAL.test(text) || EXPENSE_SIGNALS.test(text) || INCOME_SIGNALS.test(text);
  }

  deterministicCreatePlan(message, { now = this.clock(), ownerId = null, conversationId = null, conversationMessages = [] } = {}) {
    const key = contextKey(ownerId, conversationId);
    const currentText = String(message || '').trim();
    const recovered = this.pendingOperations.get(key)?.slots || this.recoverPendingSlots({ conversationMessages });
    const currentRelation = parseFinanceRelation(currentText);
    const currentAmount = extractAmountMinorEvidence(currentText, { allowUnitless: true });
    const currentIsDate = Boolean(occurredExpressionFor(currentText));
    const pending = recovered && (currentRelation || currentAmount.status !== 'absent' || currentIsDate)
      ? recovered
      : null;
    const lastOperation = this.lastOperations.get(key) ||
      (pending && currentIsDate ? this.findLastRelationOperation(ownerId, pending) : null);
    if (lastOperation && dateOnlyMessage(currentText)) return dateRefinementPlan(currentText, lastOperation);
    return planDeterministicFinanceCreate(message, {
      timezone: this.timezone,
      now,
      previousSlots: pending
    });
  }

  findLastRelationOperation(ownerId, slots) {
    if (!ownerId || !slots?.subtype) return null;
    const entry = this.repository.list({ ownerId, limit: 100 })
      .find((candidate) => candidate.subtype === slots.subtype &&
        candidate.counterparty === slots.counterparty &&
        (!Number.isSafeInteger(slots.amountMinor) || candidate.amountMinor === slots.amountMinor));
    return entry ? { entryId: entry.id, slots } : null;
  }

  deterministicCreateBatchPlan(message, { now = this.clock() } = {}) {
    return planDeterministicFinanceBatch(message, {
      timezone: this.timezone,
      now
    });
  }

  processBatchCreate({ ownerId, conversationId, message, clientRequestId, sourceMessageId, plan }) {
    const commands = Array.isArray(plan?.commands) ? plan.commands : [];
    const sourceTexts = Array.isArray(plan?.source_texts) ? plan.source_texts : [];
    const baseRequestId = String(clientRequestId || '').trim();
    if (!baseRequestId) {
      const error = new Error('CLIENT_REQUEST_ID_REQUIRED');
      error.code = 'CLIENT_REQUEST_ID_REQUIRED';
      throw error;
    }
    if (!commands.length || commands.length !== sourceTexts.length) {
      const error = new Error('FINANCE_BATCH_PLAN_INVALID');
      error.code = 'FINANCE_BATCH_PLAN_INVALID';
      throw error;
    }
    const entries = this.repository.createMany(commands.map((command, index) => {
      const text = String(sourceTexts[index] || '').trim();
      const candidate = command.transaction_candidate || {};
      const type = command.type || candidate.direction;
      return {
        ownerId,
        type,
        amountMinor: command.amount_minor,
        currency: command.currency || 'CNY',
        occurredAt: command.occurred_at || resolveOccurredAt(candidate.occurred_expression || text, this.clock(), this.timezone),
        timezone: command.timezone || this.timezone,
        category: command.category || classifyCategory(text, type),
        counterparty: command.counterparty || (type === 'income' && /客户/.test(text) ? '客户' : null),
        subtype: command.changes?.subtype || null,
        note: text,
        sourceMessageId,
        clientRequestId: `${baseRequestId}:${index + 1}`
      };
    }), {
      ownerId,
      mutationRequestId: baseRequestId
    });
    if (!Array.isArray(entries) || entries.length !== commands.length || entries.some((entry) => !entry?.id)) {
      const error = new Error('FINANCE_PERSISTENCE_UNCONFIRMED');
      error.code = 'FINANCE_PERSISTENCE_UNCONFIRMED';
      throw error;
    }
    rememberBounded(this.lastCreatedEntries, contextKey(ownerId, conversationId), entries.at(-1).id);
    return {
      handled: true,
      action: 'create_batch',
      plan,
      content: `已记录${entries.length}笔`,
      data: { entries }
    };
  }

  async processUserMessage({ ownerId, conversationId, message, clientRequestId, sourceMessageId, plan: suppliedPlan = null }) {
    const text = String(message || '').trim();
    if (!text) return { handled: false };
    const key = contextKey(ownerId, conversationId);
    const previousPlan = this.queryContexts.get(key) || null;
    const plan = suppliedPlan || planFinanceMessage(text, { timezone: this.timezone, now: this.clock(), previousPlan });
    if (plan?.action === 'create_batch') {
      try {
        return this.processBatchCreate({ ownerId, conversationId, message: text, clientRequestId, sourceMessageId, plan });
      } catch (error) {
        return {
          handled: true,
          action: 'error',
          code: error?.code || 'FINANCE_WRITE_FAILED',
          content: '这些账目暂时没有记录成功，请重试。'
        };
      }
    }
    if (plan?.action === 'query') {
      try {
        const result = this.repository.query(plan, { ownerId });
        const covered = coverFinanceResult({ plan, repositoryResult: result });
        rememberBounded(this.queryContexts, key, plan);
        return { handled: true, action: 'query', plan, data: covered.data, content: covered.content };
      } catch {
        return { handled: true, action: 'error', plan, content: '暂时无法读取账本，请稍后再试。' };
      }
    }
    if (plan?.action === 'ambiguous') {
      return { handled: true, action: 'ambiguous', plan, content: '想查询哪个时间范围？' };
    }
    if (plan?.action === 'update' && plan.entry_reference && plan.changes?.occurred_expression) {
      const entry = this.repository.get({ ownerId, id: plan.entry_reference });
      if (!entry) return { handled: true, action: 'update', plan, content: '没有找到这笔账。' };
      try {
        const updated = this.repository.update({
          ownerId,
          id: entry.id,
          patch: { occurredAt: resolveOccurredAt(plan.changes.occurred_expression, this.clock(), this.timezone) },
          ...lifecycleRequest(this.repository, entry, clientRequestId)
        });
        if (updated) this.lastOperations.delete(key);
        return { handled: true, action: 'update', plan, content: updated ? '已修改' : '没有找到这笔账。', data: { entry: updated } };
      } catch (error) {
        return { handled: true, action: 'error', code: error?.code || 'FINANCE_WRITE_FAILED', content: '这笔账暂时没有修改成功，请重试。' };
      }
    }
    if (plan?.action === 'classify') {
      const amount = allAmounts(text)[0] || parseAmountMinor(text, { allowUnitless: true });
      const category = CATEGORY_RULES.find(([candidate, pattern]) => pattern.test(text) && isAllowedCategory('income', candidate))?.[0];
      const rememberedId = this.lastCreatedEntries.get(key);
      let entries = rememberedId ? [this.repository.get({ ownerId, id: rememberedId })].filter(Boolean) : [];
      if (!entries.length) entries = this.repository.list({ ownerId, limit: 20 }).filter((entry) => entry.type === 'income' && (!amount || entry.amountMinor === amount));
      if (entries.length > 1) return { handled: true, action: 'clarify', plan, content: clarification(entries), data: { entries } };
      if (!entries.length || !category) return { handled: true, action: 'classify', plan, content: '没有找到这笔账。' };
      const entry = this.repository.update({
        ownerId,
        id: entries[0].id,
        patch: { category },
        ...lifecycleRequest(this.repository, entries[0], clientRequestId)
      });
      return { handled: true, action: 'classify', plan, content: entry ? '已修改' : '没有找到这笔账。', data: { entry } };
    }
    if (plan?.action === 'delete' && /撤销上一笔支出/.test(text)) {
      const [entry] = this.repository.list({ ownerId, limit: 100 }).filter((item) => item.type === 'expense');
      return {
        handled: true,
        action: 'delete',
        content: entry && this.repository.softDelete({
          ownerId,
          id: entry.id,
          ...lifecycleRequest(this.repository, entry, clientRequestId)
        }) ? '已删除' : '没有找到这笔账。'
      };
    }

    if (plan?.action === 'delete' && /(?:删除|撤销).*(?:刚才|那笔|早餐|午餐|晚餐|打车|账)/.test(text)) {
      const entries = candidatesFor(this.repository, ownerId, text);
      if (entries.length > 1) return { handled: true, action: 'clarify', content: clarification(entries), data: { entries } };
      if (!entries.length) return { handled: true, action: 'delete', content: '没有找到这笔账。' };
      return {
        handled: true,
        action: 'delete',
        content: this.repository.softDelete({
          ownerId,
          id: entries[0].id,
          ...lifecycleRequest(this.repository, entries[0], clientRequestId)
        }) ? '已删除' : '没有找到这笔账。'
      };
    }

    if (plan?.action === 'update' && /(?:改成|修改|不是).*(?:元|分类)|分类改成/.test(text)) {
      const entries = candidatesFor(this.repository, ownerId, text);
      if (entries.length > 1) return { handled: true, action: 'clarify', content: clarification(entries), data: { entries } };
      if (!entries.length) return { handled: true, action: 'update', content: '没有找到这笔账。' };
      const amounts = allAmounts(text);
      const category = [...categoriesForType(entries[0].type)].find((value) => text.includes(`改成${value}`) || text.includes(`改为${value}`));
      const patch = {};
      if (amounts.length) patch.amountMinor = amounts.at(-1);
      if (category) patch.category = category;
      if (!Object.keys(patch).length) return { handled: true, action: 'clarify', content: '需要修改金额还是分类？' };
      return {
        handled: true,
        action: 'update',
        content: this.repository.update({
          ownerId,
          id: entries[0].id,
          patch,
          ...lifecycleRequest(this.repository, entries[0], clientRequestId)
        }) ? '已修改' : '没有找到这笔账。'
      };
    }

    const type = plan?.type || plan?.transaction_candidate?.direction || classifyFinanceType(text);
    const amountSource = plan?.transaction_candidate?.amount_text || text;
    const value = Number.isSafeInteger(plan?.amount_minor)
      ? plan.amount_minor
      : parseAmountMinor(amountSource, { allowUnitless: Boolean(type) });
    if (!FINANCE_SIGNAL.test(text) && !(type && value)) return { handled: false };
    if (plan && plan.action !== 'create') return { handled: false };
    if (!value) return { handled: true, action: 'clarify', content: '金额是多少？' };
    if (!type) return { handled: true, action: 'clarify', content: '这是收入还是支出？' };
    try {
      const entry = this.repository.create({
        ownerId,
        type,
        amountMinor: value,
        currency: plan?.currency || 'CNY',
        occurredAt: plan?.occurred_at || resolveOccurredAt(plan?.transaction_candidate?.occurred_expression || text, this.clock(), this.timezone),
        timezone: plan?.timezone || this.timezone,
        category: plan?.category || classifyCategory(text, type),
        counterparty: plan?.counterparty || (type === 'income' && /客户/.test(text) ? '客户' : null),
        subtype: plan?.changes?.subtype || null,
        note: plan?.changes?.source_text || text,
        sourceMessageId,
        clientRequestId
      });
      if (!entry?.id ||
          entry.clientRequestId !== clientRequestId ||
          entry.sourceMessageId !== sourceMessageId) {
        const error = new Error('FINANCE_PERSISTENCE_UNCONFIRMED');
        error.code = 'FINANCE_PERSISTENCE_UNCONFIRMED';
        throw error;
      }
      rememberBounded(this.lastCreatedEntries, key, entry.id);
      const slots = slotSnapshotFromPlan({ ...plan, amount_minor: value });
      this.clearPendingOperation(ownerId, conversationId);
      if (slots.subtype) {
        rememberBounded(this.lastOperations, key, Object.freeze({ entryId: entry.id, slots }));
      } else {
        this.lastOperations.delete(key);
      }
      const needsIncomeSource = type === 'income' && entry.category === '其他收入' && !plan?.changes?.subtype &&
        !/(?:工资|客户|退款|转入|经营|奖金)/.test(text);
      return {
        handled: true,
        action: 'create',
        ...(plan?.changes?.subtype ? {
          intent: plan.changes.subtype,
          cashDirection: type === 'income' ? 'inflow' : 'outflow'
        } : {}),
        plan,
        content: needsIncomeSource ? '已记录。这笔是什么收入来源？' : '已记录',
        data: { entry }
      };
    } catch (error) {
      return {
        handled: true,
        action: 'error',
        code: error?.code || 'FINANCE_WRITE_FAILED',
        content: '这笔账暂时没有记录成功，请重试。'
      };
    }
  }
}
