import assert from 'node:assert/strict';
import test from 'node:test';

import * as MemoryKernel from './index.js';

import {
  MEMORY_INVARIANTS,
  MEMORY_KERNEL_TYPE_NAMES,
  MemoryLifecycle,
  MemoryRepository,
  canTransitionMemoryStatus,
  isCurrentMemoryStatus,
  isRecallableMemoryStatus,
  validateMemoryRepositoryInterface
} from './index.js';

const invariantIds = [
  'USER_ID_REQUIRED',
  'SOURCE_REQUIRED',
  'FORMAL_MEMORY_TRACEABLE',
  'MODEL_CANNOT_CONFIRM',
  'CANDIDATE_NOT_FORMAL',
  'SUPERSEDED_NOT_CURRENT',
  'DELETED_NOT_RECALLABLE',
  'NO_SILENT_OVERWRITE'
];

for (const invariantId of invariantIds) {
  test(`Memory Invariants include ${invariantId}`, () => {
    assert.ok(MEMORY_INVARIANTS.some((invariant) => invariant.id === invariantId));
  });
}
test('Memory Invariants are frozen', () => {
  assert.ok(Object.isFrozen(MEMORY_INVARIANTS));
  assert.ok(MEMORY_INVARIANTS.every(Object.isFrozen));
});

const allowedTransitions = [
  ['candidate', 'pending_confirmation'],
  ['candidate', 'confirmed'],
  ['candidate', 'deleted'],
  ['pending_confirmation', 'confirmed'],
  ['pending_confirmation', 'deleted'],
  ['confirmed', 'disputed'],
  ['confirmed', 'superseded'],
  ['confirmed', 'expired'],
  ['confirmed', 'archived'],
  ['confirmed', 'deleted'],
  ['disputed', 'confirmed'],
  ['disputed', 'superseded'],
  ['superseded', 'archived'],
  ['expired', 'archived'],
  ['archived', 'deleted']
];

for (const [from, to] of allowedTransitions) {
  test(`MemoryLifecycle allows ${from} -> ${to}`, () => {
    assert.equal(canTransitionMemoryStatus(from, to), true);
    assert.ok(MemoryLifecycle.transitions[from].includes(to));
  });
}

const forbiddenTransitions = [
  ['confirmed', 'candidate'],
  ['superseded', 'confirmed'],
  ['expired', 'confirmed'],
  ['archived', 'confirmed'],
  ['deleted', 'confirmed'],
  ['deleted', 'candidate'],
  ['candidate', 'superseded'],
  ['pending_confirmation', 'candidate']
];

for (const [from, to] of forbiddenTransitions) {
  test(`MemoryLifecycle rejects ${from} -> ${to}`, () => {
    assert.equal(canTransitionMemoryStatus(from, to), false);
  });
}

for (const status of ['candidate', 'pending_confirmation', 'disputed', 'superseded', 'expired', 'archived', 'deleted']) {
  test(`${status} is not a current Memory fact`, () => {
    assert.equal(isCurrentMemoryStatus(status), false);
  });

  test(`${status} is not recallable as a definite fact`, () => {
    assert.equal(isRecallableMemoryStatus(status), false);
  });
}

test('confirmed is the only current and recallable definite status', () => {
  assert.equal(isCurrentMemoryStatus('confirmed'), true);
  assert.equal(isRecallableMemoryStatus('confirmed'), true);
});

test('MemoryRepository is a frozen interface descriptor', () => {
  assert.equal(MemoryRepository.name, 'MemoryRepository');
  assert.deepEqual(MemoryRepository.requiredMethods, [
    'getById', 'query', 'count', 'getVersionChain', 'getConflictGroup',
    'create', 'createMany', 'update', 'confirm', 'reject', 'dispute',
    'archive', 'expire', 'supersede', 'moveToRecycleBin', 'restore',
    'purge', 'withTransaction'
  ]);
  assert.ok(Object.isFrozen(MemoryRepository));
  assert.ok(Object.isFrozen(MemoryRepository.requiredMethods));
});

test('Memory Kernel does not expose storage or persistence contracts', () => {
  assert.equal('MemoryStorage' in MemoryKernel, false);
  assert.equal('validateMemoryStorageInterface' in MemoryKernel, false);
  assert.equal(MEMORY_KERNEL_TYPE_NAMES.includes('MemoryStorage'), false);
});

test('MemoryRepository interface validator accepts method-only fake port', () => {
  const fakePort = Object.fromEntries(MemoryRepository.requiredMethods.map((method) => [method, () => undefined]));
  assert.equal(validateMemoryRepositoryInterface(fakePort).valid, true);
});

for (const method of MemoryRepository.requiredMethods) {
  test(`MemoryRepository interface validator requires ${method}`, () => {
    const fakePort = Object.fromEntries(MemoryRepository.requiredMethods.map((name) => [name, () => undefined]));
    delete fakePort[method];
    const validation = validateMemoryRepositoryInterface(fakePort);
    assert.ok(validation.errors.some((error) => error.path === method && error.code === 'INTERFACE_METHOD_MISSING'));
  });
}
