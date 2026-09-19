import { createMemoryKernelError } from './errors.js';

function descriptor(name, requiredMethods) {
  return Object.freeze({
    name,
    schemaVersion: 'v1',
    requiredMethods: Object.freeze(requiredMethods)
  });
}
export const MemoryRepository = descriptor('MemoryRepository', [
  'getById', 'query', 'count', 'getVersionChain', 'getConflictGroup',
  'create', 'createMany', 'update', 'confirm', 'reject', 'dispute',
  'archive', 'expire', 'supersede', 'moveToRecycleBin', 'restore',
  'purge', 'withTransaction'
]);

function validateInterface(value, contract) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(createMemoryKernelError('', 'INVALID_TYPE', `${contract.name} must be an object.`));
  } else {
    for (const method of contract.requiredMethods) {
      if (typeof value[method] !== 'function') {
        errors.push(createMemoryKernelError(method, 'INTERFACE_METHOD_MISSING', `${method}() is required.`));
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings: [] };
}

export function validateMemoryRepositoryInterface(value) {
  return validateInterface(value, MemoryRepository);
}
