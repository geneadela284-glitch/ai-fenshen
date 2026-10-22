import crypto from 'node:crypto';

import { ENTITY_ID_PATTERN, PREDICATE_STRUCTURED_VALUE_SCHEMAS, MEMORY_V2_SENSITIVITIES } from './contracts.js';
import { createMemoryRecordV2 } from './kernel.js';
import { EntityFoundationError, immutableCopy } from './inMemoryFoundationState.js';

const ACTIONS = Object.freeze(['correction', 'delete', 'restore', 'purge']);
const COMMAND_FIELDS = Object.freeze([
  'schemaVersion',
  'lifecycleAction',
  'subjectEntityId',
  'predicate',
  'memoryId',
  'expectedVersion',
  'idempotencyKey',
  'structuredValue',
  'confirmed',
  'sourceMessageId'
]);
const COMMAND_REQUIRED_FIELDS = Object.freeze(COMMAND_FIELDS.filter((field) => field !== 'sourceMessageId'));
const INVALIDATION_FIELDS = Object.freeze([
  'ownerUserId',
  'subjectEntityId',
  'predicate',
  'memoryId',
  'lifecycleAction',
  'previousVersion',
  'newVersion',
  'invalidationToken',
  'occurredAt'
]);
const CACHE_KEY_FIELDS = Object.freeze([
  'ownerUserId',
  'subjectEntityId',
  'predicate',
  'generation',
  'invalidationToken',
  'readMode'
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const MemoryLifecycleCommandV2 = Object.freeze({
  name: 'MemoryLifecycleCommandV2',
  schemaVersion: 'v2',
  fields: COMMAND_FIELDS,
  required: COMMAND_REQUIRED_FIELDS,
  unknownFieldPolicy: 'reject',
  lifecycleActions: ACTIONS
});

export const MemoryInvalidationV2 = Object.freeze({
  name: 'MemoryInvalidationV2',
  fields: INVALIDATION_FIELDS,
  required: INVALIDATION_FIELDS,
  unknownFieldPolicy: 'reject'
});

export const MemoryRecallCacheKeyV2 = Object.freeze({
  name: 'MemoryRecallCacheKeyV2',
  fields: CACHE_KEY_FIELDS,
  required: CACHE_KEY_FIELDS,
  unknownFieldPolicy: 'reject'
});

export class MemoryLifecycleV2Error extends EntityFoundationError {
  constructor(code, message) {
    super(code, message);
    this.name = 'MemoryLifecycleV2Error';
  }
}

function fail(code, message) {
  throw new MemoryLifecycleV2Error(code, message);
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoTimestamp(value) {
  return nonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function assertExactFields(value, fields, label) {
  if (!object(value)) fail('LIFECYCLE_INPUT_INVALID', `${label} must be an object.`);
  const unknown = Object.keys(value).find((field) => !fields.includes(field));
  if (unknown) fail('LIFECYCLE_UNKNOWN_FIELD', `Unknown ${label} field: ${unknown}.`);
  const missing = fields.find((field) => !(field in value) || value[field] === undefined);
  if (missing) fail('LIFECYCLE_FIELD_REQUIRED', `${label}.${missing} is required.`);
}

function assertCommandFields(value) {
  if (!object(value)) fail('LIFECYCLE_INPUT_INVALID', 'MemoryLifecycleCommandV2 must be an object.');
  const unknown = Object.keys(value).find((field) => !COMMAND_FIELDS.includes(field));
  if (unknown) fail('LIFECYCLE_UNKNOWN_FIELD', `Unknown MemoryLifecycleCommandV2 field: ${unknown}.`);
  const missing = COMMAND_REQUIRED_FIELDS.find((field) => !(field in value) || value[field] === undefined);
  if (missing) fail('LIFECYCLE_FIELD_REQUIRED', `MemoryLifecycleCommandV2.${missing} is required.`);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!object(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function assertContext(context) {
  if (!object(context) || Object.keys(context).some((field) => field !== 'ownerUserId') ||
      !nonEmptyString(context.ownerUserId)) {
    fail('OWNER_SCOPE_REQUIRED', 'Trusted lifecycle context requires ownerUserId only.');
  }
}

function assertCommand(command) {
  assertCommandFields(command);
  if (command.schemaVersion !== 'v2') fail('UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion must be v2.');
  if (!ACTIONS.includes(command.lifecycleAction)) fail('LIFECYCLE_ACTION_INVALID', 'lifecycleAction is unsupported.');
  if (!ENTITY_ID_PATTERN.test(String(command.subjectEntityId ?? ''))) {
    fail('ENTITY_ID_INVALID', 'subjectEntityId must be an opaque Entity ID.');
  }
  if (!nonEmptyString(command.predicate) || !Object.hasOwn(PREDICATE_STRUCTURED_VALUE_SCHEMAS, command.predicate)) {
    fail('PREDICATE_INVALID', 'predicate must have a registered structuredValue schema.');
  }
  if (!nonEmptyString(command.memoryId)) fail('MEMORY_ID_INVALID', 'memoryId is required.');
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
    fail('EXPECTED_VERSION_INVALID', 'expectedVersion must be a positive integer.');
  }
  if (!nonEmptyString(command.idempotencyKey)) fail('IDEMPOTENCY_KEY_INVALID', 'idempotencyKey is required.');
  if (typeof command.confirmed !== 'boolean') fail('CONFIRMATION_INVALID', 'confirmed must be boolean.');
  if (command.sourceMessageId !== undefined && command.sourceMessageId !== null && !nonEmptyString(command.sourceMessageId)) {
    fail('SOURCE_MESSAGE_ID_INVALID', 'sourceMessageId must be a non-empty string or null.');
  }
  if (command.lifecycleAction === 'correction') {
    if (!object(command.structuredValue)) fail('STRUCTURED_VALUE_REQUIRED', 'Correction requires structuredValue.');
  } else if (command.structuredValue !== null) {
    fail('STRUCTURED_VALUE_FORBIDDEN', 'Only correction accepts structuredValue.');
  }
  if (command.lifecycleAction !== 'purge' && command.confirmed) {
    fail('CONFIRMATION_INVALID', 'confirmed is reserved for purge.');
  }
  return command;
}

function assertVersion(current, expectedVersion) {
  if (current.version !== expectedVersion) fail('CAS_CONFLICT', 'Memory version changed before lifecycle command.');
}

function assertScope(current, command, action) {
  if (current.subjectEntityId !== command.subjectEntityId) {
    fail(action === 'correction' ? 'REBIND_REQUIRED' : 'ENTITY_SCOPE_MISMATCH',
      action === 'correction'
        ? 'Ordinary correction cannot rebind an Entity.'
        : 'Memory is outside the exact Entity scope.');
  }
  if (current.predicate !== command.predicate) {
    fail('PREDICATE_SCOPE_MISMATCH', 'Memory is outside the exact predicate scope.');
  }
}

function auditMetadata(current, action, occurredAt) {
  return {
    ...structuredClone(current.metadata ?? {}),
    lifecycleAudit: {
      lifecycleAction: action,
      previousVersion: current.version,
      previousChecksum: current.checksum,
      occurredAt
    }
  };
}

function transitionRecord(current, changes, action, occurredAt) {
  return createMemoryRecordV2({
    ...structuredClone(current),
    ...structuredClone(changes),
    updatedAt: occurredAt,
    version: current.version + 1,
    metadata: auditMetadata(current, action, occurredAt)
  }, { trustedOwnerUserId: current.ownerUserId });
}

function correctedRecord(current, command, memoryId, occurredAt, correctionSensitivity) {
  const assessed = correctionSensitivity(immutableCopy(current), immutableCopy(command));
  if (!MEMORY_V2_SENSITIVITIES.includes(assessed)) fail('SENSITIVITY_INVALID', 'Correction sensitivity must be governed.');
  const sensitivity = MEMORY_V2_SENSITIVITIES[Math.max(MEMORY_V2_SENSITIVITIES.indexOf(current.sensitivity), MEMORY_V2_SENSITIVITIES.indexOf(assessed))];
  const sourceMessageId = nonEmptyString(command.sourceMessageId) ? command.sourceMessageId.trim() : null;
  return createMemoryRecordV2({
    ...structuredClone(current),
    memoryId,
    structuredValue: structuredClone(command.structuredValue),
    displayValue: null,
    sensitivity,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    effectiveFrom: occurredAt,
    effectiveTo: null,
    status: 'confirmed',
    version: current.version + 1,
    supersedesId: current.memoryId,
    supersededById: null,
    conflictGroupId: null,
    provenance: 'user_confirmed',
    source: sourceMessageId ? { type: 'conversation_message', id: sourceMessageId } : structuredClone(current.source),
    sourceTimestamp: sourceMessageId ? occurredAt : current.sourceTimestamp,
    metadata: {
      ...auditMetadata(current, 'correction', occurredAt),
      ...(sourceMessageId ? { sourceMessageId } : {})
    }
  }, { trustedOwnerUserId: current.ownerUserId });
}

function invalidation({ ownerUserId, command, memoryId, previousVersion, newVersion, occurredAt }) {
  const binding = {
    ownerUserId,
    subjectEntityId: command.subjectEntityId,
    predicate: command.predicate,
    memoryId,
    lifecycleAction: command.lifecycleAction,
    previousVersion,
    newVersion,
    occurredAt
  };
  return Object.freeze({ ...binding, invalidationToken: digest(binding) });
}

function result(outcome, command, event, memoryId) {
  return Object.freeze({
    outcome,
    confirmationRequired: command.lifecycleAction === 'purge',
    lifecycleAction: command.lifecycleAction,
    memoryId,
    invalidation: event
  });
}

function idempotentResult(value, commandFingerprint) {
  return Object.freeze({ ...value, commandFingerprint });
}

function publicResult(value, commandFingerprint) {
  if (value?.commandFingerprint !== commandFingerprint) {
    fail('IDEMPOTENCY_CONFLICT', 'idempotencyKey was already used for a different lifecycle command.');
  }
  const { commandFingerprint: ignored, ...visible } = value;
  return Object.freeze(visible);
}

function chainFor(records, targetMemoryId) {
  const ids = new Set([targetMemoryId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (ids.has(record.memoryId) || ids.has(record.supersedesId) || ids.has(record.supersededById)) {
        if (!ids.has(record.memoryId)) {
          ids.add(record.memoryId);
          changed = true;
        }
      }
    }
  }
  return records.filter((record) => ids.has(record.memoryId));
}

function purgedMarker(current, event) {
  return Object.freeze({
    ownerUserId: current.ownerUserId,
    memoryId: current.memoryId,
    subjectEntityId: current.subjectEntityId,
    predicate: current.predicate,
    status: 'deleted',
    version: event.newVersion,
    metadata: Object.freeze({
      purgedMarker: true,
      lifecycleAction: 'purge',
      invalidationToken: event.invalidationToken,
      purgedAt: event.occurredAt
    })
  });
}

export function validateMemoryInvalidationV2(value, { trustedOwnerUserId } = {}) {
  const errors = [];
  try {
    assertExactFields(value, INVALIDATION_FIELDS, 'MemoryInvalidationV2');
    if (!nonEmptyString(trustedOwnerUserId) || value.ownerUserId !== trustedOwnerUserId) {
      fail('OWNER_SCOPE_MISMATCH', 'Invalidation owner is outside trusted scope.');
    }
    if (!ENTITY_ID_PATTERN.test(String(value.subjectEntityId ?? '')) ||
        !nonEmptyString(value.predicate) || !nonEmptyString(value.memoryId) ||
        !ACTIONS.includes(value.lifecycleAction) ||
        !Number.isSafeInteger(value.previousVersion) || value.previousVersion < 1 ||
        !Number.isSafeInteger(value.newVersion) || value.newVersion <= value.previousVersion ||
        !SHA256_PATTERN.test(String(value.invalidationToken ?? '')) ||
        !isoTimestamp(value.occurredAt)) {
      fail('INVALIDATION_INVALID', 'Memory invalidation binding is invalid.');
    }
    const { invalidationToken, ...binding } = value;
    if (invalidationToken !== digest(binding)) {
      fail('INVALIDATION_TOKEN_MISMATCH', 'Memory invalidation token does not match its scope and version binding.');
    }
  } catch (error) {
    errors.push(Object.freeze({ code: error.code ?? 'INVALIDATION_INVALID', message: error.message }));
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function buildMemoryRecallCacheKeyV2(input) {
  assertExactFields(input, CACHE_KEY_FIELDS, 'MemoryRecallCacheKeyV2');
  if (!nonEmptyString(input.ownerUserId) || !ENTITY_ID_PATTERN.test(String(input.subjectEntityId ?? '')) ||
      !nonEmptyString(input.predicate) || !nonEmptyString(input.generation) ||
      !SHA256_PATTERN.test(String(input.invalidationToken ?? '')) ||
      !['current', 'historical'].includes(input.readMode)) {
    fail('CACHE_KEY_INVALID', 'Memory recall cache key binding is invalid.');
  }
  return `memory-recall-v2:${digest(input)}`;
}

export function createMemoryLifecycleV2({
  foundation,
  now = () => new Date().toISOString(),
  memoryIdFactory,
  faultInjector = () => {},
  correctionSensitivity = current => current.sensitivity
} = {}) {
  if (!foundation?.unitOfWork || typeof foundation.unitOfWork.run !== 'function' ||
      typeof memoryIdFactory !== 'function' || typeof now !== 'function' ||
      typeof faultInjector !== 'function' || typeof correctionSensitivity !== 'function') {
    throw new TypeError('Memory Lifecycle V2 requires Foundation Unit of Work, clock, ID factory, and fault injector.');
  }

  return Object.freeze({
    async execute(trustedContext, input) {
      assertContext(trustedContext);
      const command = assertCommand(input);
      if (command.lifecycleAction === 'purge' && !command.confirmed) {
        return Object.freeze({
          outcome: 'confirmation_required',
          confirmationRequired: true,
          lifecycleAction: 'purge',
          memoryId: command.memoryId,
          invalidation: null
        });
      }
      const ownerUserId = trustedContext.ownerUserId;
      const commandFingerprint = digest(command);
      const stored = await foundation.unitOfWork.run({
        ownerUserId,
        idempotencyKey: `memory-lifecycle-v2:${command.idempotencyKey}`
      }, async ({ memories }) => {
        const current = memories.getById(ownerUserId, command.memoryId);
        if (!current) fail('MEMORY_NOT_FOUND', 'Memory was not found in the trusted owner scope.');
        if (current.metadata?.purgedMarker === true) fail('MEMORY_PURGED', 'Purged Memory cannot be restored or changed.');
        assertScope(current, command, command.lifecycleAction);

        const occurredAt = now();
        if (!isoTimestamp(occurredAt)) fail('TRUSTED_TIME_INVALID', 'Lifecycle clock must return an ISO timestamp.');
        const records = memories.listByEntityAndPredicateForLifecycle(
          ownerUserId,
          command.subjectEntityId,
          command.predicate
        );

        if (command.lifecycleAction === 'correction') {
          if (current.supersededById || records.some((record) => record.supersedesId === current.memoryId)) {
            fail('MEMORY_CONFLICT', 'Memory version already has a superseding branch.');
          }
          if (current.status !== 'confirmed' || current.conflictGroupId) {
            fail('MEMORY_CONFLICT', 'Only one unconflicted current confirmed Memory can be corrected.');
          }
          assertVersion(current, command.expectedVersion);
          const replacementId = memoryIdFactory();
          if (!nonEmptyString(replacementId)) fail('MEMORY_ID_INVALID', 'Correction memoryIdFactory returned an invalid ID.');
          const previous = transitionRecord(current, {
            status: 'superseded',
            supersededById: replacementId,
            effectiveTo: occurredAt
          }, 'correction', occurredAt);
          memories.transition(ownerUserId, current.memoryId, previous, { expectedVersion: current.version });
          faultInjector('after_previous_superseded');
          const replacement = correctedRecord(current, command, replacementId, occurredAt, correctionSensitivity);
          memories.create(ownerUserId, replacement);
          faultInjector('after_correction');
          const event = invalidation({
            ownerUserId,
            command,
            memoryId: replacement.memoryId,
            previousVersion: current.version,
            newVersion: replacement.version,
            occurredAt
          });
          return idempotentResult(result('corrected', command, event, replacement.memoryId), commandFingerprint);
        }

        if (command.lifecycleAction === 'delete') {
          if (current.supersededById || current.status === 'superseded') {
            fail('DELETE_SUPERSEDED_FORBIDDEN', 'Superseded old Memory cannot be deleted as current fact.');
          }
          assertVersion(current, command.expectedVersion);
          const deleted = transitionRecord(current, { status: 'deleted' }, 'delete', occurredAt);
          memories.transition(ownerUserId, current.memoryId, deleted, { expectedVersion: current.version });
          faultInjector('after_delete');
          const event = invalidation({
            ownerUserId,
            command,
            memoryId: deleted.memoryId,
            previousVersion: current.version,
            newVersion: deleted.version,
            occurredAt
          });
          return idempotentResult(result('deleted', command, event, deleted.memoryId), commandFingerprint);
        }

        if (command.lifecycleAction === 'restore') {
          if (current.status === 'superseded' || current.supersededById) {
            fail('RESTORE_SUPERSEDED_FORBIDDEN', 'Superseded old Memory cannot become current through restore.');
          }
          if (current.status !== 'deleted') fail('RESTORE_NOT_DELETED', 'Only deleted Memory can be restored.');
          if (current.conflictGroupId || records.filter((record) => record.supersedesId === current.memoryId).length > 0) {
            fail('MEMORY_CONFLICT', 'Conflicted Memory cannot be restored.');
          }
          assertVersion(current, command.expectedVersion);
          const restored = transitionRecord(current, { status: 'confirmed', effectiveTo: null }, 'restore', occurredAt);
          memories.transition(ownerUserId, current.memoryId, restored, { expectedVersion: current.version });
          faultInjector('after_restore');
          const event = invalidation({
            ownerUserId,
            command,
            memoryId: restored.memoryId,
            previousVersion: current.version,
            newVersion: restored.version,
            occurredAt
          });
          return idempotentResult(result('restored', command, event, restored.memoryId), commandFingerprint);
        }

        assertVersion(current, command.expectedVersion);
        const chain = chainFor(records, current.memoryId);
        const event = invalidation({
          ownerUserId,
          command,
          memoryId: current.memoryId,
          previousVersion: current.version,
          newVersion: current.version + 1,
          occurredAt
        });
        memories.purgeChain(ownerUserId, {
          targetMemoryId: current.memoryId,
          subjectEntityId: current.subjectEntityId,
          predicate: current.predicate,
          expectedVersion: current.version,
          chainMemoryIds: chain.map((record) => record.memoryId),
          marker: purgedMarker(current, event)
        });
        faultInjector('after_purge');
        return idempotentResult(result('purged', command, event, current.memoryId), commandFingerprint);
      });
      return publicResult(stored, commandFingerprint);
    }
  });
}
