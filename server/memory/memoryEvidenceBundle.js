import crypto from 'node:crypto';

import { canonicalizeMemoryValue } from './canonicalMemoryValueAdapter.js';

function evidenceId(record) {
  return `evidence_${crypto.createHash('sha256').update(`${record.memoryId}:${record.version}`).digest('hex').slice(0, 24)}`;
}

function qualifiers(value) {
  const birthday = value?.kind === 'calendar_date' ? value : null;
  return Object.freeze({
    calendar_type: birthday?.calendar_type || 'unknown',
    year: birthday?.date?.year ?? null,
    month: birthday?.date?.month ?? null,
    day: birthday?.date?.day ?? null,
    lunar_leap_month: birthday?.lunar_leap_month ?? 'unknown',
    recurrence: birthday?.recurrence || 'unknown'
  });
}

export function buildMemoryEvidenceBundle({ ownerId, records = [] } = {}) {
  const owner = String(ownerId || '').trim();
  if (!owner) throw new Error('OWNER_SCOPE_REQUIRED');
  const evidence = records.flatMap((record) => {
    if (record.ownerUserId !== owner) throw new Error('OWNER_SCOPE_MISMATCH');
    if (record.status !== 'confirmed' || record.supersededById) throw new Error('EVIDENCE_NOT_CURRENT');
    const canonical = canonicalizeMemoryValue(record);
    if (!canonical.ok) return [];
    return [Object.freeze({
      evidence_id: evidenceId(record),
      source_type: record.source?.type || 'memory_database',
      owner_id: owner,
      entity_id: record.subjectEntityId,
      predicate: record.predicate,
      value: Object.freeze(structuredClone(canonical.value)),
      qualifiers: qualifiers(canonical.value),
      confidence: record.confidence,
      source_message_id: record.metadata?.sourceMessageId || record.source?.id || null,
      version: record.version,
      status: record.status
    })];
  });
  return Object.freeze({ source: 'memory_database', owner_id: owner, evidence: Object.freeze(evidence) });
}

export function providerEvidenceView(bundle) {
  return Object.freeze({
    source: bundle.source,
    evidence: Object.freeze(bundle.evidence.map(({ owner_id: ignored, ...item }) => Object.freeze(item)))
  });
}
