import {
  parseProviderPlanCandidateResponse,
  validateProviderPlanCandidate
} from './providerPlanCandidateSchema.js';

const ALLOWED_DOMAINS = new Set(['memory', 'finance', 'tool', 'ordinary_chat', 'ambiguous']);
const FACT_FIELDS = Object.freeze([
  'domain',
  'intent',
  'action',
  'entity',
  'relation_to_owner',
  'predicate',
  'value',
  'qualifiers',
  'tool',
  'arguments',
  'required_evidence',
  'explicit_fields',
  'inherited_fields',
  'ambiguity_reasons'
]);
const FORBIDDEN_ERROR_PATTERNS = Object.freeze([
  /owner authority is forbidden/i,
  /invalid user input/i,
  /true ambiguity/i,
  /evidence.*(?:missing|insufficient|not found)/i,
  /qualifier.*(?:missing|insufficient|required)/i,
  /contract.*(?:reject|denied)/i
]);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripFence(value) {
  return String(value || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

function balancedObject(value) {
  const text = stripFence(value);
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }
  return null;
}

function parseObject(value) {
  const candidates = [stripFence(value), balancedObject(value)].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    try {
      const parsed = JSON.parse(candidate);
      if (plainObject(parsed)) return parsed;
    } catch {
      // Only strict JSON or one balanced strict-JSON object is safe for local repair.
    }
  }
  return null;
}

function unwrapPlanEnvelope(value) {
  if (!plainObject(value)) return value;
  const keys = Object.keys(value);
  return keys.length === 1 && plainObject(value.plan)
    ? structuredClone(value.plan)
    : value;
}

function hasAmbiguitySignal(value) {
  return value?.domain === 'ambiguous' ||
    value?.intent === 'ambiguous' ||
    value?.action === 'ambiguous' ||
    (Array.isArray(value?.ambiguity_reasons) && value.ambiguity_reasons.length > 0);
}

function hasFailureSignal(value) {
  if (!plainObject(value)) return true;
  const signal = [
    value.error,
    value.error_code,
    value.failure,
    value.evidence_status,
    value.contract_status
  ].filter((item) => typeof item === 'string').join(' ');
  return /invalid|ambiguous|missing|insufficient|not.?found|reject|denied|失败|缺失|不足|歧义/i.test(signal);
}

function recognizableSemantics(value) {
  return plainObject(value) &&
    ALLOWED_DOMAINS.has(value.domain) &&
    typeof value.intent === 'string' && value.intent.trim().length > 0 &&
    typeof value.action === 'string' && value.action.trim().length > 0;
}

function scalarToken(value) {
  if (typeof value === 'string') return `scalar:${value.trim()}`;
  if (typeof value === 'number' && Number.isFinite(value)) return `scalar:${String(value)}`;
  if (typeof value === 'boolean') return `boolean:${value}`;
  return null;
}

function collectTokens(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectTokens(item, output));
    return output;
  }
  if (plainObject(value)) {
    Object.keys(value).sort().forEach((key) => collectTokens(value[key], output));
    return output;
  }
  const token = scalarToken(value);
  if (token) output.push(token);
  return output;
}

function semanticTokens(value) {
  if (!plainObject(value)) return [];
  return [...new Set(FACT_FIELDS.flatMap((field) => collectTokens(value[field])))].sort();
}

function changedTokenFields(original, repaired) {
  const originalTokens = new Set(semanticTokens(original));
  const repairedTokens = new Set(semanticTokens(repaired));
  return {
    added: FACT_FIELDS.filter((field) =>
      [...new Set(collectTokens(repaired?.[field]))].some((token) => !originalTokens.has(token))),
    removed: FACT_FIELDS.filter((field) =>
      [...new Set(collectTokens(original?.[field]))].some((token) => !repairedTokens.has(token)))
  };
}

export function parseProviderPlanWithLocalRepair(content) {
  const direct = parseProviderPlanCandidateResponse(content);
  if (direct.valid) {
    return {
      valid: true,
      value: direct.value,
      errors: [],
      repair: 'none',
      rawObject: parseObject(content)
    };
  }
  const rawObject = parseObject(content);
  const projected = unwrapPlanEnvelope(rawObject);
  const local = plainObject(projected)
    ? validateProviderPlanCandidate(projected)
    : { valid: false, value: null, errors: direct.errors };
  if (local.valid) {
    return {
      valid: true,
      value: local.value,
      errors: [],
      repair: 'local',
      rawObject: projected
    };
  }
  const errors = local.errors?.length ? local.errors : direct.errors;
  const forbiddenError = errors.some((error) =>
    FORBIDDEN_ERROR_PATTERNS.some((pattern) => pattern.test(String(error))));
  return {
    valid: false,
    value: null,
    errors,
    repair: 'none',
    rawObject: projected,
    repairEligible: recognizableSemantics(projected) &&
      !hasAmbiguitySignal(projected) &&
      !hasFailureSignal(projected) &&
      !forbiddenError
  };
}

export function validateFormatOnlyProviderPlanRepair({
  originalContent,
  repairedContent
} = {}) {
  const original = unwrapPlanEnvelope(parseObject(originalContent));
  if (!recognizableSemantics(original) || hasAmbiguitySignal(original) || hasFailureSignal(original)) {
    return {
      valid: false,
      code: 'ASSISTANT_SEMANTIC_REPAIR_FORBIDDEN',
      errors: ['repair: original semantics are not safely repairable']
    };
  }
  const parsed = parseProviderPlanCandidateResponse(repairedContent);
  if (!parsed.valid) {
    return {
      valid: false,
      code: 'ASSISTANT_SEMANTIC_PLAN_INVALID',
      errors: parsed.errors
    };
  }
  const originalTokens = semanticTokens(original);
  const repairedTokens = semanticTokens(parsed.value);
  if (JSON.stringify(originalTokens) !== JSON.stringify(repairedTokens)) {
    const changed = changedTokenFields(original, parsed.value);
    return {
      valid: false,
      code: 'ASSISTANT_SEMANTIC_REPAIR_SEMANTICS_CHANGED',
      errors: [
        `repair: semantic token set changed; added_fields=${changed.added.join('|') || 'none'}; removed_fields=${changed.removed.join('|') || 'none'}`
      ]
    };
  }
  return { valid: true, value: parsed.value, errors: [] };
}
