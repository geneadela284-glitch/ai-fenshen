import { createHash } from 'node:crypto';

import {
  MEMORY_TYPES,
  MemoryConfirmation,
  MemorySensitivity,
  MemorySourceType,
  MemoryStatus,
  findForbiddenSecretPaths,
  validateMemoryRecord
} from '../kernel/index.js';
import {
  MigrationCandidateStatus,
  MigrationError,
  createMigrationCandidate,
  createMigrationSource,
  deepFreezeMigration,
  validateMigrationContext
} from './contracts.js';

const ITEM_FIELDS = Object.freeze([
  'sourceRecordId', 'userId', 'memoryType', 'subject', 'predicate', 'value', 'normalizedValue',
  'occurredAt', 'confidence', 'importance', 'tags', 'metadata'
]);

function string(value) { return typeof value === 'string' && value.trim().length > 0; }
function object(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function validUnit(value) { return Number.isFinite(value) && value >= 0 && value <= 1; }

function itemError(item, trustedUserId) {
  if (!object(item)) return 'MIGRATION_ITEM_INVALID';
  if (Object.keys(item).some((field) => !ITEM_FIELDS.includes(field))) return 'UNKNOWN_FIELD';
  if (!string(item.sourceRecordId) || !string(item.userId) || !string(item.subject) || !string(item.predicate)) return 'MIGRATION_ITEM_INVALID';
  if (item.userId !== trustedUserId) return 'USER_SCOPE_MISMATCH';
  if (!MEMORY_TYPES.includes(item.memoryType)) return 'INVALID_ENUM';
  if (!string(item.occurredAt) || Number.isNaN(Date.parse(item.occurredAt))) return 'INVALID_DATE';
  if (!validUnit(item.confidence) || !validUnit(item.importance)) return 'INVALID_NUMBER';
  if (!Array.isArray(item.tags) || item.tags.some((tag) => !string(tag))) return 'INVALID_TYPE';
  if (!object(item.metadata)) return 'INVALID_TYPE';
  if (findForbiddenSecretPaths(item.metadata).length) return 'SECRET_FORBIDDEN';
  return null;
}

function excluded(item, reasonCode) {
  return Object.freeze({ sourceRecordId: string(item?.sourceRecordId) ? item.sourceRecordId : null, reasonCode });
}

export class MigrationScanner {
  constructor({ clock = () => new Date(), idFactory = () => crypto.randomUUID(), maxItems = 1000 } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.maxItems = maxItems;
  }

  _now() {
    const value = this.clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  async scan(context, inputSource) {
    const contextValidation = validateMigrationContext(context);
    if (!contextValidation.valid) throw new MigrationError(contextValidation.errors[0].code);
    const source = createMigrationSource(inputSource, { trustedUserId: context.authenticatedUserId });
    let items;
    try { items = await source.scan(context); } catch { throw new MigrationError('MIGRATION_SOURCE_SCAN_FAILED'); }
    if (!Array.isArray(items)) throw new MigrationError('MIGRATION_SOURCE_SCAN_FAILED');
    if (items.length > this.maxItems) throw new MigrationError('MIGRATION_SCAN_LIMIT_EXCEEDED');

    const candidates = [];
    const skipped = [];
    const sourceIds = new Set();
    for (const item of items) {
      const errorCode = itemError(item, context.authenticatedUserId);
      if (errorCode) { skipped.push(excluded(item, errorCode)); continue; }
      if (sourceIds.has(item.sourceRecordId)) { skipped.push(excluded(item, 'MIGRATION_SOURCE_DUPLICATE_ID')); continue; }
      sourceIds.add(item.sourceRecordId);
      const now = this._now();
      const proposedMemory = {
        id: `migration-memory-${this.idFactory()}`, schemaVersion: 'v1', userId: context.authenticatedUserId,
        memoryType: item.memoryType, subject: item.subject, predicate: item.predicate,
        value: structuredClone(item.value), normalizedValue: structuredClone(item.normalizedValue),
        source: { type: MemorySourceType.IMPORTED, id: `${source.id}:${item.sourceRecordId}` },
        sourceTimestamp: item.occurredAt, createdAt: now, updatedAt: now,
        effectiveFrom: item.occurredAt, effectiveTo: null, confidence: item.confidence,
        importance: item.importance, sensitivity: MemorySensitivity.LOW,
        status: MemoryStatus.PENDING_CONFIRMATION, confirmationStatus: MemoryConfirmation.PENDING,
        expiresAt: null, version: 1, supersedesId: null, supersededById: null, conflictGroupId: null,
        retentionPolicy: { mode: 'migration_review' }, accessPolicy: { scope: 'private', allowRecall: false },
        checksum: null, tags: [...item.tags], metadata: {
          migration: { sourceId: source.id, sourceKind: source.kind, sourceRecordId: item.sourceRecordId }
        }
      };
      proposedMemory.checksum = hash(proposedMemory);
      const validation = validateMemoryRecord(proposedMemory, { trustedUserId: context.authenticatedUserId });
      if (!validation.valid) { skipped.push(excluded(item, validation.errors[0].code)); continue; }
      candidates.push(createMigrationCandidate({
        id: `migration-candidate-${this.idFactory()}`, userId: context.authenticatedUserId,
        sourceId: source.id, sourceKind: source.kind, sourceRecordId: item.sourceRecordId,
        proposedMemory, status: MigrationCandidateStatus.READY_FOR_APPROVAL,
        duplicateReport: { isDuplicate: false, matches: [], reasonCode: null },
        conflictReport: { hasConflict: false, matches: [], reasonCode: null, resolution: null },
        sensitiveReport: { sensitivity: MemorySensitivity.LOW, prohibited: false, requiresExplicitApproval: false, categories: [], reasonCode: null },
        createdAt: now, metadata: {}
      }));
    }
    return deepFreezeMigration({
      sourceId: source.id, sourceKind: source.kind, userId: context.authenticatedUserId,
      scannedAt: this._now(), candidates, excluded: skipped,
      counts: { scanned: items.length, candidates: candidates.length, excluded: skipped.length }
    });
  }
}
