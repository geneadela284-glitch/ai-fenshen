import test from 'node:test';
import assert from 'node:assert/strict';

import { createBaseSpeakerCorrectionSnapshot } from './speakerCorrectionContracts.js';
import { applySpeakerCorrection } from './speakerCorrectionOperations.js';

const ownerContext = Object.freeze({ trusted: true, ownerId: 'owner-a', sessionId: 'session-a', spaceId: 'meeting-space' });
const now = '2026-08-09T00:00:00.000Z';

function current() {
  return createBaseSpeakerCorrectionSnapshot({ ownerContext, baseDiarizationSnapshotHash: 'b'.repeat(64), now, diarizationRevision: {
    schemaVersion: 1, diarizationRevisionId: 'diarization-1', ownerId: 'owner-a', meetingId: 'meeting-1', transcriptId: 'transcript-1', transcriptRevision: 7,
    source: 'provider_role_separation', status: 'ready', createdAt: now, updatedAt: now, revision: 1,
    speakerRefs: [
      { schemaVersion: 1, speakerId: 'speaker-1', ownerId: 'owner-a', meetingId: 'meeting-1', label: '说话人1', source: 'provider_role_separation', createdAt: now, updatedAt: now, revision: 1 },
      { schemaVersion: 1, speakerId: 'speaker-2', ownerId: 'owner-a', meetingId: 'meeting-1', label: '说话人2', source: 'provider_role_separation', createdAt: now, updatedAt: now, revision: 1 }
    ],
    segments: [
      { schemaVersion: 1, meetingId: 'meeting-1', transcriptId: 'transcript-1', transcriptRevision: 7, transcriptSegmentId: 'segment-1', startMs: 0, endMs: 1_000, speakerRef: 'speaker-1', confidence: null, source: 'provider_role_separation', revision: 1 },
      { schemaVersion: 1, meetingId: 'meeting-1', transcriptId: 'transcript-1', transcriptRevision: 7, transcriptSegmentId: 'segment-2', startMs: 1_000, endMs: 2_000, speakerRef: 'speaker-1', confidence: null, source: 'provider_role_separation', revision: 1 },
      { schemaVersion: 1, meetingId: 'meeting-1', transcriptId: 'transcript-1', transcriptRevision: 7, transcriptSegmentId: 'segment-3', startMs: 2_000, endMs: 3_000, speakerRef: 'speaker-2', confidence: null, source: 'provider_role_separation', revision: 1 },
      { schemaVersion: 1, meetingId: 'meeting-1', transcriptId: 'transcript-1', transcriptRevision: 7, transcriptSegmentId: 'segment-4', startMs: 3_000, endMs: 4_000, speakerRef: 'unknown', confidence: null, source: 'unknown', revision: 1 }
    ]
  } });
}

function apply(input, revision = current()) {
  return applySpeakerCorrection({ ownerContext, currentRevision: revision, correctionRevisionId: 'correction-1', mutationRequestId: 'mutation-1', now, ...input });
}

test('rename creates only the next immutable revision with trusted-owner audit', () => {
  const before = current();
  const original = structuredClone(before);
  const next = apply({ operation: 'rename', speakerId: 'speaker-1', displayLabel: ' 主持人 ' }, before);
  assert.equal(next.correctionRevision, 1);
  assert.equal(next.parentCorrectionRevisionId, null);
  assert.equal(next.speakerRefs[0].displayLabel, '主持人');
  assert.equal(next.speakerRefs[0].labelSource, 'user_entered');
  assert.deepEqual(next.audit, { mutationRequestId: 'mutation-1', operation: 'rename', actorType: 'owner_user', actorOwnerId: 'owner-a', changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }], occurredAt: now });
  assert.deepEqual(before, original);
  assert.throws(() => apply({ operation: 'rename', speakerId: 'unknown', displayLabel: '未知' }), (error) => error.code === 'SPEAKER_CORRECTION_SPEAKER_INVALID');
  assert.throws(() => apply({ operation: 'rename', speakerId: 'speaker-1', displayLabel: '说话人1' }), (error) => error.code === 'SPEAKER_CORRECTION_NO_CHANGE');
});

test('merge redirects all source assignments while unknown remains unknown', () => {
  const next = apply({ operation: 'merge', speakerIds: ['speaker-1', 'speaker-2'], targetSpeakerId: 'speaker-1' });
  assert.deepEqual(next.assignments.map((assignment) => assignment.speakerRef), ['speaker-1', 'speaker-1', 'speaker-1', 'unknown']);
  assert.deepEqual(next.speakerRefs[1], { speakerId: 'speaker-2', displayLabel: '说话人2', labelSource: 'provider_anonymous', state: 'merged', mergedIntoSpeakerId: 'speaker-1' });
  assert.throws(() => apply({ operation: 'merge', speakerIds: ['speaker-1'], targetSpeakerId: 'speaker-1' }), (error) => error.code === 'SPEAKER_CORRECTION_MERGE_SET_INVALID');
  assert.throws(() => apply({ operation: 'merge', speakerIds: ['speaker-1', 'unknown'], targetSpeakerId: 'speaker-1' }), (error) => error.code === 'SPEAKER_CORRECTION_SPEAKER_INVALID');
});

test('split moves only a non-empty proper set of complete source segment ids to a monotonically new speaker', () => {
  const next = apply({ operation: 'split', speakerId: 'speaker-1', transcriptSegmentIds: ['segment-2'] });
  assert.equal(next.correctionRevision, 1);
  assert.equal(next.nextSpeakerOrdinal, 4);
  assert.deepEqual(next.speakerRefs[2], { speakerId: 'speaker-3', displayLabel: '说话人3', labelSource: 'provider_anonymous', state: 'active', mergedIntoSpeakerId: null });
  assert.deepEqual(next.assignments.map((assignment) => [assignment.transcriptSegmentId, assignment.speakerRef]), [['segment-1', 'speaker-1'], ['segment-2', 'speaker-3'], ['segment-3', 'speaker-2'], ['segment-4', 'unknown']]);
  assert.throws(() => apply({ operation: 'split', speakerId: 'speaker-1', transcriptSegmentIds: ['segment-1', 'segment-2'] }), (error) => error.code === 'SPEAKER_CORRECTION_SPLIT_SET_INVALID');
  assert.throws(() => apply({ operation: 'split', speakerId: 'speaker-1', transcriptSegmentIds: ['segment-4'] }), (error) => error.code === 'SPEAKER_CORRECTION_ASSIGNMENT_INVALID');
});

test('reassign moves explicitly selected complete segments to an active speaker or unknown only', () => {
  const next = apply({ operation: 'reassign', transcriptSegmentIds: ['segment-1', 'segment-4'], targetSpeakerId: 'speaker-2' });
  assert.deepEqual(next.assignments.map((assignment) => assignment.speakerRef), ['speaker-2', 'speaker-1', 'speaker-2', 'speaker-2']);
  assert.equal(next.speakerRefs.length, 2);
  assert.throws(() => apply({ operation: 'reassign', transcriptSegmentIds: ['segment-3'], targetSpeakerId: 'speaker-2' }), (error) => error.code === 'SPEAKER_CORRECTION_NO_CHANGE');
  assert.throws(() => apply({ operation: 'reassign', transcriptSegmentIds: ['segment-1'], targetSpeakerId: 'speaker-9' }), (error) => error.code === 'SPEAKER_CORRECTION_SPEAKER_INVALID');
});

test('operations reject owner mismatches and never accept partial or unknown implicit changes', () => {
  const revision = current();
  assert.throws(() => applySpeakerCorrection({ ownerContext: { ...ownerContext, ownerId: 'owner-b' }, currentRevision: revision, operation: 'reassign', correctionRevisionId: 'correction-1', mutationRequestId: 'mutation-1', transcriptSegmentIds: ['segment-4'], targetSpeakerId: 'speaker-1' }), (error) => error.code === 'OWNER_SCOPE_MISMATCH');
  assert.throws(() => apply({ operation: 'reassign', transcriptSegmentIds: [], targetSpeakerId: 'unknown' }), (error) => error.code === 'SPEAKER_CORRECTION_SEGMENT_SET_INVALID');
  assert.throws(() => apply({ operation: 'split', speakerId: 'unknown', transcriptSegmentIds: ['segment-4'] }), (error) => error.code === 'SPEAKER_CORRECTION_SPEAKER_INVALID');
});

test('reassign supports unknown as an explicit target and audits only segments that actually changed', () => {
  const before = current();
  const original = structuredClone(before);
  const next = apply({ operation: 'reassign', transcriptSegmentIds: ['segment-1', 'segment-4'], targetSpeakerId: 'unknown' }, before);
  assert.deepEqual(next.assignments.map((assignment) => assignment.speakerRef), ['unknown', 'speaker-1', 'speaker-2', 'unknown']);
  assert.deepEqual(next.audit.changes, [{ transcriptSegmentIds: ['segment-1'], targetSpeakerId: 'unknown' }]);
  assert.deepEqual(before, original);
  assert.equal(Object.isFrozen(next.audit.changes[0]), true);
});

test('operation audits have exact before-after changes and permit a fifth speaker without a hidden cap', () => {
  const before = current();
  const renamed = apply({ operation: 'rename', speakerId: 'speaker-1', displayLabel: '主持人' }, before);
  assert.deepEqual(renamed.audit.changes, [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }]);
  const expanded = { ...before, speakerRefs: [...before.speakerRefs, { speakerId: 'speaker-3', displayLabel: '说话人3', labelSource: 'provider_anonymous', state: 'active', mergedIntoSpeakerId: null }, { speakerId: 'speaker-4', displayLabel: '说话人4', labelSource: 'provider_anonymous', state: 'active', mergedIntoSpeakerId: null }], nextSpeakerOrdinal: 5 };
  const fifth = apply({ operation: 'split', speakerId: 'speaker-1', transcriptSegmentIds: ['segment-1'] }, expanded);
  assert.equal(fifth.speakerRefs.at(-1).speakerId, 'speaker-5');
  assert.equal(fifth.nextSpeakerOrdinal, 6);
});
