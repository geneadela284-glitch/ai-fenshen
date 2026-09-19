import {
  computeMemoryRecordV2Checksum,
  validateEntity,
  validateEntityAlias,
  validateEntityRelation,
  validateMemoryRecordV2
} from './validation.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export class EntityKernelValidationError extends TypeError {
  constructor(issues) {
    super('Entity Model V2 Kernel rejected an invalid contract value.');
    this.name = 'EntityKernelValidationError';
    this.code = 'ENTITY_KERNEL_VALIDATION_FAILED';
    this.issues = Object.freeze([...issues]);
  }
}

function materialize(value, validator, options, prepare = (candidate) => candidate) {
  const candidate = prepare(structuredClone(value));
  const validation = validator(candidate, options);
  if (!validation.valid) throw new EntityKernelValidationError(validation.errors);
  return deepFreeze(candidate);
}

export function createEntity(value, options = {}) {
  return materialize(value, validateEntity, options);
}

export function createEntityAlias(value, options = {}) {
  return materialize(value, validateEntityAlias, options);
}

export function createEntityRelation(value, options = {}) {
  return materialize(value, validateEntityRelation, options);
}

export function createMemoryRecordV2(value, options = {}) {
  return materialize(value, validateMemoryRecordV2, options, (candidate) => {
    candidate.checksum = computeMemoryRecordV2Checksum(candidate);
    return candidate;
  });
}
