import { createDefaultRepositoryStorage } from '../../repositories/jsonStorage.js';

const ACTION_AUDIT_STORAGE_KEY = 'secretary-action-audits';
const MAX_ACTION_AUDITS = 500;

function text(value = '', max = 160) {
  return String(value || '').trim().slice(0, max);
}

function defaultIdGenerator() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `audit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeAudit(record = {}, { now = () => new Date(), idGenerator = defaultIdGenerator } = {}) {
  return {
    auditId: text(record.auditId || idGenerator(), 120),
    proposalId: text(record.proposalId, 120),
    actionName: text(record.actionName, 80),
    actionType: text(record.actionType, 80),
    occurredAt: text(record.occurredAt || now().toISOString(), 40),
    userId: text(record.userId, 160),
    resultStatus: text(record.resultStatus, 40),
    resultCode: text(record.resultCode, 120),
    sourceType: text(record.sourceType || 'unknown', 80),
    sourceId: text(record.sourceId, 160),
    durationMs: Math.max(0, Number(record.durationMs || 0))
  };
}

export class ActionAuditRepository {
  constructor({
    storage = createDefaultRepositoryStorage(),
    key = ACTION_AUDIT_STORAGE_KEY,
    now = () => new Date(),
    idGenerator = defaultIdGenerator
  } = {}) {
    this.storage = storage;
    this.key = key;
    this.now = now;
    this.idGenerator = idGenerator;
  }

  record(record = {}) {
    const next = normalizeAudit(record, { now: this.now, idGenerator: this.idGenerator });
    const records = this.listRecent(MAX_ACTION_AUDITS - 1);
    this.storage.set(this.key, [next, ...records].slice(0, MAX_ACTION_AUDITS));
    return next;
  }

  listRecent(limit = 20) {
    const stored = this.storage.get(this.key);
    if (!Array.isArray(stored)) return [];
    return stored.slice(0, Math.max(0, Number(limit || 0))).map((record) => (
      normalizeAudit(record, { now: this.now, idGenerator: this.idGenerator })
    ));
  }
}

export { ACTION_AUDIT_STORAGE_KEY };
