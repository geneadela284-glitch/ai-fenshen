import {
  ENTITY_ID_PATTERN,
  PREDICATE_STRUCTURED_VALUE_SCHEMAS
} from '../entity/contracts.js';
import {
  GROUNDING_V2_ERROR_CODES,
  GroundingV2Error
} from './groundingV2.js';

const FIELDS = Object.freeze([
  'schemaVersion',
  'type',
  'grounded',
  'ownerUserId',
  'subjectEntityId',
  'predicate',
  'safeUserMessage',
  'immutableFact',
  'evidenceMemoryIds',
  'clarificationRequired',
  'governanceRequired',
  'aiPolicy'
]);

const TYPES = Object.freeze([
  'fact',
  'not_found',
  'clarification',
  'conflict',
  'evidence_invalid'
]);

export const SafeAnswerContractV2 = Object.freeze({
  name: 'SafeAnswerContractV2',
  schemaVersion: 'v2',
  fields: FIELDS,
  required: FIELDS,
  types: TYPES,
  unknownFieldPolicy: 'reject',
  aiRole: 'natural-expression-only',
  factMutationPolicy: 'reject'
});

function fail(message) {
  throw new GroundingV2Error(GROUNDING_V2_ERROR_CODES.evidenceInvalid, message);
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function sameValue(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertExactFields(value, fields, label) {
  if (!object(value)) fail(`${label} must be an object.`);
  const unknown = Object.keys(value).find((field) => !fields.includes(field));
  if (unknown) fail(`Unknown ${label} field: ${unknown}.`);
  const missing = fields.find((field) => !(field in value) || value[field] === undefined);
  if (missing) fail(`${label}.${missing} is required.`);
}

function assertAllowedFields(value, fields, label) {
  if (!object(value)) fail(`${label} must be an object.`);
  const unknown = Object.keys(value).find((field) => !fields.includes(field));
  if (unknown) fail(`Unknown ${label} field: ${unknown}.`);
}

function assertScope(scope) {
  if (!object(scope) || !nonEmptyString(scope.ownerUserId) ||
      (scope.subjectEntityId !== null && !ENTITY_ID_PATTERN.test(String(scope.subjectEntityId ?? ''))) ||
      !Object.hasOwn(PREDICATE_STRUCTURED_VALUE_SCHEMAS, scope.predicate)) {
    fail('Safe Answer scope is invalid.');
  }
}

function formatFact(predicate, structuredValue) {
  if (predicate === 'birthday' && /^\d{4}-(\d{2})-(\d{2})$/.test(String(structuredValue?.date ?? ''))) {
    const [, month, day] = structuredValue.date.match(/^\d{4}-(\d{2})-(\d{2})$/);
    return `${Number(month)}月${Number(day)}号。`;
  }
  if (predicate === 'preference_statement') {
    const values = Array.isArray(structuredValue?.values)
      ? structuredValue.values.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (values.length) return `${values.join('、')}。`;
    if (nonEmptyString(structuredValue?.value)) return `${structuredValue.value.trim()}。`;
  }
  if (predicate === 'favorite_preference_statement' && nonEmptyString(structuredValue?.value)) {
    return `${structuredValue.value.trim()}。`;
  }
  fail('Safe Answer has no deterministic formatter for this grounded predicate.');
}

function safeAnswerValue(value) {
  return {
    schemaVersion: 'v2',
    ...value,
    aiPolicy: {
      role: 'natural-expression-only',
      mayAddFacts: false,
      mayChangeScope: false,
      mayChangeDatesOrNumbers: false,
      proposalMustVerify: true
    }
  };
}

export function assertSafeAnswerContractV2(value) {
  assertExactFields(value, FIELDS, 'SafeAnswerContractV2');
  if (value.schemaVersion !== 'v2' || !TYPES.includes(value.type) ||
      typeof value.grounded !== 'boolean' || !nonEmptyString(value.safeUserMessage) ||
      !Array.isArray(value.evidenceMemoryIds) ||
      typeof value.clarificationRequired !== 'boolean' || typeof value.governanceRequired !== 'boolean' ||
      !object(value.aiPolicy)) {
    fail('SafeAnswerContractV2 is invalid.');
  }
  assertScope(value);
  if (value.type === 'fact' && (!value.grounded || !object(value.immutableFact) || value.evidenceMemoryIds.length === 0)) {
    fail('A fact Safe Answer requires verified grounded evidence.');
  }
  if (value.type !== 'fact' && value.immutableFact !== null) {
    fail('A non-fact Safe Answer cannot carry a fact payload.');
  }
  return value;
}

export function buildSafeAnswerV2(input) {
  assertAllowedFields(input, ['type', 'groundingResult', 'query', 'scope', 'clarificationQuestion'], 'Safe Answer input');
  if (!nonEmptyString(input.type)) fail('Safe Answer input.type is required.');
  const { type } = input;
  let value;
  if (type === 'fact') {
    const result = input.groundingResult;
    if (!object(result) || result.grounded !== true) fail('Fact Safe Answer requires a grounded result.');
    value = safeAnswerValue({
      type,
      grounded: true,
      ownerUserId: result.ownerUserId,
      subjectEntityId: result.subjectEntityId,
      predicate: result.predicate,
      safeUserMessage: formatFact(result.predicate, result.structuredValue),
      immutableFact: structuredClone(result.structuredValue),
      evidenceMemoryIds: [...result.evidenceMemoryIds],
      clarificationRequired: false,
      governanceRequired: false
    });
  } else if (type === 'not_found') {
    const query = input.query;
    assertScope(query);
    value = safeAnswerValue({
      type,
      grounded: false,
      ownerUserId: query.ownerUserId,
      subjectEntityId: query.subjectEntityId,
      predicate: query.predicate,
      safeUserMessage: '我目前没有找到这项记录。',
      immutableFact: null,
      evidenceMemoryIds: [],
      clarificationRequired: false,
      governanceRequired: false
    });
  } else if (type === 'clarification') {
    assertScope(input.scope);
    if (!nonEmptyString(input.clarificationQuestion) ||
        (input.clarificationQuestion.match(/[？?]/g) ?? []).length !== 1) {
      fail('Clarification requires exactly one necessary question.');
    }
    value = safeAnswerValue({
      type,
      grounded: false,
      ...input.scope,
      safeUserMessage: input.clarificationQuestion,
      immutableFact: null,
      evidenceMemoryIds: [],
      clarificationRequired: true,
      governanceRequired: false
    });
  } else if (type === 'conflict' || type === 'evidence_invalid') {
    const result = input.groundingResult;
    const expectedCode = type === 'conflict'
      ? GROUNDING_V2_ERROR_CODES.memoryConflict
      : GROUNDING_V2_ERROR_CODES.evidenceInvalid;
    if (!object(result) || result.grounded !== false || result.errorCode !== expectedCode) {
      fail(`${type} Safe Answer requires the matching failed Grounded Result.`);
    }
    const scope = input.scope ?? input.query;
    assertScope(scope);
    value = safeAnswerValue({
      type,
      grounded: false,
      ownerUserId: scope.ownerUserId,
      subjectEntityId: scope.subjectEntityId,
      predicate: scope.predicate,
      safeUserMessage: result.safeUserMessage,
      immutableFact: null,
      evidenceMemoryIds: [],
      clarificationRequired: result.clarificationRequired,
      governanceRequired: result.governanceRequired
    });
  } else {
    fail('Safe Answer type is unsupported.');
  }
  assertSafeAnswerContractV2(value);
  return deepFreeze(value);
}

export function verifySafeAnswerProposalV2(contract, proposal) {
  assertSafeAnswerContractV2(contract);
  assertSafeAnswerContractV2(proposal);
  if (!sameValue(contract, proposal)) {
    fail('AI proposal changed a sealed Safe Answer fact, scope, or outcome.');
  }
  return deepFreeze(structuredClone(proposal));
}
