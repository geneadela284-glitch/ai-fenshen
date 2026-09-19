import { createMemoryKernelError, findForbiddenSecretPaths } from '../kernel/index.js';

export const RepositoryActorType = Object.freeze({
  USER: 'user',
  SYSTEM: 'system',
  ADMIN: 'admin'
});

const CONTEXT_FIELDS = Object.freeze([
  'authenticatedUserId',
  'actorType',
  'actorId',
  'requestId',
  'correlationId',
  'timestamp',
  'policyVersion',
  'transactionId',
  'metadata'
]);

function error(path, code, message) {
  return createMemoryKernelError(path, code, message);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function object(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateRepositoryContext(context) {
  const errors = [];
  if (!object(context)) {
    return { valid: false, errors: [error('', 'INVALID_TYPE', 'RepositoryContext must be an object.')], warnings: [] };
  }

  for (const field of CONTEXT_FIELDS) {
    if (!(field in context)) errors.push(error(field, 'REQUIRED', `${field} is required.`));
  }
  for (const field of Object.keys(context)) {
    if (!CONTEXT_FIELDS.includes(field)) errors.push(error(field, 'UNKNOWN_FIELD', `Unknown field: ${field}`));
  }
  for (const field of ['authenticatedUserId', 'actorId', 'requestId', 'correlationId', 'policyVersion']) {
    if (field in context && !nonEmptyString(context[field])) errors.push(error(field, 'REQUIRED', `${field} is required.`));
  }
  if (!Object.values(RepositoryActorType).includes(context.actorType)) {
    errors.push(error('actorType', 'INVALID_ENUM', 'actorType is invalid.'));
  }
  if (typeof context.timestamp !== 'string' || Number.isNaN(Date.parse(context.timestamp))) {
    errors.push(error('timestamp', 'INVALID_DATE', 'timestamp must be an ISO date.'));
  }
  if (context.transactionId !== null && !nonEmptyString(context.transactionId)) {
    errors.push(error('transactionId', 'INVALID_TYPE', 'transactionId must be a non-empty string or null.'));
  }
  if (!object(context.metadata)) {
    errors.push(error('metadata', 'INVALID_TYPE', 'metadata must be an object.'));
  } else {
    for (const path of findForbiddenSecretPaths(context.metadata, 'metadata')) {
      errors.push(error(path, 'SECRET_FORBIDDEN', 'RepositoryContext metadata cannot contain secrets.'));
    }
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}
