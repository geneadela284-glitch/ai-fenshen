import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { resolveDateRange } from '../../core/trust/dateRangeResolver.js';
import { categoriesForType } from './constants.js';

const PERIOD_EXPRESSIONS = Object.freeze({
  today: '今天',
  yesterday: '昨天',
  this_week: '本周',
  this_month: '本月',
  last_year: '去年'
});
const TYPES = new Set(['income', 'expense']);
const STATUSES = new Set(['active', 'archived', 'deleted']);
const CATEGORIES = new Set([...categoriesForType('income'), ...categoriesForType('expense')]);
const ALL_TIME_START = '0001-01-01T00:00:00.000Z';
const ALL_TIME_END = '9999-12-31T23:59:59.999Z';

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function validTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeInstant(value, code) {
  const instant = new Date(value);
  if (!value || !Number.isFinite(instant.getTime())) throw failure(code);
  return instant.toISOString();
}

function normalizeList(value, allowed, defaults, code) {
  const source = value === undefined || value === null
    ? defaults
    : Array.isArray(value) ? value : [value];
  const normalized = [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))].sort();
  if (normalized.some((item) => !allowed.has(item))) throw failure(code);
  return normalized;
}

export function resolveFinanceHistoryRange({
  period = 'all_time',
  startAt = null,
  endAt = null,
  timezone = 'Asia/Shanghai',
  now = new Date()
} = {}) {
  const zone = String(timezone || '').trim();
  if (!validTimezone(zone)) throw failure('FINANCE_HISTORY_TIMEZONE_INVALID');
  const normalizedPeriod = String(period || 'all_time').trim();
  if (normalizedPeriod === 'all_time') {
    return { startAt: ALL_TIME_START, endAt: ALL_TIME_END, timezone: zone, interval: '[startAt,endAt)' };
  }
  if (normalizedPeriod === 'custom') {
    const start = normalizeInstant(startAt, 'FINANCE_HISTORY_RANGE_INVALID');
    const end = normalizeInstant(endAt, 'FINANCE_HISTORY_RANGE_INVALID');
    if (Date.parse(start) >= Date.parse(end)) throw failure('FINANCE_HISTORY_RANGE_INVALID');
    return { startAt: start, endAt: end, timezone: zone, interval: '[startAt,endAt)' };
  }
  const expression = PERIOD_EXPRESSIONS[normalizedPeriod];
  if (!expression) throw failure('FINANCE_HISTORY_PERIOD_INVALID');
  const range = resolveDateRange(expression, { timezone: zone, now });
  if (range.requiresConfirmation || !range.startAt || !range.endAt) {
    throw failure('FINANCE_HISTORY_RANGE_INVALID');
  }
  return { startAt: range.startAt, endAt: range.endAt, timezone: zone, interval: '[startAt,endAt)' };
}

export function normalizeFinanceHistoryQuery(input = {}, {
  ownerId,
  defaultTimezone = 'Asia/Shanghai',
  defaultNow = new Date()
} = {}) {
  const owner = String(ownerId || '').trim();
  if (!owner) throw failure('OWNER_REQUIRED');
  const range = resolveFinanceHistoryRange({
    period: input.period,
    startAt: input.startAt,
    endAt: input.endAt,
    timezone: input.timezone || defaultTimezone,
    now: input.now || defaultNow
  });
  const types = normalizeList(input.types, TYPES, [], 'FINANCE_HISTORY_TYPE_INVALID');
  const categories = normalizeList(input.categories, CATEGORIES, [], 'FINANCE_HISTORY_CATEGORY_INVALID');
  const statuses = normalizeList(input.statuses, STATUSES, ['active', 'archived'], 'FINANCE_HISTORY_STATUS_INVALID');
  if (!statuses.length) throw failure('FINANCE_HISTORY_STATUS_INVALID');
  const keyword = String(input.keyword || '').trim() || null;
  if (keyword && keyword.length > 200) throw failure('FINANCE_HISTORY_KEYWORD_INVALID');
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  return { ownerId: owner, range, types, categories, statuses, keyword, limit };
}

export function financeHistoryQueryFingerprint(query) {
  return createHash('sha256').update(JSON.stringify({
    ownerId: query.ownerId,
    startAt: query.range.startAt,
    endAt: query.range.endAt,
    timezone: query.range.timezone,
    types: query.types,
    categories: query.categories,
    statuses: query.statuses,
    keyword: query.keyword
  })).digest('hex');
}

function signature(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest();
}

export function encodeFinanceHistoryCursor({ ownerId, queryFingerprint, key }, secret) {
  const payload = Buffer.from(JSON.stringify({ version: 1, ownerId, queryFingerprint, key })).toString('base64url');
  return `${payload}.${signature(payload, secret).toString('base64url')}`;
}

export function decodeFinanceHistoryCursor(cursor, { ownerId, queryFingerprint, secret }) {
  try {
    const parts = String(cursor || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw failure('FINANCE_HISTORY_CURSOR_INVALID');
    const actual = Buffer.from(parts[1], 'base64url');
    const expected = signature(parts[0], secret);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw failure('FINANCE_HISTORY_CURSOR_INVALID');
    }
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (payload.version !== 1 || !Array.isArray(payload.key) || payload.key.length !== 3 ||
        payload.key.some((value) => typeof value !== 'string' || !value)) {
      throw failure('FINANCE_HISTORY_CURSOR_INVALID');
    }
    if (payload.ownerId !== ownerId) throw failure('FINANCE_HISTORY_CURSOR_SCOPE_MISMATCH');
    if (payload.queryFingerprint !== queryFingerprint) throw failure('FINANCE_HISTORY_CURSOR_QUERY_MISMATCH');
    return payload.key;
  } catch (error) {
    if (String(error?.code || '').startsWith('FINANCE_HISTORY_CURSOR_')) throw error;
    throw failure('FINANCE_HISTORY_CURSOR_INVALID');
  }
}

export function financeHistoryStatusClause(statuses) {
  const clauses = [];
  if (statuses.includes('active')) clauses.push("(status = 'active' AND deleted_at IS NULL AND archived_at IS NULL)");
  if (statuses.includes('archived')) clauses.push("(status = 'active' AND deleted_at IS NULL AND archived_at IS NOT NULL)");
  if (statuses.includes('deleted')) clauses.push("(status = 'deleted' OR deleted_at IS NOT NULL)");
  return clauses.length ? `(${clauses.join(' OR ')})` : '(0 = 1)';
}

export function financeHistoryLogicalStatus(row) {
  if (row.status === 'deleted' || row.deleted_at) return 'deleted';
  if (row.archived_at) return 'archived';
  return 'active';
}
