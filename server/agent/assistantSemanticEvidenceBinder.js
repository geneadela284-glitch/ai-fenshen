import crypto from 'node:crypto';

function ownerAuthority(value) {
  if (Array.isArray(value)) return value.some(ownerAuthority);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    ['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id'].includes(key) || ownerAuthority(child));
}

function validSpan(span, message) {
  return Boolean(span) && typeof span === 'object' && !Array.isArray(span) &&
    typeof span.text === 'string' && Number.isInteger(span.start) && Number.isInteger(span.end) &&
    span.start >= 0 && span.end > span.start && message.slice(span.start, span.end) === span.text;
}

function readPath(value, dottedPath) {
  return String(dottedPath || '').split('.').reduce((current, key) =>
    current && typeof current === 'object' ? current[key] : undefined, value);
}

function writePath(value, dottedPath, nextValue) {
  const keys = String(dottedPath || '').split('.').filter(Boolean);
  if (!keys.length) return;
  let current = value;
  for (const key of keys.slice(0, -1)) {
    if (!current[key] || typeof current[key] !== 'object' || Array.isArray(current[key])) current[key] = {};
    current = current[key];
  }
  current[keys.at(-1)] = structuredClone(nextValue);
}

export function bindAssistantSemanticEvidence(plan, {
  message = '', sourceMessageId = null, ownerId = null, conversationId = null, trustedContext = null
} = {}) {
  const owner = String(ownerId || '').trim();
  const source = String(sourceMessageId || '').trim();
  const text = String(message || '').trim();
  if (!owner) return { ok: false, code: 'SEMANTIC_OWNER_REQUIRED' };
  if (!source) return { ok: false, code: 'SEMANTIC_SOURCE_MESSAGE_REQUIRED' };
  if (!plan || typeof plan !== 'object' || ownerAuthority(plan)) return { ok: false, code: 'SEMANTIC_OWNER_FORBIDDEN' };

  const auditReasons = [];
  const hints = Array.isArray(plan.source_spans) ? plan.source_spans : [];
  if (!hints.length) auditReasons.push('source_spans_missing');
  else if (!hints.every((span) => validSpan(span, text))) auditReasons.push('source_span_mismatch');

  const contextMatches = trustedContext && trustedContext.owner_id === owner &&
    trustedContext.conversation_id === String(conversationId || '');
  if (trustedContext && !contextMatches) auditReasons.push('trusted_context_scope_mismatch');
  const availableInherited = new Set(contextMatches ? Object.keys(trustedContext.values || {}) : []);
  const explicit = new Set(plan.explicit_fields || []);
  const inherited = (plan.inherited_fields || [])
    .filter((field) => !explicit.has(field) && availableInherited.has(field));

  const bound = structuredClone(plan);
  bound.explicit_fields = [...explicit];
  bound.inherited_fields = inherited;
  for (const field of inherited) {
    const inheritedValue = trustedContext.values[field];
    if (readPath(bound, field) === null || readPath(bound, field) === undefined) {
      writePath(bound, field, inheritedValue);
    }
  }
  bound.source_spans = text ? [{ text, start: 0, end: text.length }] : [];
  bound.source_message_id = source;
  return {
    ok: true,
    plan: Object.freeze(bound),
    evidence: Object.freeze({
      source_message_id: source,
      message_digest: crypto.createHash('sha256').update(text).digest('hex'),
      explicit_fields: Object.freeze([...explicit]),
      inherited_fields: Object.freeze([...inherited])
    }),
    auditReasons: Object.freeze(auditReasons)
  };
}
