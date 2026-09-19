import assert from 'node:assert/strict';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';

import { createMemoryMeetingBackend, createMeetingPhase1Store } from './browserMeetingStore.js';
import { createMeetingPhase1Manager } from './meetingPhase1Manager.js';
import { INDEPENDENT_MP4_SEGMENTS_V1 } from './meetingRecordingContainerLayout.js';

const cryptoImpl = webcrypto;

function context(ownerId = 'owner-a') {
  return Object.freeze({ trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' });
}

async function provider() {
  const key = await cryptoImpl.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { withOwnerKey: (_context, callback) => callback(key) };
}

function fakeRecorderFactory({ onStarted, onSegment, onInterrupted, mimeType = 'audio/webm' }) {
  let status = 'idle';
  let startFailureCode = '';
  let emittedSegments = 0;
  const api = {
    get status() {
      return status;
    },
    set shouldFailStart(value) {
      startFailureCode = value ? 'MEDIA_RECORDER_NOT_STARTED' : '';
    },
    async start(options = {}) {
      if (status === 'recording') return { actualStarted: true, idempotent: true };
      if (startFailureCode) {
        const error = new Error(startFailureCode);
        error.code = startFailureCode;
        throw error;
      }
      status = 'recording';
      await onStarted({
        actualStarted: true,
        explicitResume: options.explicitResume === true,
        recordingCodecExperiment: mimeType.startsWith('audio/mp4') ? 'aac-mp4' : '',
        selectedMimeType: mimeType,
        actualMimeType: mimeType,
        mimeType,
        container: mimeType.startsWith('audio/mp4') ? 'MP4' : 'WebM',
        codec: mimeType.startsWith('audio/mp4') ? 'AAC' : 'Opus'
      });
      return { actualStarted: true, idempotent: false };
    },
    async stop() {
      if (status === 'idle') return { idempotent: true };
      try {
        await onSegment({
          blob: new Blob([`PHASE1A_SYNTHETIC_SEGMENT_${emittedSegments++}`], { type: mimeType }),
          durationMs: 1000,
          mimeType,
          startedAt: '2026-08-06T13:20:00.000Z',
          endedAt: '2026-08-06T13:20:01.000Z'
        });
      } finally {
        status = 'idle';
      }
      return { idempotent: false };
    },
    async interrupt(reason) {
      if (status === 'idle') return { idempotent: true };
      await api.stop();
      await onInterrupted({ reason });
      return { idempotent: false };
    },
    failStart(errorCode = 'MEDIA_RECORDER_NOT_STARTED') {
      startFailureCode = errorCode;
    }
  };
  return api;
}

async function setup({ mimeType = 'audio/webm' } = {}) {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await provider(), backend });
  let recorder;
  let startFailureCode = '';
  const manager = createMeetingPhase1Manager({
    ownerContext: context(),
    store,
    recorderFactory: (callbacks) => {
      recorder = fakeRecorderFactory({ ...callbacks, mimeType });
      if (startFailureCode) recorder.failStart(startFailureCode);
      return recorder;
    }
  });
  await manager.initialize();
  return {
    manager,
    store,
    backend,
    recorder: () => recorder,
    failStart: (errorCode = 'MEDIA_RECORDER_NOT_STARTED') => { startFailureCode = errorCode; }
  };
}

test('manager creates a ready meeting, records only after actual start, and persists a stopped session', async () => {
  const { manager } = await setup();
  const created = await manager.createMeeting({ title: 'Phase 1A 合成会议' });
  assert.equal(created.meeting.recordingState, 'ready');

  const recording = await manager.startRecording();
  assert.equal(recording.meeting.recordingState, 'recording');
  const stopped = await manager.stopRecording();
  assert.equal(stopped.meeting.recordingState, 'stopped');
  assert.equal(stopped.meeting.committedSegmentCount, 1);
  assert.equal(stopped.segments.length, 1);
});

test('recorder start failure is retryable and never exposes recording state', async () => {
  const { manager, recorder, failStart } = await setup();
  await manager.createMeeting({ title: '启动失败会议' });
  failStart();
  await assert.rejects(manager.startRecording(), (error) => error.code === 'MEDIA_RECORDER_NOT_STARTED');
  assert.equal(manager.getSnapshot().active.meeting.recordingState, 'failed_retryable');
  assert.notEqual(manager.getSnapshot().active.meeting.recordingState, 'recording');
  assert.equal(recorder().status, 'idle');
});

test('interruption persists completed segments and requires explicit resume', async () => {
  const { manager } = await setup();
  await manager.createMeeting({ title: '中断恢复会议' });
  await manager.startRecording();
  const interrupted = await manager.interruptRecording('page_hidden');
  assert.equal(interrupted.meeting.recordingState, 'interrupted');
  assert.equal(interrupted.meeting.committedSegmentCount, 1);
  assert.equal(manager.getSnapshot().recorderStatus, 'idle');

  const resumed = await manager.startRecording();
  assert.equal(resumed.meeting.recordingState, 'recording');
  assert.equal(resumed.meeting.committedSegmentCount, 1);
});

test('initialize auto-opens one recoverable interrupted meeting without resuming recording', async () => {
  const first = await setup();
  const created = await first.manager.createMeeting({ title: '刷新恢复会议' });
  await first.manager.startRecording();
  const interrupted = await first.manager.interruptRecording('page_reload_recovery');
  assert.equal(interrupted.meeting.recordingState, 'interrupted');
  assert.equal(interrupted.meeting.recoverable, true);

  const recovered = createMeetingPhase1Manager({
    ownerContext: context(),
    store: first.store,
    recorderFactory: (callbacks) => fakeRecorderFactory(callbacks)
  });
  const snapshot = await recovered.initialize();
  assert.equal(snapshot.active.meeting.meetingId, created.meeting.meetingId);
  assert.equal(snapshot.active.meeting.recordingState, 'interrupted');
  assert.equal(snapshot.recorderStatus, 'idle');
  assert.equal(snapshot.active.meeting.committedDurationMs, interrupted.meeting.committedDurationMs);
});

test('Gen289 legacy asset mismatch restores the same durable meeting without auto-starting media', async () => {
  const first = await setup({ mimeType: 'audio/mp4;codecs=mp4a.40.2' });
  const created = await first.manager.createMeeting({ title: 'Gen289 asset gate recovery' });
  await first.manager.startRecording();
  const interrupted = await first.manager.interruptRecording('page_reload_recovery');
  assert.equal(interrupted.meeting.committedSegmentCount, 1);

  await first.store.saveSession(context(), Object.freeze({
    ...interrupted.meeting,
    recordingState: 'failed_retryable',
    actualRecorderStarted: false,
    recoverable: true,
    errorCode: 'CLIENT_ASSET_VERSION_MISMATCH'
  }));

  let recorderInstances = 0;
  const recoveredManager = createMeetingPhase1Manager({
    ownerContext: context(),
    store: first.store,
    recorderFactory: (callbacks) => {
      recorderInstances += 1;
      return fakeRecorderFactory({ ...callbacks, mimeType: 'audio/mp4;codecs=mp4a.40.2' });
    }
  });
  const recovered = await recoveredManager.initialize();

  assert.equal(recovered.active.meeting.meetingId, created.meeting.meetingId);
  assert.equal(recovered.active.meeting.recordingState, 'interrupted');
  assert.equal(recovered.active.meeting.errorCode, '');
  assert.equal(recovered.active.meeting.committedSegmentCount, interrupted.meeting.committedSegmentCount);
  assert.equal(recovered.active.meeting.committedDurationMs, interrupted.meeting.committedDurationMs);
  assert.equal(recovered.active.segments.length, interrupted.segments.length);
  assert.equal(recovered.recorderStatus, 'idle');
  assert.equal(recorderInstances, 0);

  const resumed = await recoveredManager.resumeRecording();
  assert.equal(resumed.meeting.meetingId, created.meeting.meetingId);
  assert.equal(resumed.meeting.recordingState, 'recording');
  assert.equal(resumed.meeting.committedSegmentCount, interrupted.meeting.committedSegmentCount);
  assert.equal(resumed.segments.length, interrupted.segments.length);
  assert.equal(recorderInstances, 1);
});

test('90/180/300 second checkpoint-sized recordings restore the full committed duration', async () => {
  for (const targetDurationMs of [90_000, 180_000, 300_000]) {
    const backend = createMemoryMeetingBackend();
    const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await provider(), backend });
    let recorder = null;
    const manager = createMeetingPhase1Manager({
      ownerContext: context(),
      store,
      recorderFactory: (callbacks) => {
        let status = 'idle';
        recorder = {
          get status() { return status; },
          async start() {
            status = 'recording';
            await callbacks.onStarted({ actualStarted: true });
          },
          async emit(index) {
            await callbacks.onSegment({
              blob: new Blob([`durable-${targetDurationMs}-${index}`], { type: 'audio/mp4;codecs=mp4a.40.2' }),
              durationMs: 10_000,
              mimeType: 'audio/mp4;codecs=mp4a.40.2',
              startedAt: `2026-08-14T10:${String(Math.floor(index / 6)).padStart(2, '0')}:${String((index % 6) * 10).padStart(2, '0')}.000Z`,
              endedAt: `2026-08-14T10:${String(Math.floor((index + 1) / 6)).padStart(2, '0')}:${String(((index + 1) % 6) * 10).padStart(2, '0')}.000Z`
            });
          },
          async stop() { status = 'idle'; },
          async interrupt(reason) {
            status = 'idle';
            await callbacks.onInterrupted({ reason });
          }
        };
        return recorder;
      }
    });
    await manager.initialize();
    const created = await manager.createMeeting({ title: `durable-${targetDurationMs}` });
    await manager.startRecording();
    const segmentCount = targetDurationMs / 10_000;
    for (let index = 0; index < segmentCount; index += 1) await recorder.emit(index);
    const interrupted = await manager.interruptRecording('page_reload_recovery');
    assert.equal(interrupted.meeting.committedDurationMs, targetDurationMs);

    const recovered = createMeetingPhase1Manager({
      ownerContext: context(),
      store,
      recorderFactory: (callbacks) => fakeRecorderFactory(callbacks)
    });
    const snapshot = await recovered.initialize();
    assert.equal(snapshot.active.meeting.meetingId, created.meeting.meetingId);
    assert.equal(snapshot.active.meeting.committedDurationMs, targetDurationMs);
    assert.equal(snapshot.active.segments.length, segmentCount);
  }
});

test('first persisted segment binds the recording attempt to the recorded source exactly once', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await provider(), backend });
  let bindCalls = 0;
  let bound = null;
  const submit = async () => ({ ok: true, recordingAttemptId: 'attempt-durable-1' });
  submit.bindSource = async (input) => {
    bindCalls += 1;
    bound = input;
    return true;
  };
  let recorder;
  let emitted = 0;
  const manager = createMeetingPhase1Manager({
    ownerContext: context(),
    store,
    onSegmentCommitted: async ({ meetingId, sourceId }) => {
      if (bound) return bound;
      const result = await submit();
      if (result.recordingAttemptId) await submit.bindSource?.({
        recordingAttemptId: result.recordingAttemptId,
        meetingId,
        sourceId
      });
      return bound;
    },
    recorderFactory: (callbacks) => {
      let status = 'idle';
      recorder = {
        get status() { return status; },
        async start() {
          status = 'recording';
          await callbacks.onStarted({ actualStarted: true, recordingAttemptId: 'attempt-durable-1' });
        },
        async emit() {
          await callbacks.onSegment({
            blob: new Blob([`bound-segment-${emitted++}`], { type: 'audio/mp4;codecs=mp4a.40.2' }),
            durationMs: 1000,
            mimeType: 'audio/mp4;codecs=mp4a.40.2',
            startedAt: '2026-08-14T10:00:00.000Z',
            endedAt: '2026-08-14T10:00:01.000Z'
          });
        },
        async stop() { status = 'idle'; },
        async interrupt(reason) { status = 'idle'; await callbacks.onInterrupted({ reason }); }
      };
      return recorder;
    }
  });
  await manager.initialize();
  const created = await manager.createMeeting({ title: 'attempt-bind' });
  await manager.startRecording();
  await recorder.emit();
  await recorder.emit();
  assert.equal(bindCalls, 1);
  assert.deepEqual(bound, {
    recordingAttemptId: 'attempt-durable-1',
    meetingId: created.meeting.meetingId,
    sourceId: `recorded-${created.meeting.meetingId}`
  });
});

test('repeated refresh recovery never rolls committed duration back to the latest segment', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await provider(), backend });
  let recorder;
  let serial = 0;
  const recorderFactory = (callbacks) => {
    let status = 'idle';
    recorder = {
      get status() { return status; },
      async start() { status = 'recording'; await callbacks.onStarted({ actualStarted: true }); },
      async emit() {
        const index = serial++;
        await callbacks.onSegment({
          blob: new Blob([`refresh-${index}`], { type: 'audio/mp4;codecs=mp4a.40.2' }),
          durationMs: 10_000,
          mimeType: 'audio/mp4;codecs=mp4a.40.2',
          startedAt: `2026-08-14T11:00:${String(index * 10).padStart(2, '0')}.000Z`,
          endedAt: `2026-08-14T11:00:${String((index + 1) * 10).padStart(2, '0')}.000Z`
        });
      },
      async stop() { status = 'idle'; },
      async interrupt(reason) { status = 'idle'; await callbacks.onInterrupted({ reason }); }
    };
    return recorder;
  };
  const first = createMeetingPhase1Manager({ ownerContext: context(), store, recorderFactory });
  await first.initialize();
  const created = await first.createMeeting({ title: 'repeated-refresh' });
  await first.startRecording();
  await recorder.emit();
  await recorder.emit();
  await first.interruptRecording('page_reload_recovery');

  const second = createMeetingPhase1Manager({ ownerContext: context(), store, recorderFactory });
  await second.initialize();
  assert.equal(second.getSnapshot().active.meeting.committedDurationMs, 20_000);
  await second.startRecording();
  await recorder.emit();
  await recorder.emit();
  await second.interruptRecording('page_reload_recovery');

  const third = createMeetingPhase1Manager({ ownerContext: context(), store, recorderFactory });
  await third.initialize();
  assert.equal(third.getSnapshot().active.meeting.meetingId, created.meeting.meetingId);
  assert.equal(third.getSnapshot().active.meeting.committedDurationMs, 40_000);
  assert.equal(third.getSnapshot().active.segments.length, 4);
});

test('multiple recoverable meetings remain unselected until the user chooses one', async () => {
  const first = await setup();
  await first.manager.createMeeting({ title: 'recoverable-one' });
  await first.manager.startRecording();
  await first.manager.interruptRecording('page_reload_recovery');
  await first.manager.createMeeting({ title: 'recoverable-two' });
  await first.manager.startRecording();
  await first.manager.interruptRecording('page_reload_recovery');

  const reopened = createMeetingPhase1Manager({
    ownerContext: context(),
    store: first.store,
    recorderFactory: (callbacks) => fakeRecorderFactory(callbacks)
  });
  const snapshot = await reopened.initialize();
  assert.equal(snapshot.active, null);
  assert.equal(snapshot.meetings.filter((meeting) => meeting.recordingState === 'interrupted').length, 2);
});

test('AAC/MP4 recording keeps encrypted chunks across interruption and explicit resume', async () => {
  const mimeType = 'audio/mp4;codecs=mp4a.40.2';
  const { manager } = await setup({ mimeType });
  await manager.createMeeting({ title: 'AAC 中断恢复会议' });
  await manager.startRecording();
  assert.equal(manager.getSnapshot().recorderInfo.actualMimeType, mimeType);
  assert.equal(manager.getSnapshot().recorderInfo.container, 'MP4');
  assert.equal(manager.getSnapshot().recorderInfo.codec, 'AAC');
  const interrupted = await manager.interruptRecording('page_hidden');
  assert.equal(interrupted.meeting.committedSegmentCount, 1);
  assert.equal(interrupted.segments[0].mimeType, mimeType);

  await manager.startRecording();
  const stopped = await manager.stopRecording();
  assert.equal(stopped.meeting.recordingState, 'stopped');
  assert.equal(stopped.meeting.committedSegmentCount, 2);
  assert.equal(stopped.audioSources[0].format, 'm4a');
  assert.equal(stopped.segments.every((segment) => segment.mimeType === mimeType), true);
});

test('stopped session is idempotent and rejects further recording', async () => {
  const { manager } = await setup();
  await manager.createMeeting({ title: '结束会议' });
  await manager.startRecording();
  await manager.stopRecording();
  const repeated = await manager.stopRecording();
  assert.equal(repeated.meeting.recordingState, 'stopped');
  await assert.rejects(manager.startRecording(), (error) => error.code === 'SESSION_NOT_READY');
});

test('failed final tail commit preserves the meeting as finalization pending instead of invalidating durable state', async () => {
  const { manager, backend } = await setup();
  await manager.createMeeting({ title: '分段失败恢复会议' });
  await manager.startRecording();
  backend.failNextAtomic(new Error('SIMULATED_SEGMENT_COMMIT_FAILURE'));

  const pending = await manager.stopRecording();
  assert.equal(pending.meeting.recordingState, 'finalization_pending');
  assert.equal(pending.meeting.finalizationErrorCode, 'SEGMENT_ATOMIC_COMMIT_FAILED');
  assert.equal(pending.meeting.committedSegmentCount, 0);
  assert.equal(manager.getSnapshot().recorderStatus, 'idle');

  const stopped = await manager.stopRecording();
  assert.equal(stopped.meeting.recordingState, 'stopped');
  assert.equal(stopped.meeting.committedSegmentCount, 0);
});

test('serializes concurrent segment callbacks before committing manifest sequence', async () => {
  const { store } = await setup();

  let releaseFirstCommit;
  let commitCalls = 0;
  const originalCommit = store.commitAudioSegment.bind(store);
  const gatedStore = Object.freeze({
    ...store,
    commitAudioSegment: async (...args) => {
      commitCalls += 1;
      if (commitCalls === 1) await new Promise((resolve) => { releaseFirstCommit = resolve; });
      return originalCommit(...args);
    }
  });

  const recorderFactory = ({ onStarted, onSegment, onInterrupted }) => {
    let status = 'idle';
    return {
      get status() { return status; },
      async start() {
        status = 'recording';
        await onStarted({ actualStarted: true });
      },
      async stop() {
        const first = onSegment({
          blob: new Blob(['first'], { type: 'audio/webm' }),
          durationMs: 1000,
          mimeType: 'audio/webm',
          startedAt: '2026-08-06T13:20:00.000Z',
          endedAt: '2026-08-06T13:20:01.000Z'
        });
        const second = onSegment({
          blob: new Blob(['second'], { type: 'audio/webm' }),
          durationMs: 1000,
          mimeType: 'audio/webm',
          startedAt: '2026-08-06T13:20:01.000Z',
          endedAt: '2026-08-06T13:20:02.000Z'
        });
        await Promise.resolve();
        while (commitCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0));
        releaseFirstCommit?.();
        await Promise.all([first, second]);
        status = 'idle';
      },
      async interrupt(reason) {
        await this.stop();
        await onInterrupted({ reason });
      }
    };
  };

  const raceManager = createMeetingPhase1Manager({
    ownerContext: context(),
    store: gatedStore,
    recorderFactory
  });
  await raceManager.initialize();
  await raceManager.createMeeting({ title: '中断分段竞态会议' });
  await raceManager.startRecording();

  await assert.doesNotReject(() => raceManager.stopRecording());
  const stopped = raceManager.getSnapshot().active;
  assert.equal(stopped.meeting.committedSegmentCount, 2);
  assert.deepEqual(stopped.segments.map((segment) => segment.sequence), [0, 1]);
});

test('multiple committed segments continue sequence after interruption and explicit resume', async () => {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await provider(), backend });
  let recorder;
  const manager = createMeetingPhase1Manager({
    ownerContext: context(),
    store,
    recorderFactory: (callbacks) => {
      let status = 'idle';
      recorder = {
        get status() { return status; },
        async start() {
          status = 'recording';
          await callbacks.onStarted({ actualStarted: true });
        },
        async emit(value) {
          await callbacks.onSegment({
            blob: new Blob([value], { type: 'audio/webm' }),
            durationMs: 1000,
            mimeType: 'audio/webm',
            startedAt: '2026-08-06T13:30:00.000Z',
            endedAt: '2026-08-06T13:30:01.000Z'
          });
        },
        async stop() {
          status = 'idle';
        },
        async interrupt(reason) {
          status = 'idle';
          await callbacks.onInterrupted({ reason });
        }
      };
      return recorder;
    }
  });
  await manager.initialize();
  await manager.createMeeting({ title: '多分段中断恢复会议' });
  await manager.startRecording();
  await recorder.emit('segment-zero');
  await recorder.emit('segment-one');
  await manager.interruptRecording('page_hidden');
  await manager.startRecording();
  await recorder.emit('segment-two');
  const stopped = await manager.stopRecording();

  assert.equal(stopped.meeting.recordingState, 'stopped');
  assert.deepEqual(stopped.segments.map((segment) => segment.sequence), [0, 1, 2]);
  const reopened = await manager.openMeeting(stopped.meeting.meetingId);
  assert.deepEqual(reopened.segments.map((segment) => segment.sequence), [0, 1, 2]);
});

test('phase 1 manager exposes Stage 2 audio import without changing the recorder lifecycle', async () => {
  const { manager } = await setup();
  const created = await manager.createMeeting({ title: 'Phase 1B 导入纵向切片' });
  const data = Uint8Array.from({ length: 1600 }, (_, index) => index % 251);
  const header = new Uint8Array([
    ...new TextEncoder().encode('RIFF'), 0x64, 0x06, 0x00, 0x00, ...new TextEncoder().encode('WAVE'),
    ...new TextEncoder().encode('fmt '), 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x40, 0x1f, 0x00, 0x00, 0x80, 0x3e, 0x00, 0x00, 0x02, 0x00, 0x10, 0x00,
    ...new TextEncoder().encode('data'), 0x40, 0x06, 0x00, 0x00
  ]);
  const file = new Blob([header, data], { type: 'audio/wav' });
  Object.defineProperty(file, 'name', { value: 'phase1b.wav' });
  const imported = await manager.importAudio(file, { importId: 'manager-import-1' });
  assert.equal(imported.source.origin, 'imported');
  assert.equal(manager.getSnapshot().active.audioSources.length, 1);
  assert.equal(manager.getSnapshot().audioImport.importState, 'committed');
  await manager.deleteAudioSource(imported.source.sourceId);
  assert.equal(manager.getSnapshot().active.audioSources.length, 0);
  const reopened = await manager.openMeeting(created.meeting.meetingId);
  assert.equal(reopened.audioSources.length, 0);
});

test('rotation identity survives native-safe pause and refresh while capture epoch advances exactly once per explicit resume', async () => {
  const backend = createMemoryMeetingBackend();
  const baseStore = createMeetingPhase1Store({ cryptoImpl, keyProvider: await provider(), backend });
  const startInputs = [];
  let activeRecorder = null;
  const recorderFactory = (callbacks) => {
    let status = 'idle';
    const recorder = {
      get status() { return status; },
      async start(input = {}) {
        startInputs.push({ ...input });
        status = 'recording';
        const info = {
          actualStarted: true,
          recordingAttemptId: input.recordingAttemptId || 'attempt-logical-stable',
          captureEpoch: input.captureEpoch,
          containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
          actualMimeType: 'audio/mp4;codecs=mp4a.40.2'
        };
        await callbacks.onStarted(info);
        return info;
      },
      async pause() {
        status = 'paused';
        return { actualPaused: true };
      },
      async resume(input = {}) {
        startInputs.push({ ...input, resumedThrough: 'resume' });
        status = 'recording';
        const info = {
          actualStarted: true,
          recordingAttemptId: input.recordingAttemptId,
          captureEpoch: input.captureEpoch,
          containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
          actualMimeType: 'audio/mp4;codecs=mp4a.40.2'
        };
        await callbacks.onStarted(info);
        return info;
      },
      async interrupt(reason) {
        status = 'idle';
        await callbacks.onInterrupted({ reason });
      },
      async stop() {
        status = 'idle';
        return { finalized: true };
      }
    };
    activeRecorder = recorder;
    return recorder;
  };
  const first = createMeetingPhase1Manager({
    ownerContext: context(),
    store: baseStore,
    recorderFactory,
    recorderOptions: { checkpointMode: 'rotating-independent-mp4' }
  });
  await first.initialize();
  const created = await first.createMeeting({ title: 'stable logical identity' });
  const started = await first.startRecording();
  assert.equal(started.meeting.recordingAttemptId, 'attempt-logical-stable');
  assert.equal(started.meeting.captureEpoch, 0);
  assert.equal(started.meeting.containerLayout, INDEPENDENT_MP4_SEGMENTS_V1);
  assert.equal(startInputs[0].meetingId, created.meeting.meetingId);
  assert.equal(startInputs[0].recordingAttemptId, '');
  assert.equal(startInputs[0].captureEpoch, 0);

  await first.pauseRecording();
  const resumed = await first.resumeRecording();
  assert.equal(resumed.meeting.recordingAttemptId, 'attempt-logical-stable');
  assert.equal(resumed.meeting.captureEpoch, 1);
  assert.equal(startInputs[1].recordingAttemptId, 'attempt-logical-stable');
  assert.equal(startInputs[1].captureEpoch, 1);

  await activeRecorder.interrupt('page_reload_recovery');
  let replayCalls = 0;
  const replayAwareStore = Object.freeze({
    ...baseStore,
    async replayPendingCaptureUnits(...args) {
      replayCalls += 1;
      return baseStore.replayPendingCaptureUnits(...args);
    }
  });
  const second = createMeetingPhase1Manager({
    ownerContext: context(),
    store: replayAwareStore,
    recorderFactory,
    recorderOptions: { checkpointMode: 'rotating-independent-mp4' }
  });
  const recovered = await second.initialize();
  assert.equal(replayCalls, 1);
  assert.equal(recovered.active.meeting.recordingAttemptId, 'attempt-logical-stable');
  assert.equal(recovered.active.meeting.captureEpoch, 1);
  assert.equal(recovered.recorderStatus, 'idle');

  const afterRefresh = await second.resumeRecording();
  assert.equal(afterRefresh.meeting.recordingAttemptId, 'attempt-logical-stable');
  assert.equal(afterRefresh.meeting.captureEpoch, 2);
  assert.equal(startInputs[2].recordingAttemptId, 'attempt-logical-stable');
  assert.equal(startInputs[2].captureEpoch, 2);
});

test('rotation persistence stall is exposed only after capture becomes an explicit recoverable interruption', async () => {
  const store = createMeetingPhase1Store({
    cryptoImpl,
    keyProvider: await provider(),
    backend: createMemoryMeetingBackend()
  });
  let callbacks = null;
  let status = 'idle';
  const manager = createMeetingPhase1Manager({
    ownerContext: context(),
    store,
    recorderOptions: { checkpointMode: 'rotating-independent-mp4' },
    recorderFactory(inputCallbacks) {
      callbacks = inputCallbacks;
      return {
        get status() { return status; },
        async start(input = {}) {
          status = 'recording';
          const info = {
            actualStarted: true,
            recordingAttemptId: input.recordingAttemptId || 'attempt-persistence-interrupted',
            captureEpoch: input.captureEpoch,
            containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
            actualMimeType: 'audio/mp4;codecs=mp4a.40.2'
          };
          await inputCallbacks.onStarted(info);
          return info;
        },
        async stop() {
          status = 'idle';
          return { finalized: true };
        }
      };
    }
  });
  await manager.initialize();
  await manager.createMeeting({ title: 'rotation persistence interruption' });
  await manager.startRecording();

  status = 'stalled';
  await callbacks.onPersistenceStatus({
    phase: 'stalled',
    errorCode: 'CAPTURE_UNIT_COMMIT_FAILED'
  });
  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.active.meeting.recordingState, 'interrupted');
  assert.equal(snapshot.active.meeting.actualRecorderStarted, false);
  assert.equal(snapshot.active.meeting.interruptionReason, 'CAPTURE_UNIT_COMMIT_FAILED');
  assert.equal(snapshot.active.meeting.errorCode, 'CAPTURE_UNIT_COMMIT_FAILED');
  assert.equal(snapshot.active.meeting.persistenceStalled, true);
  assert.equal(snapshot.active.meeting.recoverable, true);
  assert.equal(snapshot.recorderStatus, 'stalled');
});
