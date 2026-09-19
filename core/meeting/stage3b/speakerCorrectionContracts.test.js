import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPEAKER_CORRECTION_SCHEMA_VERSION,
  createBaseSpeakerCorrectionSnapshot,
  createSpeakerCorrectionRevision,
  validateSpeakerCorrectionRevision
} from './speakerCorrectionContracts.js';

const ownerContext = Object.freeze({ trusted: true, ownerId: 'owner-a', sessionId: 'session-a', spaceId: 'meeting-space' });
const hash = 'a'.repeat(64);
const now = '2026-08-09T00:00:00.000Z';

function diarizationRevision() {
  return {
    schemaVersion: 1,
    diarizationRevisionId: 'diarization-1',
    ownerId: 'owner-a',
    meetingId: 'meeting-1',
    transcriptId: 'transcript-1',
    transcriptRevision: 7,
    source: 'provider_role_separation',
    status: 'ready',
    speakerRefs: [
      { schemaVersion: 1, speakerId: 'speaker-1', ownerId: 'owner-a', meetingId: 'meeting-1', label: '说话人1', source: 'provider_role_separation', createdAt: now, updatedAt: now, revision: 1 },
      { schemaVersion: 1, speakerId: 'speaker-2', ownerId: 'owner-a', meetingId: 'meeting-1', label: '说话人2', source: 'provider_role_separation', createdAt: now, updatedAt: now, revision: 1 }
    ],
    segments: [
      { schemaVersion: 1, meetingId: 'meeting-1', transcriptId: 'transcript-1', transcriptRevision: 7, transcriptSegmentId: 'segment-1', startMs: 0, endMs: 1_000, speakerRef: 'speaker-1', confidence: null, source: 'provider_role_separation', revision: 1 },
      { schemaVersion: 1, meetingId: 'meeting-1', transcriptId: 'transcript-1', transcriptRevision: 7, transcriptSegmentId: 'segment-2', startMs: 1_000, endMs: 2_000, speakerRef: 'unknown', confidence: null, source: 'unknown', revision: 1 }
    ],
    createdAt: now,
    updatedAt: now,
    revision: 1
  };
}

function base() {
  return createBaseSpeakerCorrectionSnapshot({ ownerContext, diarizationRevision: diarizationRevision(), baseDiarizationSnapshotHash: hash, now });
}

test('projects a diarization revision into an immutable correction base without transcript or timeline payload', () => {
  const snapshot = base();
  assert.equal(snapshot.correctionRevision, 0);
  assert.equal(snapshot.correctionRevisionId, null);
  assert.equal(snapshot.parentCorrectionRevisionId, null);
  assert.deepEqual(Object.keys(snapshot.assignments[0]).sort(), ['speakerRef', 'transcriptSegmentId']);
  assert.deepEqual(Object.keys(snapshot.speakerRefs[0]).sort(), ['displayLabel', 'labelSource', 'mergedIntoSpeakerId', 'speakerId', 'state']);
  assert.equal('text' in snapshot, false);
  assert.equal('startMs' in snapshot.assignments[0], false);
  assert.equal('endMs' in snapshot.assignments[0], false);
  assert.equal(Object.isFrozen(snapshot.assignments), true);
  assert.equal(Object.isFrozen(snapshot.assignments[0]), true);
  assert.throws(() => createBaseSpeakerCorrectionSnapshot({ ownerContext: { ...ownerContext, ownerId: 'owner-b' }, diarizationRevision: diarizationRevision(), baseDiarizationSnapshotHash: hash }), (error) => error.code === 'OWNER_SCOPE_MISMATCH');
  assert.throws(() => createBaseSpeakerCorrectionSnapshot({ ownerContext, diarizationRevision: diarizationRevision(), baseDiarizationSnapshotHash: 'A'.repeat(64) }), (error) => error.code === 'SPEAKER_CORRECTION_BASE_HASH_INVALID');
});

test('validates correction binding, unique active assignments, speaker merge state, audit and revision continuity', () => {
  const snapshot = base();
  const renamedSpeakers = snapshot.speakerRefs.map((speaker) => speaker.speakerId === 'speaker-1' ? { ...speaker, displayLabel: '主持人', labelSource: 'user_entered' } : speaker);
  const revision = createSpeakerCorrectionRevision({
    ownerContext,
    parent: snapshot,
    correctionRevisionId: 'correction-1',
    speakerRefs: renamedSpeakers,
    assignments: snapshot.assignments,
    nextSpeakerOrdinal: snapshot.nextSpeakerOrdinal,
    audit: { mutationRequestId: 'mutation-1', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now },
    createdAt: now
  });
  assert.equal(revision.schemaVersion, SPEAKER_CORRECTION_SCHEMA_VERSION);
  assert.equal(revision.correctionRevision, 1);
  assert.equal(revision.parentCorrectionRevisionId, null);
  assert.deepEqual(validateSpeakerCorrectionRevision(revision, { ownerContext, parent: snapshot }), { valid: true, errors: [] });

  const invalid = structuredClone(revision);
  invalid.assignments.push({ transcriptSegmentId: 'segment-1', speakerRef: 'speaker-1' });
  invalid.speakerRefs[1].state = 'merged';
  invalid.speakerRefs[1].mergedIntoSpeakerId = 'speaker-2';
  invalid.assignments[0].speakerRef = 'speaker-2';
  invalid.nextSpeakerOrdinal = 2;
  invalid.audit.changes = [{ text: 'secret transcript text' }];
  assert.deepEqual(validateSpeakerCorrectionRevision(invalid, { ownerContext, parent: snapshot }).errors.sort(), [
    'SPEAKER_CORRECTION_ASSIGNMENT_DUPLICATE',
    'SPEAKER_CORRECTION_ASSIGNMENT_SPEAKER_INVALID',
    'SPEAKER_CORRECTION_AUDIT_CHANGE_INVALID',
    'SPEAKER_CORRECTION_MERGED_TARGET_INVALID',
    'SPEAKER_CORRECTION_NEXT_ORDINAL_REUSED'
  ]);
});

test('rejects correction revision owner overrides, non-continuous parents and invalid user labels', () => {
  const snapshot = base();
  assert.throws(() => createSpeakerCorrectionRevision({
    ownerContext,
    ownerId: 'owner-b',
    parent: snapshot,
    correctionRevisionId: 'correction-1',
    speakerRefs: snapshot.speakerRefs,
    assignments: snapshot.assignments,
    nextSpeakerOrdinal: snapshot.nextSpeakerOrdinal,
    audit: { mutationRequestId: 'mutation-1', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now }, createdAt: now
  }), (error) => error.code === 'OWNER_ID_OVERRIDE_REJECTED');
  assert.throws(() => createSpeakerCorrectionRevision({
    ownerContext,
    parent: { ...snapshot, correctionRevision: 2 },
    correctionRevisionId: 'correction-1',
    speakerRefs: snapshot.speakerRefs,
    assignments: snapshot.assignments,
    nextSpeakerOrdinal: snapshot.nextSpeakerOrdinal,
    audit: { mutationRequestId: 'mutation-1', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now }, createdAt: now
  }), (error) => error.code === 'SPEAKER_CORRECTION_PARENT_INVALID');
  assert.throws(() => createSpeakerCorrectionRevision({
    ownerContext, parent: snapshot, correctionRevisionId: 'correction-1', nextSpeakerOrdinal: snapshot.nextSpeakerOrdinal,
    speakerRefs: [{ ...snapshot.speakerRefs[0], displayLabel: 'x'.repeat(81), labelSource: 'user_entered' }, snapshot.speakerRefs[1]],
    assignments: snapshot.assignments,
    audit: { mutationRequestId: 'mutation-1', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now }, createdAt: now
  }), (error) => error.code === 'SPEAKER_CORRECTION_LABEL_INVALID');
});

test('fails closed on unknown or sensitive fields at every correction schema level', () => {
  const snapshot = base();
  const renamedSpeakers = snapshot.speakerRefs.map((speaker) => speaker.speakerId === 'speaker-1' ? { ...speaker, displayLabel: '主持人', labelSource: 'user_entered' } : speaker);
  const revision = createSpeakerCorrectionRevision({
    ownerContext, parent: snapshot, correctionRevisionId: 'correction-1', speakerRefs: renamedSpeakers, assignments: snapshot.assignments, nextSpeakerOrdinal: snapshot.nextSpeakerOrdinal,
    audit: { mutationRequestId: 'mutation-1', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now }, createdAt: now
  });
  for (const mutate of [
    (value) => { value.text = 'raw transcript'; },
    (value) => { value.speakerRefs[0].provider = { payload: true }; },
    (value) => { value.assignments[0].startMs = 0; },
    (value) => { value.audit.payload = 'provider payload'; },
    (value) => { value.audit.changes[0].rawText = 'raw transcript'; }
  ]) {
    const invalid = structuredClone(revision);
    mutate(invalid);
    assert.equal(validateSpeakerCorrectionRevision(invalid, { ownerContext, parent: snapshot }).valid, false);
  }
  assert.throws(() => createSpeakerCorrectionRevision({
    ownerContext, parent: snapshot, correctionRevisionId: 'correction-1', speakerRefs: [{ ...snapshot.speakerRefs[0], provider: 'x' }, snapshot.speakerRefs[1]], assignments: snapshot.assignments, nextSpeakerOrdinal: snapshot.nextSpeakerOrdinal,
    audit: { mutationRequestId: 'mutation-1', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now }, createdAt: now
  }), (error) => error.code === 'SPEAKER_CORRECTION_SPEAKER_SHAPE_INVALID');
});

test('accepts an all-unknown immutable base and protects raw diarization from mutation', () => {
  const diarization = diarizationRevision();
  diarization.speakerRefs = [];
  diarization.segments = diarization.segments.map((segment) => ({ ...segment, speakerRef: 'unknown', source: 'unknown' }));
  const original = structuredClone(diarization);
  const snapshot = createBaseSpeakerCorrectionSnapshot({ ownerContext, diarizationRevision: diarization, baseDiarizationSnapshotHash: hash, now });
  assert.deepEqual(diarization, original);
  assert.deepEqual(snapshot.speakerRefs, []);
  assert.deepEqual(snapshot.assignments.map((assignment) => assignment.speakerRef), ['unknown', 'unknown']);
  assert.equal(snapshot.nextSpeakerOrdinal, 1);
});

test('requires explicit stable timestamps and validates a monotonic revision chain without transition bypasses', () => {
  const snapshot = base();
  const audit = { mutationRequestId: 'mutation-1', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now };
  const revision1Speakers = snapshot.speakerRefs.map((speaker) => speaker.speakerId === 'speaker-1' ? { ...speaker, displayLabel: '主持人', labelSource: 'user_entered' } : speaker);
  const revision1 = createSpeakerCorrectionRevision({ ownerContext, parent: snapshot, correctionRevisionId: 'correction-1', speakerRefs: revision1Speakers, assignments: snapshot.assignments, nextSpeakerOrdinal: snapshot.nextSpeakerOrdinal, audit, createdAt: now });
  const revision2Speakers = revision1.speakerRefs.map((speaker) => speaker.speakerId === 'speaker-2' ? { ...speaker, displayLabel: '汇报人', labelSource: 'user_entered' } : speaker);
  const revision2 = createSpeakerCorrectionRevision({ ownerContext, parent: revision1, correctionRevisionId: 'correction-2', speakerRefs: revision2Speakers, assignments: revision1.assignments, nextSpeakerOrdinal: revision1.nextSpeakerOrdinal, audit: { ...audit, mutationRequestId: 'mutation-2', changes: [{ speakerId: 'speaker-2', previousDisplayLabel: '说话人2', displayLabel: '汇报人' }] }, createdAt: now });
  assert.equal(revision2.parentCorrectionRevisionId, 'correction-1');
  for (const mutate of [
    (value) => { value.correctionRevisionId = 'correction-1'; },
    (value) => { value.assignments.pop(); },
    (value) => { value.assignments[0].transcriptSegmentId = 'forged-segment'; },
    (value) => { value.speakerRefs.pop(); },
    (value) => { value.nextSpeakerOrdinal = 1; }
  ]) {
    const invalid = structuredClone(revision2);
    mutate(invalid);
    assert.equal(validateSpeakerCorrectionRevision(invalid, { ownerContext, parent: revision1 }).valid, false);
  }
  const missingCreatedAt = structuredClone(revision1);
  delete missingCreatedAt.createdAt;
  assert.equal(validateSpeakerCorrectionRevision(missingCreatedAt, { ownerContext, parent: snapshot }).errors.includes('SPEAKER_CORRECTION_CREATED_AT_INVALID'), true);
  const invalidAuditTime = structuredClone(revision1);
  invalidAuditTime.audit.occurredAt = 'not-a-date';
  assert.deepEqual(validateSpeakerCorrectionRevision(invalidAuditTime, { ownerContext, parent: snapshot }).errors, ['SPEAKER_CORRECTION_AUDIT_TIME_INVALID']);
  const invalidRevision2 = structuredClone(revision2);
  invalidRevision2.parentCorrectionRevisionId = null;
  assert.equal(validateSpeakerCorrectionRevision(invalidRevision2, { ownerContext }).valid, false);
});

test('rejects forged operation deltas that alter anything beyond the audited rename, merge or split', () => {
  const snapshot = base();
  const renameParent = structuredClone(snapshot);
  renameParent.assignments[0].speakerRef = 'speaker-2';
  const renamedSpeakers = renameParent.speakerRefs.map((speaker) => speaker.speakerId === 'speaker-1' ? { ...speaker, displayLabel: '主持人', labelSource: 'user_entered' } : speaker);
  const rename = createSpeakerCorrectionRevision({ ownerContext, parent: renameParent, correctionRevisionId: 'rename-1', speakerRefs: renamedSpeakers, assignments: renameParent.assignments, nextSpeakerOrdinal: renameParent.nextSpeakerOrdinal, audit: { mutationRequestId: 'rename-1', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now }, createdAt: now });
  const forgedRename = structuredClone(rename);
  forgedRename.speakerRefs[0].state = 'merged';
  forgedRename.speakerRefs[0].mergedIntoSpeakerId = 'speaker-2';
  assert.equal(validateSpeakerCorrectionRevision(forgedRename, { ownerContext, parent: renameParent }).valid, false);

  const mergedSpeakers = snapshot.speakerRefs.map((speaker) => speaker.speakerId === 'speaker-2' ? { ...speaker, state: 'merged', mergedIntoSpeakerId: 'speaker-1' } : speaker);
  const merge = createSpeakerCorrectionRevision({ ownerContext, parent: snapshot, correctionRevisionId: 'merge-1', speakerRefs: mergedSpeakers, assignments: snapshot.assignments, nextSpeakerOrdinal: snapshot.nextSpeakerOrdinal, audit: { mutationRequestId: 'merge-1', operation: 'merge', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ sourceSpeakerIds: ['speaker-2'], targetSpeakerId: 'speaker-1' }], occurredAt: now }, createdAt: now });
  const forgedMerge = structuredClone(merge);
  forgedMerge.speakerRefs[1].displayLabel = '伪造姓名';
  forgedMerge.speakerRefs[1].labelSource = 'user_entered';
  assert.equal(validateSpeakerCorrectionRevision(forgedMerge, { ownerContext, parent: snapshot }).valid, false);

  const splitParent = structuredClone(snapshot);
  splitParent.assignments[1].speakerRef = 'speaker-1';
  const splitSpeakers = [...splitParent.speakerRefs, { speakerId: 'speaker-3', displayLabel: '说话人3', labelSource: 'provider_anonymous', state: 'active', mergedIntoSpeakerId: null }];
  const splitAssignments = splitParent.assignments.map((assignment) => assignment.transcriptSegmentId === 'segment-1' ? { ...assignment, speakerRef: 'speaker-3' } : assignment);
  const split = createSpeakerCorrectionRevision({ ownerContext, parent: splitParent, correctionRevisionId: 'split-1', speakerRefs: splitSpeakers, assignments: splitAssignments, nextSpeakerOrdinal: 4, audit: { mutationRequestId: 'split-1', operation: 'split', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ sourceSpeakerId: 'speaker-1', transcriptSegmentIds: ['segment-1'], newSpeakerId: 'speaker-3' }], occurredAt: now }, createdAt: now });
  const forgedSplit = structuredClone(split);
  forgedSplit.audit.changes[0].newSpeakerId = 'speaker-2';
  forgedSplit.assignments[0].speakerRef = 'speaker-2';
  assert.equal(validateSpeakerCorrectionRevision(forgedSplit, { ownerContext, parent: splitParent }).valid, false);
  const namedSplit = structuredClone(split);
  namedSplit.speakerRefs[2].displayLabel = '张三';
  namedSplit.speakerRefs[2].labelSource = 'user_entered';
  assert.equal(validateSpeakerCorrectionRevision(namedSplit, { ownerContext, parent: splitParent }).valid, false);
});

test('fails closed for non-anonymous base profiles, duplicate audit ids and malformed parents', () => {
  const snapshot = base();
  const invalidBase = structuredClone(snapshot);
  invalidBase.speakerRefs[0].displayLabel = '张三';
  invalidBase.speakerRefs[0].labelSource = 'user_entered';
  assert.equal(validateSpeakerCorrectionRevision(invalidBase, { ownerContext }).valid, false);
  const auditedBase = structuredClone(snapshot);
  auditedBase.audit = { mutationRequestId: 'base-audit', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now };
  assert.equal(validateSpeakerCorrectionRevision(auditedBase, { ownerContext }).valid, false);
  const reassigned = snapshot.assignments.map((assignment) => assignment.transcriptSegmentId === 'segment-1' ? { ...assignment, speakerRef: 'speaker-2' } : assignment);
  const revision = createSpeakerCorrectionRevision({ ownerContext, parent: snapshot, correctionRevisionId: 'reassign-1', speakerRefs: snapshot.speakerRefs, assignments: reassigned, nextSpeakerOrdinal: snapshot.nextSpeakerOrdinal, audit: { mutationRequestId: 'reassign-1', operation: 'reassign', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ transcriptSegmentIds: ['segment-1'], targetSpeakerId: 'speaker-2' }], occurredAt: now }, createdAt: now });
  const duplicateIds = structuredClone(revision);
  duplicateIds.audit.changes[0].transcriptSegmentIds = ['segment-1', 'segment-1'];
  assert.equal(validateSpeakerCorrectionRevision(duplicateIds, { ownerContext }).valid, false);
  assert.doesNotThrow(() => validateSpeakerCorrectionRevision(revision, { ownerContext, parent: {} }));
  assert.equal(validateSpeakerCorrectionRevision(revision, { ownerContext, parent: {} }).errors.includes('SPEAKER_CORRECTION_PARENT_INVALID'), true);
});

test('fails closed without native exceptions for invalid parent or child nested correction shapes', () => {
  const snapshot = base();
  const speakers = snapshot.speakerRefs.map((speaker) => speaker.speakerId === 'speaker-1' ? { ...speaker, displayLabel: '主持人', labelSource: 'user_entered' } : speaker);
  const child = createSpeakerCorrectionRevision({ ownerContext, parent: snapshot, correctionRevisionId: 'child-1', speakerRefs: speakers, assignments: snapshot.assignments, nextSpeakerOrdinal: snapshot.nextSpeakerOrdinal, audit: { mutationRequestId: 'child-1', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now }, createdAt: now });
  for (const parent of [
    { ...snapshot, text: 'secret' },
    { ...snapshot, assignments: [null] },
    { ...snapshot, speakerRefs: [null] }
  ]) {
    assert.doesNotThrow(() => validateSpeakerCorrectionRevision(child, { ownerContext, parent }));
    assert.equal(validateSpeakerCorrectionRevision(child, { ownerContext, parent }).valid, false);
    assert.equal(validateSpeakerCorrectionRevision(child, { ownerContext, parent }).errors.includes('SPEAKER_CORRECTION_PARENT_INVALID'), true);
  }
  for (const invalidChild of [
    { ...structuredClone(child), assignments: [null] },
    { ...structuredClone(child), speakerRefs: [null] }
  ]) {
    assert.doesNotThrow(() => validateSpeakerCorrectionRevision(invalidChild, { ownerContext, parent: snapshot }));
    assert.equal(validateSpeakerCorrectionRevision(invalidChild, { ownerContext, parent: snapshot }).valid, false);
  }
});
