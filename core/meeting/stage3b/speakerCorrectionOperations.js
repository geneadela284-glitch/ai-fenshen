import { assertOwnerContext } from '../stage3a/transcriptContracts.js';
import { createSpeakerCorrectionRevision, validateSpeakerCorrectionRevision } from './speakerCorrectionContracts.js';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function assertCurrent(currentRevision, ownerContext) {
  if (!currentRevision || currentRevision.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  const check = validateSpeakerCorrectionRevision(currentRevision, { ownerContext });
  if (!check.valid) throw codedError(check.errors[0]);
}

function activeSpeaker(revision, speakerId) {
  if (speakerId === 'unknown') throw codedError('SPEAKER_CORRECTION_SPEAKER_INVALID');
  const speaker = revision.speakerRefs.find((candidate) => candidate.speakerId === speakerId && candidate.state === 'active');
  if (!speaker) throw codedError('SPEAKER_CORRECTION_SPEAKER_INVALID');
  return speaker;
}

function segmentIds(value) {
  if (!Array.isArray(value) || !value.length) throw codedError('SPEAKER_CORRECTION_SEGMENT_SET_INVALID');
  const ids = value.map((id) => required(id, 'SPEAKER_CORRECTION_SEGMENT_SET_INVALID'));
  if (new Set(ids).size !== ids.length) throw codedError('SPEAKER_CORRECTION_SEGMENT_SET_INVALID');
  return ids;
}

function next({ ownerContext, currentRevision, correctionRevisionId, mutationRequestId, operation, changes, speakerRefs, assignments, nextSpeakerOrdinal, now }) {
  const occurredAt = now || new Date().toISOString();
  return createSpeakerCorrectionRevision({
    ownerContext,
    parent: currentRevision,
    correctionRevisionId,
    speakerRefs,
    assignments,
    nextSpeakerOrdinal,
    audit: { mutationRequestId: required(mutationRequestId, 'SPEAKER_CORRECTION_MUTATION_REQUEST_ID_REQUIRED'), operation, actorType: 'owner_user', actorOwnerId: ownerContext.ownerId, changes, occurredAt },
    createdAt: occurredAt
  });
}

export function applySpeakerCorrection({ ownerContext: inputOwnerContext, ownerId, currentRevision, correctionRevisionId, mutationRequestId, operation, speakerId, speakerIds, targetSpeakerId, transcriptSegmentIds, displayLabel, now } = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  if (ownerId !== undefined && String(ownerId) !== ownerContext.ownerId) throw codedError('OWNER_ID_OVERRIDE_REJECTED');
  assertCurrent(currentRevision, ownerContext);
  const speakerRefs = clone(currentRevision.speakerRefs);
  const assignments = clone(currentRevision.assignments);
  const label = displayLabel === undefined ? undefined : String(displayLabel).trim();

  if (operation === 'rename') {
    const speaker = activeSpeaker(currentRevision, speakerId);
    if (!label || label.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(label)) throw codedError('SPEAKER_CORRECTION_LABEL_INVALID');
    if (speaker.displayLabel === label) throw codedError('SPEAKER_CORRECTION_NO_CHANGE');
    speakerRefs.find((candidate) => candidate.speakerId === speaker.speakerId).displayLabel = label;
    speakerRefs.find((candidate) => candidate.speakerId === speaker.speakerId).labelSource = 'user_entered';
    return next({ ownerContext, currentRevision, correctionRevisionId, mutationRequestId, operation, changes: [{ speakerId: speaker.speakerId, previousDisplayLabel: speaker.displayLabel, displayLabel: label }], speakerRefs, assignments, nextSpeakerOrdinal: currentRevision.nextSpeakerOrdinal, now });
  }

  if (operation === 'merge') {
    if (!Array.isArray(speakerIds) || new Set(speakerIds).size < 2 || new Set(speakerIds).size !== speakerIds.length) throw codedError('SPEAKER_CORRECTION_MERGE_SET_INVALID');
    const sourceIds = new Set(speakerIds);
    for (const id of sourceIds) activeSpeaker(currentRevision, id);
    if (!sourceIds.has(targetSpeakerId)) throw codedError('SPEAKER_CORRECTION_MERGE_SET_INVALID');
    activeSpeaker(currentRevision, targetSpeakerId);
    for (const assignment of assignments) if (sourceIds.has(assignment.speakerRef)) assignment.speakerRef = targetSpeakerId;
    for (const speaker of speakerRefs) if (sourceIds.has(speaker.speakerId) && speaker.speakerId !== targetSpeakerId) { speaker.state = 'merged'; speaker.mergedIntoSpeakerId = targetSpeakerId; }
    return next({ ownerContext, currentRevision, correctionRevisionId, mutationRequestId, operation, changes: [{ sourceSpeakerIds: [...sourceIds].filter((id) => id !== targetSpeakerId), targetSpeakerId }], speakerRefs, assignments, nextSpeakerOrdinal: currentRevision.nextSpeakerOrdinal, now });
  }

  if (operation === 'split') {
    const source = activeSpeaker(currentRevision, speakerId);
    const ids = segmentIds(transcriptSegmentIds);
    const owned = assignments.filter((assignment) => assignment.speakerRef === source.speakerId).map((assignment) => assignment.transcriptSegmentId);
    if (!ids.every((id) => owned.includes(id))) throw codedError('SPEAKER_CORRECTION_ASSIGNMENT_INVALID');
    if (ids.length === owned.length) throw codedError('SPEAKER_CORRECTION_SPLIT_SET_INVALID');
    const newSpeakerId = `speaker-${currentRevision.nextSpeakerOrdinal}`;
    speakerRefs.push({ speakerId: newSpeakerId, displayLabel: `说话人${currentRevision.nextSpeakerOrdinal}`, labelSource: 'provider_anonymous', state: 'active', mergedIntoSpeakerId: null });
    for (const assignment of assignments) if (ids.includes(assignment.transcriptSegmentId)) assignment.speakerRef = newSpeakerId;
    return next({ ownerContext, currentRevision, correctionRevisionId, mutationRequestId, operation, changes: [{ sourceSpeakerId: source.speakerId, transcriptSegmentIds: ids, newSpeakerId }], speakerRefs, assignments, nextSpeakerOrdinal: currentRevision.nextSpeakerOrdinal + 1, now });
  }

  if (operation === 'reassign') {
    const ids = segmentIds(transcriptSegmentIds);
    if (targetSpeakerId !== 'unknown') activeSpeaker(currentRevision, targetSpeakerId);
    const known = new Set(assignments.map((assignment) => assignment.transcriptSegmentId));
    if (!ids.every((id) => known.has(id))) throw codedError('SPEAKER_CORRECTION_ASSIGNMENT_INVALID');
    const changing = assignments.filter((assignment) => ids.includes(assignment.transcriptSegmentId) && assignment.speakerRef !== targetSpeakerId);
    if (!changing.length) throw codedError('SPEAKER_CORRECTION_NO_CHANGE');
    for (const assignment of changing) assignment.speakerRef = targetSpeakerId;
    return next({ ownerContext, currentRevision, correctionRevisionId, mutationRequestId, operation, changes: [{ transcriptSegmentIds: changing.map((assignment) => assignment.transcriptSegmentId), targetSpeakerId }], speakerRefs, assignments, nextSpeakerOrdinal: currentRevision.nextSpeakerOrdinal, now });
  }
  throw codedError('SPEAKER_CORRECTION_OPERATION_INVALID');
}
