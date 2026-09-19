function lower(value) {
  return String(value || '').toLowerCase();
}

function includesAny(values = [], queryValues = []) {
  const target = new Set(values.map(lower));
  return queryValues.map(lower).some((item) => target.has(item));
}

function normalizeQueryArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function recordDate(record) {
  return record.eventDate || String(record.createdAt || '').slice(0, 10);
}

function keywordText(record) {
  return [
    record.originalText,
    record.normalizedText,
    record.title,
    record.summary,
    ...(record.people || []),
    ...(record.organizations || []),
    ...(record.projects || []),
    ...(record.tags || [])
  ].map(lower).join(' ');
}

function matchesKeyword(record, keyword) {
  if (!keyword) return true;
  return keywordText(record).includes(lower(keyword));
}

export function matchesMemoryQuery(record, query = {}) {
  if (!query.includeDeleted && record.status === 'deleted') return false;
  if (!query.includeForgotten && record.status === 'forgotten') return false;
  if (query.memoryType && record.memoryType !== query.memoryType) return false;
  if (query.category && record.category !== query.category) return false;
  if (query.sourceType && record.sourceType !== query.sourceType) return false;
  if (query.eventDate && record.eventDate !== query.eventDate) return false;
  if (query.direction && record.direction !== query.direction) return false;
  if (query.status && record.status !== query.status) return false;
  if (query.sensitivity && record.sensitivity !== query.sensitivity) return false;
  if (query.retentionPolicy && record.retentionPolicy !== query.retentionPolicy) return false;
  if (query.minAmount !== undefined && (record.amount === null || record.amount < Number(query.minAmount))) return false;
  if (query.maxAmount !== undefined && (record.amount === null || record.amount > Number(query.maxAmount))) return false;
  if (query.dateFrom && recordDate(record) < query.dateFrom) return false;
  if (query.dateTo && recordDate(record) > query.dateTo) return false;
  if (normalizeQueryArray(query.people).length && !includesAny(record.people, normalizeQueryArray(query.people))) return false;
  if (normalizeQueryArray(query.organizations).length && !includesAny(record.organizations, normalizeQueryArray(query.organizations))) return false;
  if (normalizeQueryArray(query.projects).length && !includesAny(record.projects, normalizeQueryArray(query.projects))) return false;
  if (normalizeQueryArray(query.tags).length && !includesAny(record.tags, normalizeQueryArray(query.tags))) return false;
  return matchesKeyword(record, query.keyword);
}

export function sortMemoryRecords(records, query = {}) {
  const sortBy = query.sortBy || 'createdAt';
  const direction = query.sortOrder === 'asc' ? 1 : -1;
  return [...records].sort((a, b) => {
    const left = a[sortBy] ?? '';
    const right = b[sortBy] ?? '';
    if (left < right) return -1 * direction;
    if (left > right) return 1 * direction;
    return 0;
  });
}

export function applyMemoryQuery(records, query = {}) {
  const offset = Math.max(0, Number(query.offset) || 0);
  const limit = query.limit === undefined ? null : Math.max(0, Number(query.limit));
  const filtered = sortMemoryRecords(records.filter((record) => matchesMemoryQuery(record, query)), query);
  return limit === null ? filtered.slice(offset) : filtered.slice(offset, offset + limit);
}
