export const MEMORY_REPOSITORY_VERSION = 1;

const repositoryDefaults = {
  deletedAt: '',
  forgottenAt: '',
  lastAccessedAt: '',
  accessCount: 0,
  version: MEMORY_REPOSITORY_VERSION
};

function normalizeArray(value) {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function migrateMemoryRecord(record = {}) {
  const migrated = {
    ...repositoryDefaults,
    ...record,
    people: normalizeArray(record.people),
    organizations: normalizeArray(record.organizations),
    projects: normalizeArray(record.projects),
    tags: normalizeArray(record.tags),
    metadata: normalizeObject(record.metadata),
    amount: record.amount === null || record.amount === undefined || record.amount === ''
      ? null
      : Number(record.amount),
    accessCount: Number.isFinite(Number(record.accessCount)) ? Number(record.accessCount) : 0,
    version: Number.isFinite(Number(record.version)) ? Number(record.version) : MEMORY_REPOSITORY_VERSION
  };

  return {
    ...migrated,
    deletedAt: String(migrated.deletedAt || ''),
    forgottenAt: String(migrated.forgottenAt || ''),
    lastAccessedAt: String(migrated.lastAccessedAt || '')
    ,previousVersionId: String(migrated.previousVersionId || ''), supersededBy: String(migrated.supersededBy || ''), relatedMemoryIds: normalizeArray(migrated.relatedMemoryIds), sourceTrust: String(migrated.sourceTrust || 'user_stated'), confirmedByUser: Boolean(migrated.confirmedByUser), confirmationAt: String(migrated.confirmationAt || ''), changeReason: String(migrated.changeReason || ''), changedAt: String(migrated.changedAt || '')
  };
}

export function migrateMemoryRecords(records = []) {
  return Array.isArray(records) ? records.map(migrateMemoryRecord) : [];
}
