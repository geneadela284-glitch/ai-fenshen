import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  createTranscriptDocument,
  createTranscriptRevision,
  createTranscriptSegment
} from '../../../../core/meeting/stage3a/transcriptContracts.js';
import {
  createDiarizationRevision,
  createDiarizationSegment,
  createSpeakerRef
} from '../../../../core/meeting/stage3b/diarizationContracts.js';
import { mapDiarizationToTranscript } from '../../../../core/meeting/stage3b/diarizationMapping.js';
import { createMemoryMeetingSpeakerCorrectionBackend } from './meetingSpeakerCorrectionBackend.js';
import { createMeetingSpeakerCorrectionStore } from './meetingSpeakerCorrectionStore.js';

let managerModule = {};
try {
  managerModule = await import('./meetingSpeakerCorrectionManager.js');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const BASE_TIME = '2026-08-09T00:00:00.000Z';
const MEETING_ID = 'meeting-1';
const TRANSCRIPT_ID = 'transcript-1';
const SOURCE_ID = 'source-1';

function owner(ownerId = 'owner-a', spaceId = 'meeting-space') {
  return { trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId };
}

function clone(value) {
  return structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

async function rawSha256(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await webcrypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function rawSources(context = owner(), {
  transcriptRevision = 1,
  diarizationRevision = 1,
  diarizationRevisionId = 'diarization-1'
} = {}) {
  const document = createTranscriptDocument({
    ownerContext: context,
    transcriptId: TRANSCRIPT_ID,
    meetingId: MEETING_ID,
    sourceId: SOURCE_ID,
    sourceRevision: 1,
    transcriptRevision,
    provider: 'xfyun',
    model: 'role-separation',
    status: 'ready',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME
  });
  const segmentSpecs = [
    { sequence: 0, startMs: 0, endMs: 1_000, text: '现在开始会议。', speakerRef: 'speaker-1' },
    { sequence: 1, startMs: 1_000, endMs: 2_000, text: '先汇报第一项。', speakerRef: 'speaker-1' },
    { sequence: 2, startMs: 2_000, endMs: 3_000, text: '我补充说明。', speakerRef: 'speaker-2' },
    { sequence: 3, startMs: 3_000, endMs: 4_000, text: '这句暂时无法识别。', speakerRef: 'unknown' }
  ];
  const transcriptSegments = segmentSpecs.map((segment) => createTranscriptSegment({
    transcriptId: TRANSCRIPT_ID,
    transcriptRevision,
    sequence: segment.sequence,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    confidence: 0.9,
    speakerRef: segment.speakerRef === 'unknown' ? 'unknown' : null,
    sourceChunkRefs: [`chunk-${segment.sequence}`],
    revision: transcriptRevision
  }));
  const currentRevision = createTranscriptRevision({
    ownerContext: context,
    transcriptId: TRANSCRIPT_ID,
    meetingId: MEETING_ID,
    sourceId: SOURCE_ID,
    sourceRevision: 1,
    transcriptRevision,
    segments: transcriptSegments,
    createdAt: BASE_TIME,
    createdBy: 'system'
  });
  const transcript = Object.freeze({
    document,
    revisions: Object.freeze([currentRevision]),
    rawRevision: currentRevision,
    currentRevision
  });
  const speakerRefs = ['speaker-1', 'speaker-2'].map((speakerId) => createSpeakerRef({
    ownerContext: context,
    meetingId: MEETING_ID,
    speakerId,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    revision: diarizationRevision
  }));
  const diarizationSegments = segmentSpecs.map((segment, index) => createDiarizationSegment({
    meetingId: MEETING_ID,
    transcriptId: TRANSCRIPT_ID,
    transcriptRevision,
    transcriptSegmentId: transcriptSegments[index].segmentId,
    startMs: segment.startMs,
    endMs: segment.endMs,
    speakerRef: segment.speakerRef,
    confidence: segment.speakerRef === 'unknown' ? null : 0.9,
    source: segment.speakerRef === 'unknown' ? 'unknown' : 'provider_role_separation',
    revision: diarizationRevision
  }));
  const diarization = createDiarizationRevision({
    ownerContext: context,
    diarizationRevisionId,
    meetingId: MEETING_ID,
    transcriptId: TRANSCRIPT_ID,
    transcriptRevision,
    speakerRefs,
    segments: diarizationSegments,
    status: 'ready',
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
    revision: diarizationRevision
  });
  const diarizationDocument = Object.freeze({
    schemaVersion: 1,
    documentId: 'diarization-document-1',
    ownerId: context.ownerId,
    meetingId: MEETING_ID,
    transcriptId: TRANSCRIPT_ID,
    transcriptRevision,
    currentDiarizationRevisionId: diarization.diarizationRevisionId,
    currentRevision: diarizationRevision,
    updatedAt: BASE_TIME
  });
  return { transcript, diarization, diarizationDocument };
}

async function createKeyProvider() {
  const keys = new Map();
  const keyFor = async (context, version = 1) => {
    const locator = `${context.ownerId}\u0000${context.spaceId}\u0000${version}`;
    if (!keys.has(locator)) {
      keys.set(locator, webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
    }
    return keys.get(locator);
  };
  return Object.freeze({
    describe() { return { provider: 'test-production-key-provider', exportsKeys: false, available: true }; },
    async getKeyVersion() { return 1; },
    async withOwnerKey(context, callback) { return callback(await keyFor(context, context.keyVersion ?? 1)); }
  });
}

function createReadStores(context, sources) {
  const expectedOwnerId = context.ownerId;
  return {
    transcriptStore: Object.freeze({
      async getTranscript(receivedContext, input) {
        assert.equal(receivedContext.ownerId, expectedOwnerId);
        assert.deepEqual(input, { meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
        return clone(sources.transcript);
      }
    }),
    diarizationStore: Object.freeze({
      async getCurrentRevision(receivedContext, input) {
        assert.equal(receivedContext.ownerId, expectedOwnerId);
        assert.deepEqual(input, { meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID, transcriptRevision: 1 });
        return { document: clone(sources.diarizationDocument), revision: clone(sources.diarization) };
      }
    })
  };
}

function createSequencedReadStores(context, { transcripts, diarizations }) {
  let transcriptReads = 0;
  let diarizationReads = 0;
  const next = (values, index) => values[Math.min(index, values.length - 1)];
  return {
    transcriptStore: Object.freeze({
      async getTranscript(receivedContext, input) {
        assert.equal(receivedContext.ownerId, context.ownerId);
        assert.deepEqual(input, { meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
        return clone(next(transcripts, transcriptReads++));
      }
    }),
    diarizationStore: Object.freeze({
      async getCurrentRevision(receivedContext, input) {
        assert.equal(receivedContext.ownerId, context.ownerId);
        const value = next(diarizations, diarizationReads++);
        assert.deepEqual(input, {
          meetingId: MEETING_ID,
          transcriptId: TRANSCRIPT_ID,
          transcriptRevision: value.document.transcriptRevision
        });
        return { document: clone(value.document), revision: clone(value.revision) };
      }
    })
  };
}

function createDeferredReadStores(context, sources) {
  const base = createReadStores(context, sources);
  let release;
  let firstRead = true;
  const gate = new Promise((resolve) => { release = resolve; });
  return {
    release,
    readStores: {
      ...base,
      transcriptStore: Object.freeze({
        async getTranscript(receivedContext, input) {
          if (firstRead) {
            firstRead = false;
            await gate;
          }
          return base.transcriptStore.getTranscript(receivedContext, input);
        }
      })
    }
  };
}

function createManager(input) {
  assert.equal(
    typeof managerModule.createMeetingSpeakerCorrectionManager,
    'function',
    'Stage3B-B Phase3 Manager production export is not implemented'
  );
  return managerModule.createMeetingSpeakerCorrectionManager(input);
}

async function fixture({
  context = owner(),
  sources = rawSources(context),
  backend = createMemoryMeetingSpeakerCorrectionBackend(),
  keyProvider,
  readStores
} = {}) {
  const resolvedKeyProvider = keyProvider || await createKeyProvider();
  const speakerCorrectionStore = createMeetingSpeakerCorrectionStore({
    backend,
    keyProvider: resolvedKeyProvider,
    cryptoImpl: webcrypto
  });
  const resolvedReadStores = readStores || createReadStores(context, sources);
  let revisionSequence = 0;
  let timeSequence = 0;
  const manager = createManager({
    ownerContext: context,
    ...resolvedReadStores,
    speakerCorrectionStore,
    cryptoImpl: webcrypto,
    createCorrectionRevisionId: () => `correction-${++revisionSequence}`,
    now: () => `2026-08-09T00:${String(++timeSequence).padStart(2, '0')}:00.000Z`
  });
  return { manager, backend, keyProvider: resolvedKeyProvider, speakerCorrectionStore, sources, context, readStores: resolvedReadStores };
}

function mutationInput(overrides = {}) {
  return {
    meetingId: MEETING_ID,
    transcriptId: TRANSCRIPT_ID,
    expectedTranscriptRevision: 1,
    baseDiarizationRevisionId: 'diarization-1',
    expectedCorrectionRevision: 0,
    mutationRequestId: 'mutation-1',
    ...overrides
  };
}

test('no-correction read returns an immutable revision-0 projection without persisting the base', async () => {
  const setup = await fixture();
  const transcriptBefore = clone(setup.sources.transcript);
  const diarizationBefore = clone(setup.sources.diarization);

  const view = await setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });

  assert.equal(view.correctionRevision, 0);
  assert.equal(view.correctionRevisionId, null);
  assert.equal(view.hasCorrections, false);
  assert.match(view.baseDiarizationSnapshotHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(view.segments.map((segment) => segment.effectiveSpeaker.displayLabel), ['说话人1', '说话人1', '说话人2', '未识别说话人']);
  assert.equal(view.segments[0].rawSegment.speakerRef, null);
  assert.equal(view.segments[3].rawSegment.speakerRef, 'unknown');
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.segments[0].rawSegment), true);
  assert.equal(Object.isFrozen(view.segments[0].effectiveSpeaker), true);
  assert.deepEqual(setup.sources.transcript, transcriptBefore);
  assert.deepEqual(setup.sources.diarization, diarizationBefore);
  assert.deepEqual(setup.backend.dump(), { speakerCorrectionDocuments: [], speakerCorrectionRevisions: [] });
});

test('no-correction history exposes the ephemeral base and an empty immutable correction chain', async () => {
  const setup = await fixture();

  assert.equal(typeof setup.manager.getCorrectionHistory, 'function');
  const history = await setup.manager.getCorrectionHistory({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });

  assert.equal(history.baseRevision.correctionRevision, 0);
  assert.equal(history.currentCorrectionRevision, 0);
  assert.deepEqual(history.correctionRevisions, []);
  assert.equal(Object.isFrozen(history), true);
  assert.equal(Object.isFrozen(history.baseRevision), true);
  assert.equal(Object.isFrozen(history.correctionRevisions), true);
  assert.deepEqual(setup.backend.dump(), { speakerCorrectionDocuments: [], speakerCorrectionRevisions: [] });
});

test('renameSpeaker creates revision 1 through the real core and encrypted Store then returns the effective projection', async () => {
  const setup = await fixture();
  const transcriptBefore = clone(setup.sources.transcript);
  const diarizationBefore = clone(setup.sources.diarization);

  assert.equal(typeof setup.manager.renameSpeaker, 'function');
  const result = await setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: ' 主持人 ' }));

  assert.equal(result.replayed, false);
  assert.equal(result.revision.correctionRevision, 1);
  assert.equal(result.revision.audit.operation, 'rename');
  assert.equal(result.revision.speakerRefs[0].displayLabel, '主持人');
  assert.equal(result.appliedRevisionProjection.correctionRevision, 1);
  assert.deepEqual(result.appliedRevisionProjection.segments.slice(0, 2).map((segment) => segment.effectiveSpeaker.displayLabel), ['主持人', '主持人']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.appliedRevisionProjection.segments[0]), true);
  assert.deepEqual(setup.sources.transcript, transcriptBefore);
  assert.deepEqual(setup.sources.diarization, diarizationBefore);
  const dump = setup.backend.dump();
  assert.equal(dump.speakerCorrectionDocuments.length, 1);
  assert.equal(dump.speakerCorrectionRevisions.length, 1);
  assert.equal(dump.speakerCorrectionRevisions.some((row) => row.correctionRevision === 0), false);
});

test('projection keeps raw Transcript and Raw Diarization speaker facts separate while using the pinned trusted OwnerContext', async () => {
  const mutableContext = owner();
  const setup = await fixture({ context: mutableContext, sources: rawSources(mutableContext) });
  mutableContext.ownerId = 'owner-forged-after-construction';
  mutableContext.sessionId = 'session-forged-after-construction';

  const view = await setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });

  assert.deepEqual(view.segments[0].rawDiarization, {
    speakerRef: 'speaker-1',
    confidence: 0.9,
    source: 'provider_role_separation'
  });
  assert.deepEqual(view.segments[3].rawDiarization, {
    speakerRef: 'unknown',
    confidence: null,
    source: 'unknown'
  });
  assert.equal(view.segments[0].rawSegment.speakerRef, null);
  assert.equal(view.segments[0].effectiveSpeaker.speakerRef, 'speaker-1');
  assert.equal(Object.isFrozen(view.segments[0].rawDiarization), true);
});

test('projection strips unknown Transcript payload fields at the Manager boundary', async () => {
  const context = owner();
  const sources = rawSources(context);
  sources.transcript = clone(sources.transcript);
  sources.transcript.document.untrustedDocumentPayload = { providerSecret: 'document-secret' };
  sources.transcript.currentRevision.untrustedRevisionPayload = { providerSecret: 'revision-secret' };
  sources.transcript.currentRevision.segments[0].untrustedSegmentPayload = { providerSecret: 'segment-secret' };
  const setup = await fixture({ context, sources });

  const view = await setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });

  assert.equal(Object.hasOwn(view.segments[0].rawSegment, 'untrustedSegmentPayload'), false);
  assert.equal(JSON.stringify(view).includes('provider-secret'), false);
  assert.equal(view.segments[0].rawSegment.text, '现在开始会议。');
});

test('history validates the complete stored chain from the reconstructed base and supports base, historical, and head projections', async () => {
  const setup = await fixture();
  await setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }));

  const history = await setup.manager.getCorrectionHistory({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  const baseView = await setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID, correctionRevision: 0 });
  const revisionView = await setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID, correctionRevision: 1 });
  const headView = await setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });

  assert.equal(history.baseRevision.correctionRevision, 0);
  assert.deepEqual(history.correctionRevisions.map((revision) => revision.correctionRevision), [1]);
  assert.equal(history.currentCorrectionRevision, 1);
  assert.equal(history.correctionRevisions[0].parentCorrectionRevisionId, null);
  assert.equal(baseView.segments[0].effectiveSpeaker.displayLabel, '说话人1');
  assert.equal(revisionView.segments[0].effectiveSpeaker.displayLabel, '主持人');
  assert.deepEqual(headView, revisionView);
  assert.equal(Object.isFrozen(history.correctionRevisions[0].audit), true);
});

test('mergeSpeakers uses the authoritative stored head and keeps merged profiles and unknown assignments auditable', async () => {
  const setup = await fixture();
  await setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }));

  assert.equal(typeof setup.manager.mergeSpeakers, 'function');
  const result = await setup.manager.mergeSpeakers(mutationInput({
    expectedCorrectionRevision: 1,
    mutationRequestId: 'mutation-2',
    speakerIds: ['speaker-1', 'speaker-2'],
    targetSpeakerId: 'speaker-1'
  }));

  assert.equal(result.revision.correctionRevision, 2);
  assert.equal(result.revision.audit.operation, 'merge');
  assert.deepEqual(result.revision.speakerRefs.find((speaker) => speaker.speakerId === 'speaker-2'), {
    speakerId: 'speaker-2',
    displayLabel: '说话人2',
    labelSource: 'provider_anonymous',
    state: 'merged',
    mergedIntoSpeakerId: 'speaker-1'
  });
  assert.deepEqual(result.appliedRevisionProjection.segments.map((segment) => segment.effectiveSpeaker.speakerRef), ['speaker-1', 'speaker-1', 'speaker-1', 'unknown']);
  assert.equal(result.appliedRevisionProjection.segments[3].effectiveSpeaker.displayLabel, '未识别说话人');
});

test('splitSpeaker moves only selected complete segment IDs to the next anonymous ordinal without changing timeline', async () => {
  const setup = await fixture();
  const secondSegmentId = setup.sources.transcript.currentRevision.segments[1].segmentId;

  assert.equal(typeof setup.manager.splitSpeaker, 'function');
  const result = await setup.manager.splitSpeaker(mutationInput({
    speakerId: 'speaker-1',
    transcriptSegmentIds: [secondSegmentId]
  }));

  assert.equal(result.revision.audit.operation, 'split');
  assert.equal(result.revision.nextSpeakerOrdinal, 4);
  assert.deepEqual(result.revision.speakerRefs.at(-1), {
    speakerId: 'speaker-3',
    displayLabel: '说话人3',
    labelSource: 'provider_anonymous',
    state: 'active',
    mergedIntoSpeakerId: null
  });
  assert.equal(result.appliedRevisionProjection.segments[0].effectiveSpeaker.speakerRef, 'speaker-1');
  assert.equal(result.appliedRevisionProjection.segments[1].effectiveSpeaker.speakerRef, 'speaker-3');
  assert.deepEqual(
    result.appliedRevisionProjection.segments.map(({ rawSegment }) => [rawSegment.segmentId, rawSegment.startMs, rawSegment.endMs]),
    setup.sources.transcript.currentRevision.segments.map((segment) => [segment.segmentId, segment.startMs, segment.endMs])
  );
});

test('reassignSegments can explicitly preserve unknown and audits only assignments that changed', async () => {
  const setup = await fixture();
  const [firstSegment, , , unknownSegment] = setup.sources.transcript.currentRevision.segments;

  assert.equal(typeof setup.manager.reassignSegments, 'function');
  const result = await setup.manager.reassignSegments(mutationInput({
    transcriptSegmentIds: [firstSegment.segmentId, unknownSegment.segmentId],
    targetSpeakerId: 'unknown'
  }));

  assert.equal(result.revision.audit.operation, 'reassign');
  assert.deepEqual(result.revision.audit.changes, [{
    transcriptSegmentIds: [firstSegment.segmentId],
    targetSpeakerId: 'unknown'
  }]);
  assert.deepEqual(
    result.appliedRevisionProjection.segments.map((segment) => segment.effectiveSpeaker.speakerRef),
    ['unknown', 'speaker-1', 'speaker-2', 'unknown']
  );
  assert.deepEqual(result.appliedRevisionProjection.speakerRefs, result.revision.speakerRefs);
  assert.deepEqual(result.appliedRevisionProjection.segments[3].rawDiarization, {
    speakerRef: 'unknown',
    confidence: null,
    source: 'unknown'
  });
});

test('projection fails closed when the Diarization document head does not bind the returned revision', async () => {
  const context = owner();
  const sources = rawSources(context);
  sources.diarizationDocument = {
    ...sources.diarizationDocument,
    currentDiarizationRevisionId: 'different-diarization-head'
  };
  const setup = await fixture({ context, sources });

  await assert.rejects(
    () => setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID }),
    { code: 'SPEAKER_CORRECTION_DIARIZATION_DOCUMENT_BINDING_INVALID' }
  );
});

test('factory fixes the trusted context to canonical meeting-space and public methods enforce exact typed input shapes', async () => {
  assert.throws(
    () => createManager({ ownerContext: owner('owner-a', 'other-space') }),
    { code: 'SPEAKER_CORRECTION_CANONICAL_SPACE_REQUIRED' }
  );

  const setup = await fixture();
  await assert.rejects(
    () => setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID, ownerId: 'owner-b' }),
    { code: 'SPEAKER_CORRECTION_MANAGER_REQUEST_SHAPE_INVALID' }
  );
  const attempts = [
    () => setup.manager.renameSpeaker({ ...mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }), transcriptSegmentIds: [] }),
    () => setup.manager.mergeSpeakers({ ...mutationInput({ speakerIds: ['speaker-1', 'speaker-2'], targetSpeakerId: 'speaker-1' }), displayLabel: '主持人' }),
    () => setup.manager.splitSpeaker({ ...mutationInput({ speakerId: 'speaker-1', transcriptSegmentIds: ['segment'] }), targetSpeakerId: 'speaker-2' }),
    () => setup.manager.reassignSegments({ ...mutationInput({ transcriptSegmentIds: ['segment'], targetSpeakerId: 'unknown' }), speakerId: 'speaker-1' })
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt, { code: 'SPEAKER_CORRECTION_MANAGER_REQUEST_SHAPE_INVALID' });
  }
  assert.deepEqual(setup.backend.dump(), { speakerCorrectionDocuments: [], speakerCorrectionRevisions: [] });
});

test('base Diarization binding uses a canonical domain-separated SHA-256 snapshot hash', async () => {
  const first = await fixture();
  const firstView = await first.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  const reorderedSources = rawSources(first.context);
  reorderedSources.diarization = Object.fromEntries(Object.entries(reorderedSources.diarization).reverse());
  const reordered = await fixture({ context: first.context, sources: reorderedSources });
  const reorderedView = await reordered.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  const changedSources = rawSources(first.context);
  changedSources.diarization = clone(changedSources.diarization);
  changedSources.diarization.segments[0].speakerRef = 'speaker-2';
  const changed = await fixture({ context: first.context, sources: changedSources });
  const changedView = await changed.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });

  assert.equal(firstView.baseDiarizationSnapshotHash, reorderedView.baseDiarizationSnapshotHash);
  assert.notEqual(firstView.baseDiarizationSnapshotHash, changedView.baseDiarizationSnapshotHash);
  assert.notEqual(firstView.baseDiarizationSnapshotHash, await rawSha256(first.sources.diarization));
});

test('source projection requires exact Diarization shape and an exact segment ID/time join to Raw Transcript', async () => {
  const cases = [
    {
      mutate(sources) { sources.diarization.untrustedField = true; },
      code: 'SPEAKER_CORRECTION_DIARIZATION_SHAPE_INVALID'
    },
    {
      mutate(sources) { sources.diarization.segments[0].transcriptSegmentId = 'different-segment'; },
      code: 'SPEAKER_CORRECTION_SOURCE_SEGMENT_MISMATCH'
    },
    {
      mutate(sources) { sources.diarization.segments[0].endMs = 999; },
      code: 'SPEAKER_CORRECTION_SOURCE_SEGMENT_MISMATCH'
    }
  ];
  for (const scenario of cases) {
    const context = owner();
    const sources = rawSources(context);
    sources.diarization = clone(sources.diarization);
    scenario.mutate(sources);
    const setup = await fixture({ context, sources });
    await assert.rejects(
      () => setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID }),
      { code: scenario.code }
    );
  }
});

test('one physical correction backend remains owner scoped for identical meeting and transcript IDs', async () => {
  const backend = createMemoryMeetingSpeakerCorrectionBackend();
  const keyProvider = await createKeyProvider();
  const contextA = owner('owner-a');
  const contextB = owner('owner-b');
  const ownerA = await fixture({ context: contextA, sources: rawSources(contextA), backend, keyProvider });
  const ownerB = await fixture({ context: contextB, sources: rawSources(contextB), backend, keyProvider });

  await ownerA.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '甲方主持人' }));
  const viewA = await ownerA.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  const viewB = await ownerB.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });

  assert.equal(viewA.segments[0].effectiveSpeaker.displayLabel, '甲方主持人');
  assert.equal(viewB.correctionRevision, 0);
  assert.equal(viewB.segments[0].effectiveSpeaker.displayLabel, '说话人1');
  assert.equal(backend.dump().speakerCorrectionDocuments.length, 1);
});

test('stored correction binding rejects a changed Raw Diarization snapshot under the same revision identity', async () => {
  const setup = await fixture();
  await setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }));
  setup.sources.diarization = clone(setup.sources.diarization);
  setup.sources.diarization.segments[0].speakerRef = 'speaker-2';

  await assert.rejects(
    () => setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID }),
    { code: 'SPEAKER_CORRECTION_PROJECTION_BINDING_INVALID' }
  );
});

test('only DOCUMENT_NOT_FOUND becomes revision 0; encrypted document corruption fails closed', async () => {
  const setup = await fixture();
  await setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }));
  const row = setup.backend.dump().speakerCorrectionDocuments[0];
  const ciphertext = new Uint8Array(row.ciphertext);
  ciphertext[0] ^= 1;
  setup.backend.replace('speakerCorrectionDocuments', row.id, {
    ...row,
    ciphertext
  });

  await assert.rejects(
    () => setup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID }),
    { code: 'SPEAKER_CORRECTION_CIPHERTEXT_INVALID' }
  );
  assert.equal(setup.backend.dump().speakerCorrectionRevisions.length, 1);
});

test('history reads the full chain and rejects an absent historical revision before projecting the head', async () => {
  const setup = await fixture();
  await setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }));
  await setup.manager.mergeSpeakers(mutationInput({
    expectedCorrectionRevision: 1,
    mutationRequestId: 'mutation-2',
    speakerIds: ['speaker-1', 'speaker-2'],
    targetSpeakerId: 'speaker-1'
  }));
  const firstRow = setup.backend.dump().speakerCorrectionRevisions.find((row) => row.correctionRevision === 1);
  setup.backend.deleteDirect('speakerCorrectionRevisions', firstRow.id);
  let listCalls = 0;
  const corruptedStore = Object.freeze({
    readDocument: (input) => setup.speakerCorrectionStore.readDocument(input),
    async listRevisions(input) {
      listCalls += 1;
      return setup.speakerCorrectionStore.listRevisions(input);
    },
    appendRevision: (input) => setup.speakerCorrectionStore.appendRevision(input)
  });
  const manager = createManager({
    ownerContext: setup.context,
    ...setup.readStores,
    speakerCorrectionStore: corruptedStore,
    cryptoImpl: webcrypto
  });

  await assert.rejects(
    () => manager.getCorrectionHistory({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID }),
    { code: 'SPEAKER_CORRECTION_STORED_CHAIN_INVALID' }
  );
  assert.equal(listCalls, 2);
});

test('response-loss retry rebuilds the same intent from its historical parent and Store returns the original revision', async () => {
  const setup = await fixture();
  const input = mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' });
  const first = await setup.manager.renameSpeaker(input);
  await setup.manager.renameSpeaker(mutationInput({
    expectedCorrectionRevision: 1,
    mutationRequestId: 'mutation-head',
    speakerId: 'speaker-2',
    displayLabel: '记录员'
  }));
  const retry = await setup.manager.renameSpeaker(input);

  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.deepEqual(retry.revision, first.revision);
  assert.equal(Object.hasOwn(retry, 'projection'), false);
  assert.equal(retry.appliedRevisionProjection.correctionRevision, 1);
  assert.equal(retry.appliedRevisionProjection.segments[0].effectiveSpeaker.displayLabel, '主持人');
  assert.equal(setup.backend.dump().speakerCorrectionRevisions.length, 2);
  assert.equal(
    (await setup.manager.getCorrectionHistory({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID })).currentCorrectionRevision,
    2
  );

  await assert.rejects(
    () => setup.manager.renameSpeaker({ ...input, displayLabel: '不同意图' }),
    { code: 'SPEAKER_CORRECTION_MUTATION_REQUEST_CONFLICT' }
  );
  await assert.rejects(
    () => setup.manager.renameSpeaker({ ...input, mutationRequestId: 'mutation-2' }),
    { code: 'SPEAKER_CORRECTION_FINGERPRINT_CONFLICT' }
  );
});

test('concurrent writers use head CAS once and Manager never auto-retries a losing mutation', async () => {
  const setup = await fixture();
  const results = await Promise.allSettled([
    setup.manager.renameSpeaker(mutationInput({ mutationRequestId: 'mutation-a', speakerId: 'speaker-1', displayLabel: '甲' })),
    setup.manager.renameSpeaker(mutationInput({ mutationRequestId: 'mutation-b', speakerId: 'speaker-1', displayLabel: '乙' }))
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'SPEAKER_CORRECTION_CAS_CONFLICT').length, 1);
  assert.equal(setup.backend.dump().speakerCorrectionRevisions.length, 1);
  const history = await setup.manager.getCorrectionHistory({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  assert.equal(history.currentCorrectionRevision, 1);
});

test('reopen with the same Owner DEK recovers the encrypted correction head and complete history', async () => {
  const setup = await fixture();
  await setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }));
  await setup.manager.reassignSegments(mutationInput({
    expectedCorrectionRevision: 1,
    mutationRequestId: 'mutation-2',
    transcriptSegmentIds: [setup.sources.transcript.currentRevision.segments[2].segmentId],
    targetSpeakerId: 'speaker-1'
  }));
  const reopened = await fixture({
    context: setup.context,
    sources: setup.sources,
    backend: setup.backend.reopen(),
    keyProvider: setup.keyProvider
  });

  const view = await reopened.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  const history = await reopened.manager.getCorrectionHistory({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  assert.equal(view.correctionRevision, 2);
  assert.deepEqual(view.segments.slice(0, 3).map((segment) => segment.effectiveSpeaker.speakerRef), ['speaker-1', 'speaker-1', 'speaker-1']);
  assert.deepEqual(history.correctionRevisions.map((revision) => revision.correctionRevision), [1, 2]);
});

test('accepts the real Stage3B-A mapped revision while excluding providerRoleMap from correction binding and projection', async () => {
  const context = owner();
  const mappedSources = rawSources(context);
  const mapped = mapDiarizationToTranscript({
    ownerContext: context,
    transcriptRevision: mappedSources.transcript.currentRevision,
    providerSegments: [
      { startMs: 0, endMs: 1_000, providerRole: 10, confidence: 0.9 },
      { startMs: 1_000, endMs: 2_000, providerRole: 10, confidence: 0.9 },
      { startMs: 2_000, endMs: 3_000, providerRole: 20, confidence: 0.8 },
      { startMs: 3_000, endMs: 4_000, providerRole: 'unknown', confidence: null }
    ],
    diarizationRevisionId: 'diarization-1',
    diarizationRevision: 1,
    now: BASE_TIME
  });
  assert.deepEqual(mapped.providerRoleMap, { 10: 'speaker-1', 20: 'speaker-2' });
  mappedSources.diarization = mapped;
  const mappedSetup = await fixture({ context, sources: mappedSources });
  const mappedView = await mappedSetup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  const mappedHistory = await mappedSetup.manager.getCorrectionHistory({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });

  const strippedSources = rawSources(context);
  const { providerRoleMap: ignoredProviderPayload, ...strippedRevision } = clone(mapped);
  assert.deepEqual(ignoredProviderPayload, { 10: 'speaker-1', 20: 'speaker-2' });
  strippedSources.diarization = strippedRevision;
  const strippedSetup = await fixture({ context, sources: strippedSources });
  const strippedView = await strippedSetup.manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });

  assert.equal(mappedView.baseDiarizationSnapshotHash, strippedView.baseDiarizationSnapshotHash);
  assert.equal(JSON.stringify(mappedView).includes('providerRoleMap'), false);
  assert.equal(JSON.stringify(mappedHistory.baseRevision).includes('providerRoleMap'), false);
  const renamed = await mappedSetup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }));
  assert.equal(JSON.stringify(renamed.revision).includes('providerRoleMap'), false);
});

test('mutation fails closed with zero correction rows when Raw Transcript or Diarization head changes before append', async () => {
  const scenarios = [
    {
      name: 'Transcript head',
      create(context) {
        const initial = rawSources(context);
        const changed = rawSources(context, {
          transcriptRevision: 2,
          diarizationRevision: 2,
          diarizationRevisionId: 'diarization-2'
        });
        return {
          initial,
          readStores: createSequencedReadStores(context, {
            transcripts: [initial.transcript, changed.transcript],
            diarizations: [
              { document: initial.diarizationDocument, revision: initial.diarization },
              { document: changed.diarizationDocument, revision: changed.diarization }
            ]
          })
        };
      }
    },
    {
      name: 'Diarization head',
      create(context) {
        const initial = rawSources(context);
        const changed = rawSources(context, {
          diarizationRevision: 2,
          diarizationRevisionId: 'diarization-2'
        });
        return {
          initial,
          readStores: createSequencedReadStores(context, {
            transcripts: [initial.transcript, initial.transcript],
            diarizations: [
              { document: initial.diarizationDocument, revision: initial.diarization },
              { document: changed.diarizationDocument, revision: changed.diarization }
            ]
          })
        };
      }
    }
  ];

  for (const scenario of scenarios) {
    const context = owner();
    const controlled = scenario.create(context);
    const setup = await fixture({ context, sources: controlled.initial, readStores: controlled.readStores });
    await assert.rejects(
      () => setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: scenario.name })),
      { code: 'SPEAKER_CORRECTION_SOURCE_STALE' }
    );
    assert.deepEqual(setup.backend.dump(), { speakerCorrectionDocuments: [], speakerCorrectionRevisions: [] });
  }
});

test('expectedTranscriptRevision is a positive optimistic token and rejects zero before persistence', async () => {
  const setup = await fixture();
  await assert.rejects(
    () => setup.manager.renameSpeaker(mutationInput({
      expectedTranscriptRevision: 0,
      speakerId: 'speaker-1',
      displayLabel: '主持人'
    })),
    { code: 'SPEAKER_CORRECTION_EXPECTED_TRANSCRIPT_REVISION_INVALID' }
  );
  assert.deepEqual(setup.backend.dump(), { speakerCorrectionDocuments: [], speakerCorrectionRevisions: [] });
});

test('identical concurrent Manager mutations produce one commit and one replay of the same stored revision', async () => {
  const setup = await fixture();
  const input = mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' });
  const results = await Promise.all([
    setup.manager.renameSpeaker(input),
    setup.manager.renameSpeaker(input)
  ]);

  assert.deepEqual(results.map((result) => result.replayed).sort(), [false, true]);
  assert.deepEqual(results[0].revision, results[1].revision);
  assert.equal(setup.backend.dump().speakerCorrectionRevisions.length, 1);
});

test('authoritative history read observes a valid append before its single revision listing', async () => {
  const setup = await fixture();
  await setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }));
  let raced = false;
  const racingStore = Object.freeze({
    readDocument: (input) => setup.speakerCorrectionStore.readDocument(input),
    async listRevisions(input) {
      if (!raced) {
        raced = true;
        await setup.manager.renameSpeaker(mutationInput({
          expectedCorrectionRevision: 1,
          mutationRequestId: 'mutation-race',
          speakerId: 'speaker-2',
          displayLabel: '记录员'
        }));
      }
      return setup.speakerCorrectionStore.listRevisions(input);
    },
    appendRevision: (input) => setup.speakerCorrectionStore.appendRevision(input)
  });
  const manager = createManager({
    ownerContext: setup.context,
    ...setup.readStores,
    speakerCorrectionStore: racingStore,
    cryptoImpl: webcrypto,
    createCorrectionRevisionId: () => 'unused-race-revision',
    now: () => BASE_TIME
  });

  const view = await manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  assert.equal(view.correctionRevision, 2);
  assert.equal(view.segments[0].effectiveSpeaker.displayLabel, '主持人');
  assert.equal(view.segments[2].effectiveSpeaker.displayLabel, '记录员');
});

test('mutation never returns an old projection when the source changes immediately after correction commit', async () => {
  const context = owner();
  const initial = rawSources(context);
  const changed = rawSources(context, {
    diarizationRevision: 2,
    diarizationRevisionId: 'diarization-2'
  });
  const readStores = createSequencedReadStores(context, {
    transcripts: [initial.transcript, initial.transcript, initial.transcript],
    diarizations: [
      { document: initial.diarizationDocument, revision: initial.diarization },
      { document: initial.diarizationDocument, revision: initial.diarization },
      { document: changed.diarizationDocument, revision: changed.diarization }
    ]
  });
  const setup = await fixture({ context, sources: initial, readStores });

  await assert.rejects(
    () => setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' })),
    {
      code: 'SPEAKER_CORRECTION_SOURCE_CHANGED_AFTER_COMMIT',
      details: {
        committed: true,
        replayed: false,
        correctionRevisionId: 'correction-1',
        correctionRevision: 1
      }
    }
  );
  assert.equal(setup.backend.dump().speakerCorrectionDocuments.length, 1);
  assert.equal(setup.backend.dump().speakerCorrectionRevisions.length, 1);
});

test('Manager snapshots every public DTO before the first await, including nested arrays and read revision selectors', async () => {
  {
    const context = owner();
    const sources = rawSources(context);
    const deferred = createDeferredReadStores(context, sources);
    const setup = await fixture({ context, sources, readStores: deferred.readStores });
    const input = mutationInput({ speakerId: 'speaker-1', displayLabel: '调用瞬间名称' });
    const pending = setup.manager.renameSpeaker(input);
    input.displayLabel = 'await后篡改名称';
    deferred.release();
    const result = await pending;
    assert.equal(result.revision.speakerRefs[0].displayLabel, '调用瞬间名称');
  }

  {
    const context = owner();
    const sources = rawSources(context);
    const deferred = createDeferredReadStores(context, sources);
    const setup = await fixture({ context, sources, readStores: deferred.readStores });
    const originalSegmentId = sources.transcript.currentRevision.segments[0].segmentId;
    const input = mutationInput({
      transcriptSegmentIds: [originalSegmentId],
      targetSpeakerId: 'speaker-2'
    });
    const pending = setup.manager.reassignSegments(input);
    input.transcriptSegmentIds[0] = sources.transcript.currentRevision.segments[1].segmentId;
    deferred.release();
    const result = await pending;
    assert.deepEqual(result.revision.audit.changes[0].transcriptSegmentIds, [originalSegmentId]);
  }

  {
    const seeded = await fixture();
    await seeded.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }));
    await seeded.manager.renameSpeaker(mutationInput({
      expectedCorrectionRevision: 1,
      mutationRequestId: 'mutation-2',
      speakerId: 'speaker-2',
      displayLabel: '记录员'
    }));
    const deferred = createDeferredReadStores(seeded.context, seeded.sources);
    const manager = createManager({
      ownerContext: seeded.context,
      ...deferred.readStores,
      speakerCorrectionStore: seeded.speakerCorrectionStore,
      cryptoImpl: webcrypto
    });
    const input = { meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID, correctionRevision: 1 };
    const pending = manager.getSpeakerProjection(input);
    input.correctionRevision = 2;
    deferred.release();
    const view = await pending;
    assert.equal(view.correctionRevision, 1);
  }
});

test('public DTO clone failure maps to stable Manager request-shape error without persistence', async () => {
  const setup = await fixture();
  await assert.rejects(
    () => setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: () => 'not-cloneable' })),
    { code: 'SPEAKER_CORRECTION_MANAGER_REQUEST_SHAPE_INVALID' }
  );
  assert.deepEqual(setup.backend.dump(), { speakerCorrectionDocuments: [], speakerCorrectionRevisions: [] });
});

test('one transient stored-chain read is retried once with a complete authoritative list', async () => {
  const setup = await fixture();
  await setup.manager.renameSpeaker(mutationInput({ speakerId: 'speaker-1', displayLabel: '主持人' }));
  let listCalls = 0;
  const transientStore = Object.freeze({
    readDocument: (input) => setup.speakerCorrectionStore.readDocument(input),
    async listRevisions(input) {
      listCalls += 1;
      if (listCalls === 1) {
        const error = new Error('SPEAKER_CORRECTION_STORED_CHAIN_INVALID');
        error.code = 'SPEAKER_CORRECTION_STORED_CHAIN_INVALID';
        throw error;
      }
      return setup.speakerCorrectionStore.listRevisions(input);
    },
    appendRevision: (input) => setup.speakerCorrectionStore.appendRevision(input)
  });
  const manager = createManager({
    ownerContext: setup.context,
    ...setup.readStores,
    speakerCorrectionStore: transientStore,
    cryptoImpl: webcrypto
  });

  const view = await manager.getSpeakerProjection({ meetingId: MEETING_ID, transcriptId: TRANSCRIPT_ID });
  assert.equal(view.correctionRevision, 1);
  assert.equal(listCalls, 2);
});
