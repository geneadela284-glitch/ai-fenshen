import assert from 'node:assert/strict';
import test from 'node:test';

let facadeModule = {};
try {
  facadeModule = await import('./meetingSpeakerManagementUiFacade.js');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const MEETING_ID = 'meeting-1';
const TRANSCRIPT_ID = 'transcript-1';

function clone(value) {
  return structuredClone(value);
}

function projection({ correctionRevision = 4, firstLabel = '主持人' } = {}) {
  return {
    meetingId: MEETING_ID,
    transcriptId: TRANSCRIPT_ID,
    transcriptRevision: 7,
    baseDiarizationRevisionId: 'diarization-private-id',
    baseDiarizationRevision: 3,
    baseDiarizationSnapshotHash: 'a'.repeat(64),
    correctionRevisionId: 'correction-private-id',
    correctionRevision,
    hasCorrections: correctionRevision > 0,
    speakerRefs: [
      { speakerId: 'speaker-1', displayLabel: firstLabel, labelSource: 'user_entered', state: 'active', mergedIntoSpeakerId: null },
      { speakerId: 'speaker-2', displayLabel: '记录员', labelSource: 'provider_anonymous', state: 'active', mergedIntoSpeakerId: null },
      { speakerId: 'speaker-3', displayLabel: '已合并说话人', labelSource: 'provider_anonymous', state: 'merged', mergedIntoSpeakerId: 'speaker-1' }
    ],
    segments: [
      {
        rawSegment: { segmentId: 'segment-1', startMs: 0, endMs: 1_000, text: '完整第一段', providerSecret: 'never-show' },
        rawDiarization: { speakerRef: 'speaker-1', confidence: 0.9, source: 'provider_role_separation' },
        effectiveSpeaker: { speakerRef: 'speaker-1', displayLabel: firstLabel, labelSource: 'user_entered', state: 'active' }
      },
      {
        rawSegment: { segmentId: 'segment-2', startMs: 1_000, endMs: 2_000, text: '完整第二段' },
        rawDiarization: { speakerRef: 'speaker-1', confidence: 0.9, source: 'provider_role_separation' },
        effectiveSpeaker: { speakerRef: 'speaker-1', displayLabel: firstLabel, labelSource: 'user_entered', state: 'active' }
      },
      {
        rawSegment: { segmentId: 'segment-3', startMs: 2_000, endMs: 3_000, text: '完整第三段' },
        rawDiarization: { speakerRef: 'unknown', confidence: null, source: 'unknown' },
        effectiveSpeaker: { speakerRef: 'unknown', displayLabel: '未识别说话人', labelSource: 'unknown', state: 'unknown' }
      }
    ]
  };
}

function history({ correctionRevision = 4, correctionRevisionId = 'correction-private-id' } = {}) {
  return {
    baseRevision: {
      meetingId: MEETING_ID,
      transcriptId: TRANSCRIPT_ID,
      transcriptRevision: 7,
      baseDiarizationRevisionId: 'diarization-private-id',
      baseDiarizationRevision: 3,
      baseDiarizationSnapshotHash: 'a'.repeat(64),
      correctionRevision: 0,
      ownerId: 'private-owner'
    },
    currentCorrectionRevision: correctionRevision,
    correctionRevisions: [
      {
        correctionRevisionId,
        correctionRevision,
        audit: {
          mutationRequestId: 'private-request-id',
          operation: 'rename',
          actorOwnerId: 'private-owner',
          occurredAt: '2026-08-10T08:00:00.000Z',
          changes: [{ speakerId: 'speaker-1', previousDisplayLabel: '说话人1', displayLabel: '主持人' }]
        }
      }
    ]
  };
}

function codedError(code, details) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function managerFixture({ currentProjection = projection(), currentHistory = history() } = {}) {
  const calls = [];
  let nextProjection = currentProjection;
  let nextHistory = currentHistory;
  const failures = new Map();
  const manager = {
    async getSpeakerProjection(input) {
      calls.push(['getSpeakerProjection', clone(input)]);
      return clone(nextProjection);
    },
    async getCorrectionHistory(input) {
      calls.push(['getCorrectionHistory', clone(input)]);
      return clone(nextHistory);
    },
    async renameSpeaker(input) { calls.push(['renameSpeaker', clone(input)]); if (failures.has('renameSpeaker')) throw failures.get('renameSpeaker'); return { replayed: false }; },
    async mergeSpeakers(input) { calls.push(['mergeSpeakers', clone(input)]); if (failures.has('mergeSpeakers')) throw failures.get('mergeSpeakers'); return { replayed: false }; },
    async splitSpeaker(input) { calls.push(['splitSpeaker', clone(input)]); if (failures.has('splitSpeaker')) throw failures.get('splitSpeaker'); return { replayed: false }; },
    async reassignSegments(input) { calls.push(['reassignSegments', clone(input)]); if (failures.has('reassignSegments')) throw failures.get('reassignSegments'); return { replayed: false }; }
  };
  return {
    manager,
    calls,
    fail(method, error) { failures.set(method, error); },
    setHead(value) { nextProjection = value; },
    setHistory(value) { nextHistory = value; }
  };
}

function createFacade(input) {
  assert.equal(
    typeof facadeModule.createMeetingSpeakerManagementUiFacade,
    'function',
    'Phase4 UI facade production export is not implemented'
  );
  return facadeModule.createMeetingSpeakerManagementUiFacade(input);
}

function cryptoIds() {
  let sequence = 0;
  return { randomUUID: () => `ui-request-${++sequence}` };
}

async function loadedFacade(fixture = managerFixture()) {
  const facade = createFacade({ manager: fixture.manager, cryptoImpl: cryptoIds() });
  const snapshot = await facade.load({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  return { facade, snapshot, fixture };
}

test('maps only safe immutable user-view fields and preserves the explicit unknown speaker', async () => {
  const { snapshot } = await loadedFacade();

  assert.deepEqual(snapshot, {
    speakers: [
      { id: 'speaker-1', label: '主持人', canRename: true, canMerge: true, canSplit: true, canReceiveReassignment: true },
      { id: 'speaker-2', label: '记录员', canRename: true, canMerge: true, canSplit: false, canReceiveReassignment: true },
      { id: 'unknown', label: '未识别说话人', canRename: false, canMerge: false, canSplit: false, canReceiveReassignment: true }
    ],
    segments: [
      { id: 'segment-1', startMs: 0, endMs: 1_000, text: '完整第一段', speakerId: 'speaker-1', speakerLabel: '主持人', canSelectForSplit: true, canSelectForReassignment: true },
      { id: 'segment-2', startMs: 1_000, endMs: 2_000, text: '完整第二段', speakerId: 'speaker-1', speakerLabel: '主持人', canSelectForSplit: true, canSelectForReassignment: true },
      { id: 'segment-3', startMs: 2_000, endMs: 3_000, text: '完整第三段', speakerId: 'unknown', speakerLabel: '未识别说话人', canSelectForSplit: false, canSelectForReassignment: true }
    ],
    history: [{ occurredAt: '2026-08-10T08:00:00.000Z', summary: '已将“说话人1”重命名为“主持人”' }]
  });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.segments[0]), true);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of ['private', 'owner', 'revision', 'hash', 'provider', 'confidence', 'raw', 'secret']) {
    assert.equal(serialized.toLowerCase().includes(forbidden), false, `safe UI snapshot leaked ${forbidden}`);
  }
});

test('translates each safe operation intent into the exact typed Manager DTO', async () => {
  const { facade, snapshot, fixture } = await loadedFacade();
  await facade.apply(snapshot, { type: 'rename', speakerId: 'speaker-1', displayLabel: '主持人' });
  await facade.apply(snapshot, { type: 'merge', speakerIds: ['speaker-1', 'speaker-2'], targetSpeakerId: 'speaker-1' });
  await facade.apply(snapshot, { type: 'split', speakerId: 'speaker-1', segmentIds: ['segment-1'] });
  await facade.apply(snapshot, { type: 'reassign', segmentIds: ['segment-3'], targetSpeakerId: 'unknown' });

  const mutations = fixture.calls.filter(([method]) => method !== 'getSpeakerProjection' && method !== 'getCorrectionHistory');
  assert.deepEqual(mutations, [
    ['renameSpeaker', { meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID, expectedTranscriptRevision: 7, baseDiarizationRevisionId: 'diarization-private-id', expectedCorrectionRevision: 4, mutationRequestId: 'ui-request-1', speakerId: 'speaker-1', displayLabel: '主持人' }],
    ['mergeSpeakers', { meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID, expectedTranscriptRevision: 7, baseDiarizationRevisionId: 'diarization-private-id', expectedCorrectionRevision: 4, mutationRequestId: 'ui-request-2', speakerIds: ['speaker-1', 'speaker-2'], targetSpeakerId: 'speaker-1' }],
    ['splitSpeaker', { meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID, expectedTranscriptRevision: 7, baseDiarizationRevisionId: 'diarization-private-id', expectedCorrectionRevision: 4, mutationRequestId: 'ui-request-3', speakerId: 'speaker-1', transcriptSegmentIds: ['segment-1'] }],
    ['reassignSegments', { meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID, expectedTranscriptRevision: 7, baseDiarizationRevisionId: 'diarization-private-id', expectedCorrectionRevision: 4, mutationRequestId: 'ui-request-4', transcriptSegmentIds: ['segment-3'], targetSpeakerId: 'unknown' }]
  ]);
});

test('keeps a stable mutation request ID for an identical safe snapshot retry', async () => {
  const { facade, snapshot, fixture } = await loadedFacade();
  const intent = { type: 'rename', speakerId: 'speaker-1', displayLabel: '主持人' };

  await facade.apply(snapshot, intent);
  await facade.apply(snapshot, clone(intent));

  const requestIds = fixture.calls
    .filter(([method]) => method === 'renameSpeaker')
    .map(([, input]) => input.mutationRequestId);
  assert.deepEqual(requestIds, ['ui-request-1', 'ui-request-1']);
});

test('reloads the authoritative current head after a successful write instead of returning a Manager projection', async () => {
  const fixture = managerFixture();
  const { facade, snapshot } = await loadedFacade(fixture);
  fixture.setHead(projection({ correctionRevision: 5, firstLabel: '最新主持人' }));
  fixture.setHistory(history({ correctionRevision: 5 }));

  const current = await facade.apply(snapshot, { type: 'rename', speakerId: 'speaker-1', displayLabel: '主持人' });

  assert.equal(current.segments[0].speakerLabel, '最新主持人');
  assert.equal(fixture.calls.filter(([method]) => method === 'getSpeakerProjection').length, 2);
});

test('maps only the exact no-change mutation outcome to safe corrective guidance', async () => {
  const noChangeFixture = managerFixture();
  const { facade, snapshot } = await loadedFacade(noChangeFixture);
  noChangeFixture.fail('renameSpeaker', codedError('SPEAKER_CORRECTION_NO_CHANGE'));

  assert.deepEqual(
    await facade.apply(snapshot, { type: 'rename', speakerId: 'speaker-1', displayLabel: '主持人' }),
    { error: { category: 'no_change', message: '当前选择没有产生新的修改，请调整后再试。', committed: false, requiresRefresh: false } }
  );

  const otherFixture = managerFixture();
  const { facade: otherFacade, snapshot: otherSnapshot } = await loadedFacade(otherFixture);
  otherFixture.fail('renameSpeaker', codedError('SPEAKER_CORRECTION_NO_CHANGE_UNTRUSTED'));
  await assert.rejects(
    () => otherFacade.apply(otherSnapshot, { type: 'rename', speakerId: 'speaker-1', displayLabel: '主持人' }),
    { code: 'SPEAKER_CORRECTION_NO_CHANGE_UNTRUSTED' }
  );
});

test('retries one incoherent projection-history read and binds mutations to the coherent head', async () => {
  const fixture = managerFixture();
  const oldProjection = projection({ correctionRevision: 4, firstLabel: '旧主持人' });
  const currentProjection = projection({ correctionRevision: 5, firstLabel: '最新主持人' });
  const currentHistory = history({ correctionRevision: 5 });
  let projectionReads = 0;
  let historyReads = 0;
  fixture.manager.getSpeakerProjection = async (input) => {
    fixture.calls.push(['getSpeakerProjection', clone(input)]);
    projectionReads += 1;
    return clone(projectionReads === 1 ? oldProjection : currentProjection);
  };
  fixture.manager.getCorrectionHistory = async (input) => {
    fixture.calls.push(['getCorrectionHistory', clone(input)]);
    historyReads += 1;
    return clone(currentHistory);
  };
  const facade = createFacade({ manager: fixture.manager, cryptoImpl: cryptoIds() });

  const snapshot = await facade.load({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  assert.equal(snapshot.segments[0].speakerLabel, '最新主持人');
  assert.equal(projectionReads, 2);
  assert.equal(historyReads, 2);

  await facade.apply(snapshot, { type: 'rename', speakerId: 'speaker-1', displayLabel: '下一名称' });
  const mutation = fixture.calls.find(([method]) => method === 'renameSpeaker');
  assert.equal(mutation[1].expectedCorrectionRevision, 5);
  assert.equal(mutation[1].baseDiarizationRevisionId, 'diarization-private-id');
});

test('fails closed after one retry when projection and history remain incoherent', async () => {
  const fixture = managerFixture({
    currentProjection: projection({ correctionRevision: 4 }),
    currentHistory: history({ correctionRevision: 5 })
  });
  const facade = createFacade({ manager: fixture.manager, cryptoImpl: cryptoIds() });

  await assert.rejects(
    () => facade.load({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID }),
    { code: 'SPEAKER_MANAGEMENT_UI_READ_COHERENCE_INVALID' }
  );
  assert.equal(fixture.calls.filter(([method]) => method === 'getSpeakerProjection').length, 2);
  assert.equal(fixture.calls.filter(([method]) => method === 'getCorrectionHistory').length, 2);
});

test('maps CAS and source failures to safe refresh guidance without an automatic retry or rebase', async () => {
  const casFixture = managerFixture();
  const { facade: casFacade, snapshot: casSnapshot } = await loadedFacade(casFixture);
  casFixture.fail('renameSpeaker', codedError('SPEAKER_CORRECTION_CAS_CONFLICT'));

  assert.deepEqual(
    await casFacade.apply(casSnapshot, { type: 'rename', speakerId: 'speaker-1', displayLabel: '主持人' }),
    { error: { category: 'conflict', message: '这项说话人修改已过期，请刷新后重试。', committed: false, requiresRefresh: true } }
  );
  assert.equal(casFixture.calls.filter(([method]) => method === 'renameSpeaker').length, 1);

  const sourceFixture = managerFixture();
  const { facade: sourceFacade, snapshot: sourceSnapshot } = await loadedFacade(sourceFixture);
  sourceFixture.fail('reassignSegments', codedError('SPEAKER_CORRECTION_SOURCE_STALE'));
  assert.deepEqual(
    await sourceFacade.apply(sourceSnapshot, { type: 'reassign', segmentIds: ['segment-3'], targetSpeakerId: 'unknown' }),
    { error: { category: 'source_changed', message: '会议转写或说话人识别已更新，请刷新后重试。', committed: false, requiresRefresh: true } }
  );
  assert.equal(sourceFixture.calls.filter(([method]) => method === 'reassignSegments').length, 1);
});

test('reports a changed-after-commit outcome safely and leaves integrity failures fail-closed', async () => {
  const changedFixture = managerFixture();
  const { facade: changedFacade, snapshot: changedSnapshot } = await loadedFacade(changedFixture);
  changedFixture.fail('renameSpeaker', codedError('SPEAKER_CORRECTION_SOURCE_CHANGED_AFTER_COMMIT', { committed: true, replayed: false }));
  assert.deepEqual(
    await changedFacade.apply(changedSnapshot, { type: 'rename', speakerId: 'speaker-1', displayLabel: '主持人' }),
    { error: { category: 'changed_after_commit', message: '修改已保存，但会议内容已更新；请刷新查看最新结果。', committed: true, requiresRefresh: true } }
  );

  const integrityFixture = managerFixture();
  integrityFixture.manager.getSpeakerProjection = async () => {
    throw codedError('SPEAKER_CORRECTION_PROJECTION_INTEGRITY_INVALID');
  };
  const integrityFacade = createFacade({ manager: integrityFixture.manager, cryptoImpl: cryptoIds() });
  await assert.rejects(
    () => integrityFacade.load({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID }),
    { code: 'SPEAKER_CORRECTION_PROJECTION_INTEGRITY_INVALID' }
  );
});
