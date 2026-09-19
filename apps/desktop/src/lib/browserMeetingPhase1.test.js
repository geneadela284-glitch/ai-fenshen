import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';

import { createBrowserMeetingPhase1Manager } from './browserMeetingPhase1.js';
import { createMemoryMeetingBackend } from './browserMeetingStore.js';
import { createMeetingTranscriptStore } from './meetingTranscriptStore.js';
import { createMeetingDiarizationStore } from './meetingDiarizationStore.js';
import { createMemoryMeetingSpeakerCorrectionBackend } from './meetingSpeakerCorrectionBackend.js';
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

const capabilities = Object.freeze({
  productionReady: false,
  capabilities: Object.freeze({
    webCryptoAesGcm: true,
    nonExportableKeyHandle: true,
    indexedDb: true,
    persistentCryptoKey: true
  }),
  errorCodes: Object.freeze({})
});

function keyStorage() {
  const records = new Map();
  return {
    records,
    available: true,
    async getOrCreateDeviceBindingId() { return 'synthetic-device-binding'; },
    async listKeys() { return [...records.values()]; },
    async putKey(record) { records.set(record.recordId, structuredClone(record)); }
  };
}

function context(ownerId = 'synthetic-owner') {
  return Object.freeze({
    trusted: true,
    ownerId,
    sessionId: `synthetic-session-${ownerId}`,
    spaceId: 'meeting-space'
  });
}

function manager(storage, backend, initializeSyntheticOwnerKey = false, overrides = {}) {
  return createBrowserMeetingPhase1Manager({
    ownerContext: overrides.ownerContext || context(),
    cryptoImpl: webcrypto,
    keyStorage: storage,
    capabilities,
    backend,
    initializeSyntheticOwnerKey,
    keyProvider: overrides.keyProvider || null,
    speakerCorrectionBackend: overrides.speakerCorrectionBackend || null,
    recorderOptions: overrides.recorderOptions || {}
  });
}

class CompositionTrack {
  stopCalls = 0;

  stop() {
    this.stopCalls += 1;
  }
}

class CompositionStream {
  constructor() {
    this.track = new CompositionTrack();
  }

  getTracks() {
    return [this.track];
  }
}

class CompositionMediaRecorder {
  static instances = [];

  static isTypeSupported() {
    return true;
  }

  constructor(stream, options = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType || 'audio/webm;codecs=opus';
    this.state = 'inactive';
    this.stopCalls = 0;
    CompositionMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
    queueMicrotask(() => this.onstart?.());
  }

  stop() {
    if (this.state === 'inactive') return;
    this.stopCalls += 1;
    this.state = 'inactive';
    queueMicrotask(() => this.onstop?.());
  }
}

function lifecycleTarget() {
  const listeners = new Map();
  return {
    hidden: false,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); }
  };
}

async function compositionKeyProvider() {
  const key = await webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return Object.freeze({
    describe() { return { provider: 'composition-test-provider', exportsKeys: false, available: true }; },
    async getKeyVersion() { return 1; },
    async withOwnerKey(_ownerContext, callback) { return callback(key); }
  });
}

async function seedSpeakerSources({ backend, keyProvider, ownerContext }) {
  const transcriptId = 'composition-transcript';
  const meetingId = 'composition-meeting';
  const sourceId = 'composition-source';
  const transcriptSegment = createTranscriptSegment({
    transcriptId,
    transcriptRevision: 1,
    sequence: 0,
    startMs: 0,
    endMs: 1_000,
    text: '组合根测试内容。',
    confidence: 0.9,
    speakerRef: null,
    sourceChunkRefs: ['composition-chunk'],
    revision: 1
  });
  const document = createTranscriptDocument({
    ownerContext,
    transcriptId,
    meetingId,
    sourceId,
    sourceRevision: 1,
    provider: 'composition-fixture',
    model: 'composition-v1',
    status: 'ready',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z'
  });
  const transcriptRevision = createTranscriptRevision({
    ownerContext,
    transcriptId,
    meetingId,
    sourceId,
    sourceRevision: 1,
    transcriptRevision: 1,
    segments: [transcriptSegment],
    createdAt: '2026-08-10T00:00:00.000Z',
    createdBy: 'system'
  });
  const transcriptStore = createMeetingTranscriptStore({ cryptoImpl: webcrypto, keyProvider, backend });
  await transcriptStore.createRawTranscript(ownerContext, {
    source: {
      sourceId,
      meetingId,
      ownerId: ownerContext.ownerId,
      scope: 'meeting',
      origin: 'imported',
      importState: 'committed',
      revision: 1,
      checksum: 'a'.repeat(64)
    },
    document,
    revision: transcriptRevision
  });

  const speaker = createSpeakerRef({
    ownerContext,
    meetingId,
    speakerId: 'speaker-1',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z'
  });
  const diarizationSegment = createDiarizationSegment({
    meetingId,
    transcriptId,
    transcriptRevision: 1,
    transcriptSegmentId: transcriptSegment.segmentId,
    startMs: 0,
    endMs: 1_000,
    speakerRef: speaker.speakerId,
    confidence: 0.9,
    source: 'provider_role_separation',
    revision: 1
  });
  const diarizationRevision = createDiarizationRevision({
    ownerContext,
    diarizationRevisionId: 'composition-diarization-1',
    meetingId,
    transcriptId,
    transcriptRevision: 1,
    speakerRefs: [speaker],
    segments: [diarizationSegment],
    status: 'ready',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    revision: 1
  });
  const diarizationStore = createMeetingDiarizationStore({ cryptoImpl: webcrypto, keyProvider, backend });
  await diarizationStore.saveRevision(ownerContext, diarizationRevision);
  return { meetingId, transcriptId, diarizationRevision };
}

test('missing owner key remains fail-closed instead of creating a half-committed meeting', async () => {
  const storage = keyStorage();
  const phase1 = await manager(storage, createMemoryMeetingBackend());
  await phase1.initialize();
  await assert.rejects(
    () => phase1.createMeeting({ title: 'synthetic-missing-key' }),
    (error) => error?.code === 'KEY_NOT_FOUND'
  );
  assert.equal(storage.records.size, 0);
});

test('synthetic candidate initialization prepares the existing provider and creates a ready meeting', async () => {
  const storage = keyStorage();
  const phase1 = await manager(storage, createMemoryMeetingBackend(), true);
  await phase1.initialize();
  assert.equal(typeof phase1.diarization?.startDiarization, 'function');
  const created = await phase1.createMeeting({ title: 'synthetic-key-ready' });
  assert.equal(created.meeting.recordingState, 'ready');
  assert.equal(storage.records.size, 1);

  const reopened = await manager(storage, createMemoryMeetingBackend(), true);
  await reopened.initialize();
  assert.equal(storage.records.size, 1);
});

test('browser composition exposes the existing encrypted Analysis Bundle store without a second storage backend', async () => {
  const storage = keyStorage();
  const backend = createMemoryMeetingBackend();
  const phase1 = await manager(storage, backend, true);
  assert.equal(typeof phase1.analysisBundles?.getCurrent, 'function');
  assert.equal(phase1.analysisBundles?.backend, undefined);
  assert.equal(typeof phase1.analysis?.analyze, 'function');
  await phase1.dispose();
});

test('RC-only test handles stay opt-in and share the existing Meeting stores', async () => {
  const storage = keyStorage();
  const backend = createMemoryMeetingBackend();
  const phase1 = await createBrowserMeetingPhase1Manager({
    ownerContext: context(),
    cryptoImpl: webcrypto,
    keyStorage: storage,
    capabilities,
    backend,
    initializeSyntheticOwnerKey: true,
    exposeTestHandles: true
  });
  assert.equal(phase1.testOnly.backend, backend);
  assert.equal(typeof phase1.testOnly.transcriptStore.createRawTranscript, 'function');
  assert.equal(phase1.testOnly.ownerContext.ownerId, 'synthetic-owner');
  await phase1.dispose();
});

test('authenticated owner initialization prepares the local encrypted space without weakening missing-key fail-closed behavior', async () => {
  const storage = keyStorage();
  const phase1 = await createBrowserMeetingPhase1Manager({
    ownerContext: context('authenticated-owner'),
    cryptoImpl: webcrypto,
    keyStorage: storage,
    capabilities,
    backend: createMemoryMeetingBackend(),
    initializeAuthenticatedOwnerKey: true
  });

  await phase1.initialize();
  const created = await phase1.createMeeting({ title: 'authenticated-key-ready' });

  assert.equal(created.meeting.recordingState, 'ready');
  assert.equal(storage.records.size, 1);
  assert.ok([...storage.records.values()][0].ownerHash);
  await phase1.dispose();
});

test('browser composition exposes one owner-bound correction Manager with independent persistence and idempotent handle disposal', async () => {
  const storage = keyStorage();
  const ownerContext = context();
  const provider = await compositionKeyProvider();
  const phase1Backend = createMemoryMeetingBackend();
  let phase1BackendCloseCalls = 0;
  phase1Backend.close = () => { phase1BackendCloseCalls += 1; };
  const sourceBinding = await seedSpeakerSources({ backend: phase1Backend, keyProvider: provider, ownerContext });
  const correctionBackend = createMemoryMeetingSpeakerCorrectionBackend();
  const reopenedCorrectionBackend = correctionBackend.reopen();
  let correctionBackendCloseCalls = 0;
  const correctionHandle = {
    ...correctionBackend,
    close() {
      correctionBackendCloseCalls += 1;
      correctionBackend.close();
    }
  };

  const composed = await manager(storage, phase1Backend, false, {
    ownerContext,
    keyProvider: provider,
    speakerCorrectionBackend: correctionHandle
  });
  await composed.initialize();
  assert.deepEqual(Object.keys(composed.speakerCorrection).sort(), [
    'getCorrectionHistory',
    'getSpeakerProjection',
    'mergeSpeakers',
    'reassignSegments',
    'renameSpeaker',
    'splitSpeaker'
  ]);
  assert.equal(composed.speakerCorrection.initialize, undefined);
  assert.equal(composed.speakerCorrection.subscribe, undefined);
  assert.equal(composed.speakerCorrection.dispose, undefined);

  const binding = { meetingId: sourceBinding.meetingId, transcriptId: sourceBinding.transcriptId };
  const projection = await composed.speakerCorrection.getSpeakerProjection(binding);
  assert.equal(projection.correctionRevision, 0);
  const renamed = await composed.speakerCorrection.renameSpeaker({
    ...binding,
    expectedTranscriptRevision: 1,
    baseDiarizationRevisionId: sourceBinding.diarizationRevision.diarizationRevisionId,
    expectedCorrectionRevision: 0,
    mutationRequestId: 'composition-rename-1',
    speakerId: 'speaker-1',
    displayLabel: '主持人'
  });
  assert.equal(renamed.revision.correctionRevision, 1);
  assert.equal(correctionBackend.dump().speakerCorrectionRevisions.length, 1);
  assert.deepEqual(Object.keys(phase1Backend.dump()).filter((name) => name.startsWith('speakerCorrection')), []);

  await composed.dispose();
  await composed.dispose();
  assert.equal(correctionBackendCloseCalls, 1);
  assert.equal(phase1BackendCloseCalls, 0);

  const reopened = await manager(storage, phase1Backend, false, {
    ownerContext,
    keyProvider: provider,
    speakerCorrectionBackend: reopenedCorrectionBackend
  });
  const reopenedProjection = await reopened.speakerCorrection.getSpeakerProjection(binding);
  assert.equal(reopenedProjection.correctionRevision, 1);
  assert.equal(reopenedProjection.speakerRefs[0].displayLabel, '主持人');

  const otherOwner = await manager(storage, phase1Backend, false, {
    ownerContext: context('other-owner'),
    keyProvider: provider,
    speakerCorrectionBackend: createMemoryMeetingSpeakerCorrectionBackend()
  });
  await assert.rejects(
    otherOwner.speakerCorrection.getSpeakerProjection(binding),
    (error) => error?.code === 'TRANSCRIPT_NOT_FOUND'
  );
  await reopened.dispose();
  await otherOwner.dispose();
});

test('composed disposal interrupts one real fake-recorder-backed recording and cleans both owned handles exactly once', async () => {
  CompositionMediaRecorder.instances = [];
  const storage = keyStorage();
  const phase1Backend = createMemoryMeetingBackend();
  const correctionBackend = createMemoryMeetingSpeakerCorrectionBackend();
  let correctionCloseCalls = 0;
  const correctionHandle = {
    ...correctionBackend,
    close() {
      correctionCloseCalls += 1;
      correctionBackend.close();
    }
  };
  const stream = new CompositionStream();
  const composed = await manager(storage, phase1Backend, true, {
    speakerCorrectionBackend: correctionHandle,
    recorderOptions: {
      mediaDevices: { async getUserMedia() { return stream; } },
      MediaRecorderImpl: CompositionMediaRecorder,
      documentImpl: lifecycleTarget(),
      windowImpl: lifecycleTarget()
    }
  });

  await composed.initialize();
  await composed.createMeeting({ title: 'disposal-recording' });
  await composed.startRecording();
  assert.equal(composed.getSnapshot().active.meeting.recordingState, 'recording');
  assert.equal(CompositionMediaRecorder.instances.length, 1);

  await Promise.all([composed.dispose(), composed.dispose()]);

  assert.equal(CompositionMediaRecorder.instances[0].stopCalls, 1);
  assert.equal(stream.track.stopCalls, 1);
  assert.equal(composed.getSnapshot().active.meeting.recordingState, 'interrupted');
  assert.equal(correctionCloseCalls, 1);
});

test('browser recording persists refresh-safe chunk tokens instead of reusing recorder-local tokens', async () => {
  CompositionMediaRecorder.instances = [];
  const storage = keyStorage();
  const backend = createMemoryMeetingBackend();
  const stream = new CompositionStream();
  const phase1 = await manager(storage, backend, true, {
    recorderOptions: {
      mediaDevices: { async getUserMedia() { return stream; } },
      MediaRecorderImpl: CompositionMediaRecorder,
      documentImpl: lifecycleTarget(),
      windowImpl: lifecycleTarget()
    }
  });

  await phase1.initialize();
  await phase1.createMeeting({ title: 'refresh-safe-token-wiring' });
  await phase1.startRecording();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const recorder = CompositionMediaRecorder.instances.at(-1);
  assert.equal(typeof recorder?.ondataavailable, 'function');
  recorder.ondataavailable({
    data: new Blob(['refresh-safe-chunk'], { type: 'audio/webm;codecs=opus' })
  });
  for (let attempt = 0; attempt < 20 && backend.dump().segments.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const persisted = backend.dump().segments;
  assert.equal(persisted.length, 1);
  assert.match(persisted[0].chunkToken, /^stage3c-v1-/);
  await phase1.dispose();
});

test('correction close failure is surfaced after Phase1 disposal and remains idempotent', async () => {
  const storage = keyStorage();
  const marker = Object.assign(new Error('CORRECTION_CLOSE_FAILED'), { code: 'CORRECTION_CLOSE_FAILED' });
  const correctionBackend = createMemoryMeetingSpeakerCorrectionBackend();
  let correctionCloseCalls = 0;
  const composed = await manager(storage, createMemoryMeetingBackend(), false, {
    speakerCorrectionBackend: {
      ...correctionBackend,
      close() {
        correctionCloseCalls += 1;
        throw marker;
      }
    }
  });
  let notifications = 0;
  composed.subscribe(() => { notifications += 1; });
  await composed.initialize();
  const notificationsBeforeDispose = notifications;

  await assert.rejects(composed.dispose(), (error) => error === marker);
  await assert.rejects(composed.dispose(), (error) => error === marker);
  await composed.initialize();

  assert.equal(correctionCloseCalls, 1);
  assert.equal(notifications, notificationsBeforeDispose);
});
