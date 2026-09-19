/**
 * Runtime-neutral names for the Memory Kernel's JSDoc contracts.
 * Schemas define structure; validators define trust boundaries.
 */
export const MEMORY_KERNEL_TYPE_NAMES = Object.freeze([
  'MemoryRecord',
  'MemoryCandidate',
  'MemorySource',
  'MemoryPolicy',
  'MemoryQuery',
  'MemoryResult',
  'MemoryVersion',
  'MemoryConflict',
  'MemoryStatus',
  'MemoryConfirmation',
  'MemorySensitivity',
  'MemoryImportance',
  'MemoryLifecycle',
  'MemoryEvent',
  'MemoryRepository'
]);

/** @typedef {number} MemoryImportance */
/** @typedef {string} MemoryStatus */
/** @typedef {string} MemoryConfirmation */
/** @typedef {string} MemorySensitivity */
/** @typedef {Record<string, unknown>} MemoryRecord */
/** @typedef {Record<string, unknown>} MemoryCandidate */
/** @typedef {{type: string, id: string}} MemorySource */
/** @typedef {{retentionPolicy: object, accessPolicy: object}} MemoryPolicy */
/** @typedef {Record<string, unknown>} MemoryQuery */
/** @typedef {{ok: boolean, data: unknown, error: unknown}} MemoryResult */
/** @typedef {Record<string, unknown>} MemoryVersion */
/** @typedef {Record<string, unknown>} MemoryConflict */
/** @typedef {Record<string, unknown>} MemoryEvent */
