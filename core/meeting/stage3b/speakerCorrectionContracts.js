import { assertOwnerContext } from '../stage3a/transcriptContracts.js';
import { validateDiarizationRevision } from './diarizationContracts.js';

export const SPEAKER_CORRECTION_SCHEMA_VERSION = 1;

const OPERATIONS = new Set(['rename', 'merge', 'split', 'reassign']);
const PROHIBITED_AUDIT_KEYS = new Set(['text', 'startMs', 'endMs', 'confidence', 'audio', 'provider', 'payload']);

function codedError(code, details) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function positiveInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw codedError(code);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw codedError(code);
  return normalized;
}

function timestamp(value, code) {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) throw codedError(code);
  return new Date(value).toISOString();
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertOwnerOverride(context, ownerId) {
  if (ownerId !== undefined && String(ownerId) !== context.ownerId) throw codedError('OWNER_ID_OVERRIDE_REJECTED');
}

function speakerOrdinal(speakerId) {
  const match = /^speaker-([1-9][0-9]*)$/.exec(String(speakerId || ''));
  if (!match) throw codedError('SPEAKER_CORRECTION_SPEAKER_INVALID');
  return Number(match[1]);
}

function label(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(normalized)) throw codedError('SPEAKER_CORRECTION_LABEL_INVALID');
  return normalized;
}

function hash(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw codedError('SPEAKER_CORRECTION_BASE_HASH_INVALID');
  return value;
}

function hasProhibitedAuditValue(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => PROHIBITED_AUDIT_KEYS.has(key) || hasProhibitedAuditValue(child));
}

function hasExactKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value, keys) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

const REVISION_KEYS = ['schemaVersion', 'ownerId', 'meetingId', 'transcriptId', 'transcriptRevision', 'baseDiarizationRevisionId', 'baseDiarizationRevision', 'baseDiarizationSnapshotHash', 'correctionRevisionId', 'parentCorrectionRevisionId', 'correctionRevision', 'speakerRefs', 'assignments', 'nextSpeakerOrdinal', 'audit', 'createdAt'];
const SPEAKER_KEYS = ['speakerId', 'displayLabel', 'labelSource', 'state', 'mergedIntoSpeakerId'];
const ASSIGNMENT_KEYS = ['transcriptSegmentId', 'speakerRef'];
const AUDIT_KEYS = ['mutationRequestId', 'operation', 'actorType', 'actorOwnerId', 'changes', 'occurredAt'];

function assertBinding(value, errors) {
  for (const field of ['baseDiarizationRevisionId', 'meetingId', 'transcriptId', 'ownerId']) {
    if (!String(value?.[field] || '').trim()) errors.push(`SPEAKER_CORRECTION_${field.toUpperCase()}_REQUIRED`);
  }
  try { positiveInteger(value?.baseDiarizationRevision, 'SPEAKER_CORRECTION_BASE_REVISION_INVALID'); } catch (error) { errors.push(error.code); }
  try { positiveInteger(value?.transcriptRevision, 'SPEAKER_CORRECTION_TRANSCRIPT_REVISION_INVALID'); } catch (error) { errors.push(error.code); }
  try { hash(value?.baseDiarizationSnapshotHash); } catch (error) { errors.push(error.code); }
}

function assertSpeakerRefs(value, errors) {
  if (!Array.isArray(value)) {
    errors.push('SPEAKER_CORRECTION_SPEAKER_REFS_REQUIRED');
    return new Map();
  }
  const speakers = new Map();
  for (const speaker of value) {
    if (!hasExactKeys(speaker, SPEAKER_KEYS)) { errors.push('SPEAKER_CORRECTION_SPEAKER_SHAPE_INVALID'); continue; }
    try { speakerOrdinal(speaker?.speakerId); } catch (error) { errors.push(error.code); continue; }
    if (speakers.has(speaker.speakerId)) errors.push('SPEAKER_CORRECTION_SPEAKER_DUPLICATE');
    try { label(speaker.displayLabel); } catch (error) { errors.push(error.code); }
    if (!['provider_anonymous', 'user_entered'].includes(speaker.labelSource)) errors.push('SPEAKER_CORRECTION_LABEL_SOURCE_INVALID');
    if (speaker.labelSource === 'provider_anonymous' && speaker.displayLabel !== `说话人${speakerOrdinal(speaker.speakerId)}`) errors.push('SPEAKER_CORRECTION_LABEL_INVALID');
    if (!['active', 'merged'].includes(speaker.state)) errors.push('SPEAKER_CORRECTION_SPEAKER_STATE_INVALID');
    if (speaker.state === 'active' && speaker.mergedIntoSpeakerId !== null) errors.push('SPEAKER_CORRECTION_MERGED_TARGET_INVALID');
    speakers.set(speaker.speakerId, speaker);
  }
  for (const speaker of speakers.values()) {
    if (speaker.state !== 'merged') continue;
    const target = speakers.get(speaker.mergedIntoSpeakerId);
    if (!target || target.state !== 'active' || target.speakerId === speaker.speakerId) errors.push('SPEAKER_CORRECTION_MERGED_TARGET_INVALID');
  }
  return speakers;
}

function assertAssignments(value, speakers, errors) {
  if (!Array.isArray(value) || !value.length) {
    errors.push('SPEAKER_CORRECTION_ASSIGNMENTS_REQUIRED');
    return;
  }
  const ids = new Set();
  for (const assignment of value) {
    if (!hasExactKeys(assignment, ASSIGNMENT_KEYS)) { errors.push('SPEAKER_CORRECTION_ASSIGNMENT_SHAPE_INVALID'); continue; }
    const id = String(assignment?.transcriptSegmentId || '').trim();
    if (!id) { errors.push('SPEAKER_CORRECTION_ASSIGNMENT_INVALID'); continue; }
    if (ids.has(id)) errors.push('SPEAKER_CORRECTION_ASSIGNMENT_DUPLICATE');
    ids.add(id);
    const speakerRef = assignment?.speakerRef;
    if (speakerRef !== 'unknown' && speakers.get(speakerRef)?.state !== 'active') errors.push('SPEAKER_CORRECTION_ASSIGNMENT_SPEAKER_INVALID');
  }
}

function assertChange(change, operation, errors) {
  const invalid = () => errors.push('SPEAKER_CORRECTION_AUDIT_CHANGE_INVALID');
  if (operation === 'rename') {
    if (!hasExactKeys(change, ['speakerId', 'previousDisplayLabel', 'displayLabel'])) return invalid();
    try { speakerOrdinal(change.speakerId); label(change.previousDisplayLabel); label(change.displayLabel); if (change.previousDisplayLabel === change.displayLabel) invalid(); } catch { invalid(); }
  } else if (operation === 'merge') {
    if (!hasExactKeys(change, ['sourceSpeakerIds', 'targetSpeakerId']) || !Array.isArray(change.sourceSpeakerIds) || !change.sourceSpeakerIds.length) return invalid();
    try { change.sourceSpeakerIds.forEach(speakerOrdinal); speakerOrdinal(change.targetSpeakerId); if (new Set(change.sourceSpeakerIds).size !== change.sourceSpeakerIds.length || change.sourceSpeakerIds.includes(change.targetSpeakerId)) invalid(); } catch { invalid(); }
  } else if (operation === 'split') {
    if (!hasExactKeys(change, ['sourceSpeakerId', 'transcriptSegmentIds', 'newSpeakerId']) || !Array.isArray(change.transcriptSegmentIds) || !change.transcriptSegmentIds.length) return invalid();
    try { speakerOrdinal(change.sourceSpeakerId); speakerOrdinal(change.newSpeakerId); change.transcriptSegmentIds.forEach((id) => required(id, 'SPEAKER_CORRECTION_AUDIT_CHANGE_INVALID')); if (new Set(change.transcriptSegmentIds).size !== change.transcriptSegmentIds.length || change.sourceSpeakerId === change.newSpeakerId) invalid(); } catch { invalid(); }
  } else if (operation === 'reassign') {
    if (!hasExactKeys(change, ['transcriptSegmentIds', 'targetSpeakerId']) || !Array.isArray(change.transcriptSegmentIds) || !change.transcriptSegmentIds.length) return invalid();
    try { if (change.targetSpeakerId !== 'unknown') speakerOrdinal(change.targetSpeakerId); change.transcriptSegmentIds.forEach((id) => required(id, 'SPEAKER_CORRECTION_AUDIT_CHANGE_INVALID')); if (new Set(change.transcriptSegmentIds).size !== change.transcriptSegmentIds.length) invalid(); } catch { invalid(); }
  } else invalid();
}

function assertAudit(value, ownerId, errors, { base = false } = {}) {
  if (base && value === null) return;
  if (!hasExactKeys(value, AUDIT_KEYS)) { errors.push('SPEAKER_CORRECTION_AUDIT_INVALID'); return; }
  if (!String(value.mutationRequestId || '').trim()) errors.push('SPEAKER_CORRECTION_MUTATION_REQUEST_ID_REQUIRED');
  if (!OPERATIONS.has(value.operation)) errors.push('SPEAKER_CORRECTION_OPERATION_INVALID');
  if (value.actorType !== 'owner_user') errors.push('SPEAKER_CORRECTION_ACTOR_INVALID');
  if (value.actorOwnerId !== ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  if (!Array.isArray(value.changes) || value.changes.length !== 1 || hasProhibitedAuditValue(value.changes)) errors.push('SPEAKER_CORRECTION_AUDIT_CHANGE_INVALID');
  else assertChange(value.changes[0], value.operation, errors);
  try { timestamp(value.occurredAt, 'SPEAKER_CORRECTION_AUDIT_TIME_INVALID'); } catch (error) { errors.push(error.code); }
}

function parentMatches(value, parent, errors) {
  if (!parent || typeof parent !== 'object') { errors.push('SPEAKER_CORRECTION_PARENT_INVALID'); return; }
  if (!Array.isArray(parent.assignments) || !Array.isArray(parent.speakerRefs) || !Array.isArray(value.assignments) || !Array.isArray(value.speakerRefs)) { errors.push('SPEAKER_CORRECTION_PARENT_INVALID'); return; }
  if (value.correctionRevision !== Number(parent.correctionRevision) + 1 || value.parentCorrectionRevisionId !== (parent.correctionRevisionId ?? null) || value.correctionRevisionId === parent.correctionRevisionId) errors.push('SPEAKER_CORRECTION_PARENT_INVALID');
  for (const field of ['ownerId', 'meetingId', 'transcriptId', 'transcriptRevision', 'baseDiarizationRevisionId', 'baseDiarizationRevision', 'baseDiarizationSnapshotHash']) {
    if (value[field] !== parent[field]) errors.push('SPEAKER_CORRECTION_PARENT_INVALID');
  }
  const parentSegments = new Set(parent.assignments.map((assignment) => assignment.transcriptSegmentId));
  const childSegments = new Set(value.assignments.map((assignment) => assignment.transcriptSegmentId));
  if (parentSegments.size !== childSegments.size || [...parentSegments].some((id) => !childSegments.has(id))) errors.push('SPEAKER_CORRECTION_ASSIGNMENT_SET_INVALID');
  const parentSpeakers = new Set(parent.speakerRefs.map((speaker) => speaker.speakerId));
  const childSpeakers = new Set(value.speakerRefs.map((speaker) => speaker.speakerId));
  if ([...parentSpeakers].some((id) => !childSpeakers.has(id)) || value.nextSpeakerOrdinal < parent.nextSpeakerOrdinal) errors.push('SPEAKER_CORRECTION_PARENT_INVALID');
  const operation = value.audit?.operation;
  const additions = [...childSpeakers].filter((id) => !parentSpeakers.has(id));
  if (operation !== 'split' && (additions.length || value.nextSpeakerOrdinal !== parent.nextSpeakerOrdinal)) errors.push('SPEAKER_CORRECTION_PARENT_INVALID');
  if (operation === 'split' && (additions.length !== 1 || additions[0] !== `speaker-${parent.nextSpeakerOrdinal}` || value.nextSpeakerOrdinal !== parent.nextSpeakerOrdinal + 1)) errors.push('SPEAKER_CORRECTION_PARENT_INVALID');
  const change = value.audit?.changes?.[0];
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const assignmentMap = (revision) => new Map(revision.assignments.map((assignment) => [assignment.transcriptSegmentId, assignment.speakerRef]));
  const parentAssignments = assignmentMap(parent);
  const childAssignments = assignmentMap(value);
  const parentProfiles = new Map(parent.speakerRefs.map((speaker) => [speaker.speakerId, speaker]));
  const childProfiles = new Map(value.speakerRefs.map((speaker) => [speaker.speakerId, speaker]));
  if (operation === 'rename' && change) {
    const before = parentProfiles.get(change.speakerId);
    const after = childProfiles.get(change.speakerId);
    const expected = before && { ...before, displayLabel: change.displayLabel, labelSource: 'user_entered' };
    if (!before || before.state !== 'active' || !after || before.displayLabel !== change.previousDisplayLabel || !same(after, expected)
      || [...parentAssignments].some(([id, speakerRef]) => childAssignments.get(id) !== speakerRef)
      || [...parentProfiles].some(([id, speaker]) => id !== change.speakerId && !same(speaker, childProfiles.get(id)))) errors.push('SPEAKER_CORRECTION_AUDIT_DELTA_INVALID');
  }
  if (operation === 'reassign' && change) {
    const changedIds = new Set([...parentAssignments].filter(([id, speakerRef]) => childAssignments.get(id) !== speakerRef).map(([id]) => id));
    if (!same(parent.speakerRefs, value.speakerRefs) || changedIds.size !== change.transcriptSegmentIds.length
      || change.transcriptSegmentIds.some((id) => !changedIds.has(id) || childAssignments.get(id) !== change.targetSpeakerId)) errors.push('SPEAKER_CORRECTION_AUDIT_DELTA_INVALID');
  }
  if (operation === 'split' && change) {
    const changedIds = new Set([...parentAssignments].filter(([id, speakerRef]) => childAssignments.get(id) !== speakerRef).map(([id]) => id));
    const expectedNew = { speakerId: `speaker-${parent.nextSpeakerOrdinal}`, displayLabel: `说话人${parent.nextSpeakerOrdinal}`, labelSource: 'provider_anonymous', state: 'active', mergedIntoSpeakerId: null };
    if (change.newSpeakerId !== additions[0] || change.newSpeakerId !== expectedNew.speakerId || !same(childProfiles.get(change.newSpeakerId), expectedNew)
      || [...parentProfiles].some(([id, speaker]) => !same(speaker, childProfiles.get(id)))
      || changedIds.size !== change.transcriptSegmentIds.length || change.transcriptSegmentIds.some((id) => !changedIds.has(id)
        || parentAssignments.get(id) !== change.sourceSpeakerId || childAssignments.get(id) !== change.newSpeakerId)
      || ![...parentAssignments].some(([id, speakerRef]) => speakerRef === change.sourceSpeakerId && !changedIds.has(id))) errors.push('SPEAKER_CORRECTION_AUDIT_DELTA_INVALID');
  }
  if (operation === 'merge' && change) {
    const sources = new Set(change.sourceSpeakerIds);
    if (sources.has(change.targetSpeakerId) || !sources.size || sources.size !== change.sourceSpeakerIds.length
      || parentProfiles.get(change.targetSpeakerId)?.state !== 'active'
      || [...sources].some((id) => parentProfiles.get(id)?.state !== 'active' || !same(childProfiles.get(id), { ...parentProfiles.get(id), state: 'merged', mergedIntoSpeakerId: change.targetSpeakerId }))
      || [...parentAssignments].some(([id, speakerRef]) => sources.has(speakerRef) ? childAssignments.get(id) !== change.targetSpeakerId : childAssignments.get(id) !== speakerRef)
      || [...parentProfiles].some(([id, speaker]) => !sources.has(id) && !same(speaker, childProfiles.get(id)))) errors.push('SPEAKER_CORRECTION_AUDIT_DELTA_INVALID');
  }
}

export function validateSpeakerCorrectionRevision(value, { ownerContext: inputOwnerContext, parent } = {}) {
  const errors = [];
  let ownerContext;
  try { ownerContext = assertOwnerContext(inputOwnerContext); } catch (error) { errors.push(error.code); }
  if (!value || typeof value !== 'object') return { valid: false, errors: ['SPEAKER_CORRECTION_REVISION_INVALID'] };
  if (!hasExactKeys(value, REVISION_KEYS)) errors.push('SPEAKER_CORRECTION_REVISION_SHAPE_INVALID');
  if (value.schemaVersion !== SPEAKER_CORRECTION_SCHEMA_VERSION) errors.push('SPEAKER_CORRECTION_SCHEMA_VERSION_INVALID');
  assertBinding(value, errors);
  if (ownerContext && value.ownerId !== ownerContext.ownerId) errors.push('OWNER_SCOPE_MISMATCH');
  try { nonNegativeInteger(value.correctionRevision, 'SPEAKER_CORRECTION_REVISION_INVALID'); } catch (error) { errors.push(error.code); }
  const isBase = value.correctionRevision === 0;
  if (isBase ? value.correctionRevisionId !== null || value.parentCorrectionRevisionId !== null : !String(value.correctionRevisionId || '').trim()) errors.push('SPEAKER_CORRECTION_REVISION_ID_INVALID');
  if (value.correctionRevision === 1 && value.parentCorrectionRevisionId !== null) errors.push('SPEAKER_CORRECTION_PARENT_INVALID');
  if (Number(value.correctionRevision) >= 2 && !String(value.parentCorrectionRevisionId || '').trim()) errors.push('SPEAKER_CORRECTION_PARENT_INVALID');
  try { timestamp(value.createdAt, 'SPEAKER_CORRECTION_CREATED_AT_INVALID'); } catch (error) { errors.push(error.code); }
  const speakers = assertSpeakerRefs(value.speakerRefs, errors);
  assertAssignments(value.assignments, speakers, errors);
  try {
    const ordinal = positiveInteger(value.nextSpeakerOrdinal, 'SPEAKER_CORRECTION_NEXT_ORDINAL_INVALID');
    if ([...speakers.keys()].some((id) => speakerOrdinal(id) >= ordinal)) errors.push('SPEAKER_CORRECTION_NEXT_ORDINAL_REUSED');
  } catch (error) { errors.push(error.code); }
  assertAudit(value.audit, value.ownerId, errors, { base: isBase });
  if (isBase && value.audit !== null) errors.push('SPEAKER_CORRECTION_BASE_AUDIT_INVALID');
  if (isBase && [...speakers.values()].some((speaker) => speaker.labelSource !== 'provider_anonymous' || speaker.displayLabel !== `说话人${speakerOrdinal(speaker.speakerId)}` || speaker.state !== 'active' || speaker.mergedIntoSpeakerId !== null)) errors.push('SPEAKER_CORRECTION_BASE_PROFILE_INVALID');
  const childSelfValid = errors.length === 0;
  if (parent !== undefined) {
    const parentCheck = validateSpeakerCorrectionRevision(parent, { ownerContext });
    if (!parentCheck.valid) errors.push('SPEAKER_CORRECTION_PARENT_INVALID');
    else if (childSelfValid) parentMatches(value, parent, errors);
  }
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function createBaseSpeakerCorrectionSnapshot({ ownerContext: inputOwnerContext, ownerId, diarizationRevision, baseDiarizationSnapshotHash, now } = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  assertOwnerOverride(ownerContext, ownerId);
  if (!diarizationRevision || diarizationRevision.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  const diarizationCheck = validateDiarizationRevision(diarizationRevision, { ownerContext });
  const allUnknown = Array.isArray(diarizationRevision.speakerRefs) && diarizationRevision.speakerRefs.length === 0
    && Array.isArray(diarizationRevision.segments) && diarizationRevision.segments.length > 0 && diarizationRevision.segments.every((segment) => segment.speakerRef === 'unknown');
  const diarizationErrors = diarizationCheck.errors.filter((code) => !(allUnknown && code === 'DIARIZATION_SPEAKER_REFS_REQUIRED'));
  if (diarizationErrors.length) throw codedError(diarizationErrors[0], diarizationErrors);
  const speakerRefs = diarizationRevision.speakerRefs.map((speaker) => ({ speakerId: speaker.speakerId, displayLabel: label(speaker.label), labelSource: 'provider_anonymous', state: 'active', mergedIntoSpeakerId: null }));
  const assignments = diarizationRevision.segments.map((segment) => ({ transcriptSegmentId: required(segment.transcriptSegmentId, 'SPEAKER_CORRECTION_ASSIGNMENT_INVALID'), speakerRef: segment.speakerRef }));
  const value = {
    schemaVersion: SPEAKER_CORRECTION_SCHEMA_VERSION,
    ownerId: ownerContext.ownerId,
    meetingId: diarizationRevision.meetingId,
    transcriptId: diarizationRevision.transcriptId,
    transcriptRevision: diarizationRevision.transcriptRevision,
    baseDiarizationRevisionId: diarizationRevision.diarizationRevisionId,
    baseDiarizationRevision: diarizationRevision.revision,
    baseDiarizationSnapshotHash: hash(baseDiarizationSnapshotHash),
    correctionRevisionId: null,
    parentCorrectionRevisionId: null,
    correctionRevision: 0,
    speakerRefs,
    assignments,
    nextSpeakerOrdinal: speakerRefs.length ? Math.max(...speakerRefs.map((speaker) => speakerOrdinal(speaker.speakerId))) + 1 : 1,
    audit: null,
    createdAt: timestamp(now || new Date().toISOString(), 'SPEAKER_CORRECTION_CREATED_AT_INVALID')
  };
  const check = validateSpeakerCorrectionRevision(value, { ownerContext });
  if (!check.valid) throw codedError(check.errors[0], check.errors);
  return deepFreeze(clone(value));
}

export function createSpeakerCorrectionRevision({ ownerContext: inputOwnerContext, ownerId, parent, correctionRevisionId, speakerRefs, assignments, nextSpeakerOrdinal, audit, createdAt } = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  assertOwnerOverride(ownerContext, ownerId);
  if (!parent || parent.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  if (!Number.isSafeInteger(parent.correctionRevision) || parent.correctionRevision < 0) throw codedError('SPEAKER_CORRECTION_PARENT_INVALID');
  const parentCheck = validateSpeakerCorrectionRevision(parent, { ownerContext });
  if (!parentCheck.valid) throw codedError('SPEAKER_CORRECTION_PARENT_INVALID', parentCheck.errors);
  const value = {
    schemaVersion: SPEAKER_CORRECTION_SCHEMA_VERSION,
    ownerId: ownerContext.ownerId,
    meetingId: parent.meetingId,
    transcriptId: parent.transcriptId,
    transcriptRevision: parent.transcriptRevision,
    baseDiarizationRevisionId: parent.baseDiarizationRevisionId,
    baseDiarizationRevision: parent.baseDiarizationRevision,
    baseDiarizationSnapshotHash: parent.baseDiarizationSnapshotHash,
    correctionRevisionId: required(correctionRevisionId, 'SPEAKER_CORRECTION_REVISION_ID_INVALID'),
    parentCorrectionRevisionId: parent.correctionRevisionId ?? null,
    correctionRevision: parent.correctionRevision + 1,
    speakerRefs: clone(speakerRefs),
    assignments: clone(assignments),
    nextSpeakerOrdinal,
    audit: clone(audit),
    createdAt: timestamp(createdAt, 'SPEAKER_CORRECTION_CREATED_AT_INVALID')
  };
  const check = validateSpeakerCorrectionRevision(value, { ownerContext, parent });
  if (!check.valid) throw codedError(check.errors[0], check.errors);
  return deepFreeze(value);
}
