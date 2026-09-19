const REASON_ORDER = Object.freeze([
  'confirmed_v2',
  'deleted_tombstone',
  'purged_marker',
  'superseded_chain',
  'explicit_v2_presence',
  'unresolved_conflict'
]);

function hasReason(record, reason) {
  if (reason === 'confirmed_v2') return record.status === 'confirmed';
  if (reason === 'deleted_tombstone') return record.status === 'deleted';
  if (reason === 'purged_marker') {
    return record.metadata?.purgedMarker === true || record.metadata?.v2PresenceMarker === 'purged';
  }
  if (reason === 'superseded_chain') {
    return record.status === 'superseded' || Boolean(record.supersedesId) || Boolean(record.supersededById);
  }
  if (reason === 'explicit_v2_presence') return record.metadata?.v2PresenceMarker === true;
  if (reason === 'unresolved_conflict') {
    return Boolean(record.conflictGroupId) || record.metadata?.unresolvedConflictMarker === true;
  }
  return false;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export const V2_PRESENCE_REASONS = REASON_ORDER;

export function classifyV2Presence(records, query) {
  const reasons = REASON_ORDER.filter((reason) => records.some((record) => hasReason(record, reason)));
  return deepFreeze({
    ownerUserId: query.ownerUserId,
    subjectEntityId: query.subjectEntityId,
    predicate: query.predicate,
    suppressLegacy: reasons.length > 0,
    reasons,
    memoryIds: records.map((record) => record.memoryId).sort()
  });
}
