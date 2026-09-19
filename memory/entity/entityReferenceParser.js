import { ENTITY_ID_PATTERN } from './contracts.js';

const REFERENCE_KINDS = Object.freeze([
  'none', 'self', 'relation', 'alias', 'alias_relation', 'context', 'entity'
]);
const PROPOSAL_FIELDS = Object.freeze([
  'kind', 'mention', 'alias', 'relationKind', 'role', 'entityId',
  'suggestedEntityId', 'rankedCandidateEntityIds', 'needsClarification'
]);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null;
  if (!nonEmptyString(value)) throw new TypeError(`${field} must be a non-empty string.`);
  return value.trim();
}

function opaqueEntityId(value, field) {
  if (value === undefined || value === null) return null;
  if (!ENTITY_ID_PATTERN.test(String(value))) {
    throw new TypeError(`${field} must be an opaque Entity ID.`);
  }
  return value;
}

export function parseEntityReferenceProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Entity reference proposal must be an object.');
  }
  for (const field of Object.keys(value)) {
    if (!PROPOSAL_FIELDS.includes(field)) throw new TypeError(`Unknown field: ${field}`);
  }
  if (!REFERENCE_KINDS.includes(value.kind)) {
    throw new TypeError('kind must be a supported Entity reference kind.');
  }
  const mention = value.mention === undefined || value.mention === null
    ? ''
    : String(value.mention).trim();
  if (value.kind !== 'none' && mention.length === 0) {
    throw new TypeError('mention is required.');
  }
  const alias = optionalString(value.alias, 'alias');
  const relationKind = optionalString(value.relationKind, 'relationKind');
  const role = optionalString(value.role, 'role');
  const entityId = opaqueEntityId(value.entityId, 'entityId');
  const suggestedEntityId = opaqueEntityId(value.suggestedEntityId, 'suggestedEntityId');
  const rankedCandidateEntityIds = value.rankedCandidateEntityIds ?? [];
  if (!Array.isArray(rankedCandidateEntityIds)) {
    throw new TypeError('rankedCandidateEntityIds must be an array.');
  }
  const ranked = rankedCandidateEntityIds.map((candidate, index) =>
    opaqueEntityId(candidate, `rankedCandidateEntityIds[${index}]`));
  if (value.needsClarification !== undefined && typeof value.needsClarification !== 'boolean') {
    throw new TypeError('needsClarification must be a boolean.');
  }
  if ((value.kind === 'alias' || value.kind === 'alias_relation') && alias === null) {
    throw new TypeError('alias is required for alias references.');
  }
  if ((value.kind === 'relation' || value.kind === 'alias_relation') &&
      (relationKind === null || role === null)) {
    throw new TypeError('relationKind and role are required for relation references.');
  }
  if (value.kind === 'entity' && entityId === null) {
    throw new TypeError('entityId is required for Entity references.');
  }
  return Object.freeze({
    kind: value.kind,
    mention,
    alias,
    relationKind,
    role,
    entityId,
    suggestedEntityId,
    rankedCandidateEntityIds: Object.freeze(ranked),
    needsClarification: value.needsClarification ?? false
  });
}
