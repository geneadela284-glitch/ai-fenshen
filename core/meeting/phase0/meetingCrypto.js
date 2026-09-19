import { ownerHash } from '../../localDataSpace/ownerContext.js';

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return normalized;
}

export function buildMeetingAad({ ownerId, meetingId, entityType, schemaVersion = 1, revision = '', segmentIndex = '' } = {}) {
  return [
    ownerHash(required(ownerId, 'OWNER_REQUIRED')),
    required(meetingId, 'MEETING_ID_REQUIRED'),
    required(entityType, 'ENTITY_TYPE_REQUIRED'),
    String(schemaVersion),
    String(revision),
    String(segmentIndex)
  ].join('\u0000');
}
