import { createMemoryRecord, validateMemoryRecord } from '../memorySchema.js';
import {
  memoryRetentionPolicies,
  memorySensitivityLevels,
  memorySourceTypes,
  memoryStatuses
} from '../memoryTypes.js';
import { applyMemoryQuery } from './memoryQuery.js';
import { MEMORY_REPOSITORY_VERSION, migrateMemoryRecord } from './memoryMigration.js';
import { DEFAULT_MEMORY_STORAGE_NAMESPACE, MemoryStorageAdapter } from './memoryStorageAdapter.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function error(code, message, details = []) {
  return { ok: false, error: { code, message, details } };
}

function normalizeIso(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function validateDateTime(record) {
  const errors = [];
  ['eventDate'].forEach((field) => {
    if (record[field] && !DATE_RE.test(record[field])) errors.push(`${field}_invalid`);
  });
  ['eventTime'].forEach((field) => {
    if (record[field] && !TIME_RE.test(record[field])) errors.push(`${field}_invalid`);
  });
  ['startAt', 'endAt', 'createdAt', 'updatedAt', 'deletedAt', 'forgottenAt', 'lastAccessedAt'].forEach((field) => {
    if (record[field] && !normalizeIso(record[field])) errors.push(`${field}_invalid`);
  });
  return errors;
}

function buildFingerprint(record) {
  return [
    record.memoryType,
    record.normalizedText,
    record.eventDate,
    record.amount === null ? '' : record.amount
  ].map((item) => String(item ?? '').trim().toLowerCase()).join('|');
}

function isSameSubmission(left = {}, right = {}) {
  const leftSourceId = String(left.sourceId || '');
  const rightSourceId = String(right.sourceId || '');
  if (leftSourceId && rightSourceId && leftSourceId === rightSourceId) return true;
  const leftSubmissionId = String(left.metadata?.submissionId || '');
  const rightSubmissionId = String(right.metadata?.submissionId || '');
  if (leftSubmissionId && rightSubmissionId && leftSubmissionId === rightSubmissionId) return true;
  if (!leftSourceId && !rightSourceId && !leftSubmissionId && !rightSubmissionId) {
    return buildFingerprint(left) === buildFingerprint(right);
  }
  return false;
}

function isTestNamespace(namespace) {
  return namespace.startsWith('test-') || namespace.includes('.test.');
}

function sanitizeForgotten(record, timestamp) {
  return {
    ...record,
    status: 'forgotten',
    originalText: '',
    normalizedText: '',
    title: '',
    summary: '',
    people: [],
    organizations: [],
    projects: [],
    amount: null,
    currency: '',
    direction: 'neutral',
    eventDate: '',
    eventTime: '',
    startAt: '',
    endAt: '',
    location: '',
    tags: [],
    needsConfirmation: false,
    deletedAt: '',
    forgottenAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      sourceType: record.sourceType,
      sourceId: record.sourceId,
      previousStatus: record.status,
      forgotten: true
    }
  };
}

export class MemoryRepository {
  constructor({
    storage,
    namespace = DEFAULT_MEMORY_STORAGE_NAMESPACE,
    adapter,
    now = () => new Date()
  } = {}) {
    this.adapter = adapter || new MemoryStorageAdapter({ storage, namespace });
    this.namespace = namespace;
    this.now = now;
    this.lastTimestamp = 0;
  }

  timestamp() {
    const raw = this.now();
    const date = raw instanceof Date ? raw : new Date(raw);
    const next = Number.isNaN(date.getTime()) ? Date.now() : date.getTime();
    this.lastTimestamp = Math.max(next, this.lastTimestamp + 1);
    return new Date(this.lastTimestamp).toISOString();
  }

  read() {
    return this.adapter.readAll().map(migrateMemoryRecord);
  }

  write(records) {
    return this.adapter.writeAll(records);
  }

  validateForSave(record, options = {}) {
    const schema = validateMemoryRecord(record);
    const errors = [...schema.errors, ...validateDateTime(record)];
    if (!schema.valid) return error('MEMORY_VALIDATION_FAILED', 'MemoryRecord schema is invalid', errors);
    if (!record.originalText && !record.sourceId) errors.push('original_text_or_source_required');
    if (!memoryStatuses.includes(record.status)) errors.push('status_invalid');
    if (record.amount !== null && typeof record.amount !== 'number') errors.push('amount_invalid');
    if (!memorySensitivityLevels.includes(record.sensitivity)) errors.push('sensitivity_invalid');
    if (!memoryRetentionPolicies.includes(record.retentionPolicy)) errors.push('retention_policy_invalid');
    if (!memorySourceTypes.includes(record.sourceType)) errors.push('source_type_invalid');
    if (record.sensitivity === 'high' && (record.needsConfirmation || !options.confirmedByUser)) {
      return error('MEMORY_CONFIRMATION_REQUIRED', 'High sensitivity memory requires explicit user confirmation');
    }
    if (errors.length) return error('MEMORY_VALIDATION_FAILED', 'MemoryRecord schema is invalid', errors);
    return { ok: true };
  }

  create(memoryRecord, options = {}) {
    try {
      const now = this.timestamp();
      const base = createMemoryRecord(memoryRecord, { sourceType: memoryRecord?.sourceType });
      const record = migrateMemoryRecord({
        ...base,
        ...memoryRecord,
        amount: memoryRecord?.amount === null || memoryRecord?.amount === undefined ? base.amount : Number(memoryRecord.amount),
        createdAt: memoryRecord?.createdAt || now,
        updatedAt: memoryRecord?.updatedAt || now,
        deletedAt: '',
        forgottenAt: '',
        lastAccessedAt: '',
        accessCount: 0,
        version: MEMORY_REPOSITORY_VERSION
      });
      const validation = this.validateForSave(record, options);
      if (!validation.ok) return validation;
      const records = this.read();
      const duplicate = options.allowVersionCreate && record.previousVersionId
        ? null
        : records.find((item) => (
          item.status !== 'deleted' &&
          item.status !== 'forgotten' &&
          isSameSubmission(item, record)
        ));
      if (duplicate) {
        return {
          ok: false,
          duplicate: true,
          existingId: duplicate.id,
          recommendation: 'skip'
        };
      }
      this.write([...records, record]);
      return { ok: true, record: clone(record) };
    } catch (err) {
      return error('MEMORY_CREATE_FAILED', 'Memory create failed', [err.message]);
    }
  }

  getById(id, options = {}) {
    const records = this.read();
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const record = records[index];
    if (record.status === 'deleted' && !options.includeDeleted) return null;
    if (record.status === 'forgotten' && !options.includeForgotten) return null;
    const touched = this.touch(record);
    records[index] = touched;
    this.write(records);
    return clone(touched);
  }

  list(query = {}) {
    return applyMemoryQuery(this.read(), query).map(clone);
  }

  search(query = {}) {
    const records = this.read();
    const matches = applyMemoryQuery(records, query);
    const ids = new Set(matches.map((item) => item.id));
    const touched = records.map((item) => ids.has(item.id) ? this.touch(item) : item);
    this.write(touched);
    return applyMemoryQuery(touched, query).map(clone);
  }

  update(id, changes = {}) {
    const records = this.read();
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) return error('MEMORY_NOT_FOUND', 'Memory record was not found');
    const current = records[index];
    if (current.status === 'forgotten') return error('MEMORY_FORGOTTEN', 'Forgotten memory cannot be updated');
    if (['deleted', 'forgotten'].includes(changes.status) || (current.status === 'deleted' && changes.status === 'confirmed')) {
      return error('MEMORY_RESTORE_REQUIRED', 'Use restore() to reactivate deleted memory');
    }
    const updated = migrateMemoryRecord({
      ...current,
      ...changes,
      id: current.id,
      createdAt: current.createdAt,
      sourceType: current.sourceType,
      sourceId: current.sourceId,
      originalText: changes.originalText ?? current.originalText,
      amount: changes.amount === undefined ? current.amount : Number(changes.amount),
      metadata: {
        ...current.metadata,
        ...(changes.metadata && typeof changes.metadata === 'object' ? changes.metadata : {})
      },
      updatedAt: this.timestamp()
    });
    const validation = this.validateForSave(updated, changes.confirmedByUser ? { confirmedByUser: true } : {});
    if (!validation.ok) return validation;
    records[index] = updated;
    this.write(records);
    return { ok: true, record: clone(updated) };
  }

  remove(id) {
    const records = this.read();
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) return error('MEMORY_NOT_FOUND', 'Memory record was not found');
    const timestamp = this.timestamp();
    records[index] = migrateMemoryRecord({
      ...records[index],
      status: 'deleted',
      deletedAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        ...records[index].metadata,
        previousStatus: records[index].status
      }
    });
    this.write(records);
    return { ok: true, record: clone(records[index]) };
  }

  forget(id) {
    const records = this.read();
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) return error('MEMORY_NOT_FOUND', 'Memory record was not found');
    records[index] = sanitizeForgotten(records[index], this.timestamp());
    this.write(records);
    return { ok: true, record: clone(records[index]) };
  }

  restore(id) {
    const records = this.read();
    const index = records.findIndex((item) => item.id === id);
    if (index < 0) return error('MEMORY_NOT_FOUND', 'Memory record was not found');
    const record = records[index];
    if (record.status === 'forgotten') return error('MEMORY_FORGOTTEN', 'Forgotten memory cannot be restored');
    if (record.status !== 'deleted') return { ok: true, record: clone(record) };
    const restored = migrateMemoryRecord({
      ...record,
      status: record.metadata.previousStatus && record.metadata.previousStatus !== 'deleted'
        ? record.metadata.previousStatus
        : 'confirmed',
      deletedAt: '',
      updatedAt: this.timestamp()
    });
    records[index] = restored;
    this.write(records);
    return { ok: true, record: clone(restored) };
  }

  count(query = {}) {
    return this.list(query).length;
  }

  exists(id) {
    return Boolean(this.read().find((item) => item.id === id && item.status !== 'forgotten'));
  }

  clearTestDataOnly() {
    if (!isTestNamespace(this.namespace)) {
      return error('MEMORY_TEST_NAMESPACE_REQUIRED', 'clearTestDataOnly only works on test namespaces');
    }
    this.adapter.clearNamespace();
    return { ok: true };
  }

  exportAll(options = {}) {
    const records = this.list({
      includeDeleted: Boolean(options.includeDeleted),
      includeForgotten: Boolean(options.includeForgotten)
    }).filter((record) => record.status !== 'forgotten' || options.includeForgotten);
    return {
      version: MEMORY_REPOSITORY_VERSION,
      exportedAt: this.timestamp(),
      records: records.map((record) => (
        record.sensitivity === 'high' && !options.includeSensitive
          ? { ...record, originalText: '', normalizedText: '', summary: '' }
          : clone(record)
      ))
    };
  }

  importAll(data, options = {}) {
    const incoming = Array.isArray(data?.records) ? data.records.map(migrateMemoryRecord) : null;
    if (!incoming) return error('MEMORY_IMPORT_INVALID', 'Import payload must contain records');
    const validationErrors = incoming.flatMap((record) => {
      const validation = this.validateForSave(record, record.sensitivity === 'high' ? { confirmedByUser: options.confirmSensitive } : {});
      return validation.ok ? [] : [{ id: record.id, error: validation.error }];
    });
    if (validationErrors.length) {
      return error('MEMORY_IMPORT_VALIDATION_FAILED', 'Import payload contains invalid records', validationErrors);
    }
    const current = this.read();
    const byId = new Map(current.map((record) => [record.id, record]));
    const next = [...current];
    incoming.forEach((record) => {
      if (byId.has(record.id)) {
        if (options.overwrite) {
          const index = next.findIndex((item) => item.id === record.id);
          next[index] = record;
        }
      } else {
        next.push(record);
      }
    });
    this.write(next);
    return { ok: true, imported: next.length - current.length };
  }

  touch(record) {
    return migrateMemoryRecord({
      ...record,
      accessCount: Number(record.accessCount || 0) + 1,
      lastAccessedAt: this.timestamp()
    });
  }
}
