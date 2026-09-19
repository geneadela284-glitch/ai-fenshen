import crypto from 'node:crypto';

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function validDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
      year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateObject(value) {
  if (!plainObject(value) || !Number.isInteger(value.month) || !Number.isInteger(value.day)) return null;
  if (value.year === null || value.year === undefined) {
    return validDate(2000, value.month, value.day)
      ? { type: 'date_without_year', month: value.month, day: value.day }
      : false;
  }
  return validDate(value.year, value.month, value.day)
    ? { type: 'date', year: value.year, month: value.month, day: value.day }
    : false;
}

function scalar(value) {
  const scalarType = value === null ? 'null' : typeof value;
  if (!['null', 'string', 'number', 'boolean'].includes(scalarType) ||
      (scalarType === 'number' && !Number.isFinite(value))) return null;
  return {
    type: 'scalar',
    scalar_type: scalarType === 'number' && Number.isInteger(value) ? 'integer' : scalarType,
    value
  };
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!plainObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function rawValueAudit(value) {
  const serialized = stableJson(value);
  return Object.freeze({
    raw_value_type: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
    raw_value_sha256: crypto.createHash('sha256').update(serialized).digest('hex')
  });
}

export function canonicalizeAssistantValue(value, { expectedType = null, tool = null } = {}) {
  if (expectedType === 'entity_reference') {
    if (!plainObject(value)) return { ok: false, code: 'CANONICAL_VALUE_TYPE_INVALID' };
    const reference = {
      type: 'entity_reference',
      entity_type: value.type ?? null,
      reference: value.reference ?? null,
      relation_to_owner: value.relation_to_owner ?? null
    };
    if ([reference.entity_type, reference.reference, reference.relation_to_owner]
      .some((item) => item !== null && typeof item !== 'string')) {
      return { ok: false, code: 'CANONICAL_VALUE_TYPE_INVALID' };
    }
    return { ok: true, value: reference };
  }

  if (expectedType === 'tool_arguments') {
    if (!plainObject(value) || typeof tool !== 'string' || !tool) {
      return { ok: false, code: 'CANONICAL_VALUE_TYPE_INVALID' };
    }
    return {
      ok: true,
      value: { type: 'tool_arguments', tool, arguments: structuredClone(value) }
    };
  }

  if (typeof value === 'string') {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      const [, year, month, day] = match.map(Number);
      if (!validDate(year, month, day)) return { ok: false, code: 'CANONICAL_DATE_INVALID' };
      return { ok: true, value: { type: 'date', year, month, day } };
    }
  }

  const structuredDate = dateObject(value);
  if (structuredDate === false) return { ok: false, code: 'CANONICAL_DATE_INVALID' };
  if (structuredDate) return { ok: true, value: structuredDate };

  if (Array.isArray(value)) {
    const items = [];
    const seen = new Set();
    let itemType = null;
    for (const item of value) {
      const canonical = canonicalizeAssistantValue(item);
      if (!canonical.ok) return canonical;
      if (itemType === null) itemType = canonical.value.type;
      if (canonical.value.type !== itemType) return { ok: false, code: 'CANONICAL_LIST_TYPE_CONFLICT' };
      const key = stableJson(canonical.value);
      if (!seen.has(key)) {
        seen.add(key);
        items.push(canonical.value);
      }
    }
    return { ok: true, value: { type: 'list', item_type: itemType, items } };
  }

  if (plainObject(value)) {
    return { ok: true, value: { type: 'object', fields: structuredClone(value) } };
  }

  const canonicalScalar = scalar(value);
  return canonicalScalar
    ? { ok: true, value: canonicalScalar }
    : { ok: false, code: 'CANONICAL_VALUE_TYPE_INVALID' };
}
