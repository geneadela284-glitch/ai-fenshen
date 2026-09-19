import { MemoryStatus } from './enums.js';

function freezeTransitions(transitions) {
  return Object.freeze(Object.fromEntries(
    Object.entries(transitions).map(([status, next]) => [status, Object.freeze(next)])
  ));
}
export const MemoryLifecycle = Object.freeze({
  schemaVersion: 'v1',
  transitions: freezeTransitions({
    [MemoryStatus.CANDIDATE]: [
      MemoryStatus.PENDING_CONFIRMATION,
      MemoryStatus.CONFIRMED,
      MemoryStatus.DISPUTED,
      MemoryStatus.EXPIRED,
      MemoryStatus.ARCHIVED,
      MemoryStatus.DELETED
    ],
    [MemoryStatus.PENDING_CONFIRMATION]: [
      MemoryStatus.CONFIRMED,
      MemoryStatus.DISPUTED,
      MemoryStatus.EXPIRED,
      MemoryStatus.ARCHIVED,
      MemoryStatus.DELETED
    ],
    [MemoryStatus.CONFIRMED]: [
      MemoryStatus.DISPUTED,
      MemoryStatus.SUPERSEDED,
      MemoryStatus.EXPIRED,
      MemoryStatus.ARCHIVED,
      MemoryStatus.DELETED
    ],
    [MemoryStatus.DISPUTED]: [
      MemoryStatus.CONFIRMED,
      MemoryStatus.SUPERSEDED,
      MemoryStatus.ARCHIVED,
      MemoryStatus.DELETED
    ],
    [MemoryStatus.SUPERSEDED]: [MemoryStatus.ARCHIVED, MemoryStatus.DELETED],
    [MemoryStatus.EXPIRED]: [MemoryStatus.ARCHIVED, MemoryStatus.DELETED],
    [MemoryStatus.ARCHIVED]: [MemoryStatus.DELETED],
    [MemoryStatus.DELETED]: []
  })
});

export const MEMORY_INVARIANTS = Object.freeze([
  Object.freeze({ id: 'USER_ID_REQUIRED', statement: 'Every Memory contract is scoped to one trusted userId.' }),
  Object.freeze({ id: 'SOURCE_REQUIRED', statement: 'Every Memory has a traceable source.' }),
  Object.freeze({ id: 'FORMAL_MEMORY_TRACEABLE', statement: 'Formal Memory retains source, time, and version.' }),
  Object.freeze({ id: 'MODEL_CANNOT_CONFIRM', statement: 'A model can propose a Candidate but cannot confirm a fact.' }),
  Object.freeze({ id: 'CANDIDATE_NOT_FORMAL', statement: 'A Candidate is not a confirmed fact.' }),
  Object.freeze({ id: 'SUPERSEDED_NOT_CURRENT', statement: 'Superseded Memory is never current.' }),
  Object.freeze({ id: 'DELETED_NOT_RECALLABLE', statement: 'Deleted Memory is never recallable.' }),
  Object.freeze({ id: 'NO_SILENT_OVERWRITE', statement: 'A changed fact creates a version link instead of overwriting history.' })
]);

export function canTransitionMemoryStatus(from, to) {
  return MemoryLifecycle.transitions[from]?.includes(to) === true;
}

export function isCurrentMemoryStatus(status) {
  return status === MemoryStatus.CONFIRMED;
}

export function isRecallableMemoryStatus(status) {
  return status === MemoryStatus.CONFIRMED;
}
