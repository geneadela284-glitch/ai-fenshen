import {
  isDurableAssetGateRecoveryCandidate,
  transitionMeetingPhase1Session
} from './meetingPhase1State.js';
import { createMeetingRecorderController } from './meetingRecorderController.js';
import { createMeetingAudioImportManager } from './meetingAudioImportManager.js';
import {
  INDEPENDENT_MP4_SEGMENTS_V1,
  ROTATING_INDEPENDENT_MP4_MODE
} from './meetingRecordingContainerLayout.js';

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function timestamp(now) {
  return typeof now === 'function' ? now() : now || new Date().toISOString();
}

function randomId(cryptoImpl, prefix) {
  if (!cryptoImpl?.getRandomValues) return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const random = cryptoImpl.getRandomValues(new Uint8Array(12));
  let binary = '';
  for (const value of random) binary += String.fromCharCode(value);
  const base64 = (globalThis.btoa || ((value) => Buffer.from(value, 'binary').toString('base64')))(binary)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${prefix}-${base64}`;
}

function ownerContext(value) {
  if (!value || typeof value !== 'object' || value.trusted !== true) throw codedError('OWNER_CONTEXT_UNTRUSTED');
  return Object.freeze({
    trusted: true,
    ownerId: required(value.ownerId, 'OWNER_REQUIRED'),
    sessionId: required(value.sessionId, 'OWNER_SESSION_REQUIRED'),
    spaceId: required(value.spaceId || 'meeting-space', 'SPACE_ID_REQUIRED')
  });
}

export function createMeetingPhase1Manager({
  ownerContext: inputOwnerContext,
  store,
  recorderFactory = createMeetingRecorderController,
  recorderOptions = {},
  audioImportManager = null,
  cryptoImpl = globalThis.crypto,
  now = () => new Date().toISOString(),
  onSegmentCommitted = async () => {},
  onCheckpointTrace = async () => {}
} = {}) {
  const context = ownerContext(inputOwnerContext);
  if (!store || typeof store.createMeeting !== 'function' || typeof store.getMeeting !== 'function') throw codedError('MEETING_STORE_REQUIRED');
  let meetings = [];
  let active = null;
  let recorder = null;
  let recorderInfo = null;
  let segmentQueueTail = Promise.resolve();
  let finalizationStopInProgress = false;
  let initialized = false;
  const listeners = new Set();
  const importManager = audioImportManager || createMeetingAudioImportManager({ ownerContext: context, store, cryptoImpl, now });
  const unsubscribeImport = importManager.subscribe(() => notify());
  const usesRotatingIndependentMp4 = recorderOptions.checkpointMode === ROTATING_INDEPENDENT_MP4_MODE;

  function notify() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // UI observers must not interrupt persistence.
      }
    }
  }

  function getSnapshot() {
    return Object.freeze({
      meetings: [...meetings],
      active,
      recorderStatus: recorder?.status || 'idle',
      recorderInfo,
      audioImport: importManager.getSnapshot(),
      initialized
    });
  }

  async function reloadMeetings() {
    meetings = await store.listMeetings(context);
    notify();
    return meetings;
  }

  async function recoverOrphanedRecording(value) {
    if (!value?.meeting) return value;
    if (typeof store.replayPendingCaptureUnits === 'function') {
      await store.replayPendingCaptureUnits(context, { meetingId: value.meeting.meetingId });
      value = await store.getMeeting(context, value.meeting.meetingId);
      if (value.manifest?.containerLayout === INDEPENDENT_MP4_SEGMENTS_V1
        && typeof store.recordCaptureDiscontinuity === 'function') {
        for (const reservation of value.manifest.captureOrdinals || []) {
          if (reservation.state !== 'reserved') continue;
          await store.recordCaptureDiscontinuity(context, {
            meetingId: value.meeting.meetingId,
            sourceId: `recorded-${value.meeting.meetingId}`,
            recordingAttemptId: value.meeting.recordingAttemptId,
            captureEpoch: reservation.captureEpoch,
            captureOrdinal: reservation.captureOrdinal,
            captureUnitId: reservation.captureUnitId,
            chunkToken: reservation.chunkToken,
            errorCode: 'CAPTURE_UNIT_UNSEALED_AT_REFRESH'
          });
        }
        value = await store.getMeeting(context, value.meeting.meetingId);
      }
    }
    const recoveryEvent = isDurableAssetGateRecoveryCandidate(value.meeting)
      ? { type: 'asset_gate_recovered' }
      : value.meeting.recordingState === 'recording'
        ? { type: 'interrupted', reason: 'page_reload_recovery' }
        : null;
    if (!recoveryEvent) return value;
    const result = transitionMeetingPhase1Session(value.meeting, recoveryEvent, { now: timestamp(now) });
    if (!result.accepted) throw codedError(result.errorCode || 'MEETING_RECOVERY_FAILED');
    await store.saveSession(context, result.state);
    return store.getMeeting(context, value.meeting.meetingId);
  }

  async function initialize() {
    await reloadMeetings();
    const recoverable = meetings.filter((meeting) => (
      (['recording', 'interrupted', 'finalization_pending'].includes(meeting.recordingState)
        && (meeting.recordingState === 'recording' || meeting.recoverable !== false))
      || isDurableAssetGateRecoveryCandidate(meeting)
    ));
    if (recoverable.length === 1) {
      const loaded = await store.getMeeting(context, recoverable[0].meetingId);
      active = await recoverOrphanedRecording(loaded);
      recorderInfo = null;
      await importManager.initialize(active.meeting.meetingId);
    }
    initialized = true;
    notify();
    return getSnapshot();
  }

  async function createMeeting(input = {}) {
    const created = await store.createMeeting(context, {
      title: input.title,
      scope: input.scope || 'meeting'
    });
    await store.prepareMeeting(context, created.meeting.meetingId);
    active = await store.getMeeting(context, created.meeting.meetingId);
    recorderInfo = null;
    await reloadMeetings();
    notify();
    return active;
  }

  async function openMeeting(meetingId) {
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    if (typeof store.replayPendingCaptureUnits === 'function') {
      await store.replayPendingCaptureUnits(context, { meetingId: normalizedMeetingId });
    }
    const loaded = await store.getMeeting(context, normalizedMeetingId);
    active = await recoverOrphanedRecording(loaded);
    recorderInfo = null;
    await importManager.initialize(active.meeting.meetingId);
    notify();
    return active;
  }

  async function ensureRecorder() {
    if (recorder) return recorder;
    recorder = recorderFactory({
      ...recorderOptions,
      now,
      onSegment: handleSegment,
      onStarted: (info) => {
        recorderInfo = Object.freeze({ ...(info || {}) });
        notify();
      },
      onInterrupted: handleInterrupted,
      onError: handleRecorderError,
      onPersistenceStatus: handlePersistenceStatus,
      onCheckpointTrace: handleCheckpointTrace,
      capturePersistencePort: Object.freeze({
        reserveCaptureUnit(input = {}) {
          if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
          return store.reserveCaptureUnit(context, {
            ...input,
            meetingId: active.meeting.meetingId,
            sourceId: `recorded-${active.meeting.meetingId}`
          });
        },
        stagePendingCaptureUnit(input = {}) {
          if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
          return store.stagePendingCaptureUnit(context, {
            ...input,
            meetingId: active.meeting.meetingId,
            sourceId: `recorded-${active.meeting.meetingId}`
          });
        },
        async commitPendingCaptureUnit(input = {}) {
          if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
          const result = await store.commitPendingCaptureUnit(context, {
            ...input,
            meetingId: active.meeting.meetingId
          });
          const committedSegment = result.segment;
          const alreadyVisible = active.segments.some((segment) => (
            segment.segmentId === committedSegment?.segmentId
            || (committedSegment?.sequence !== undefined && segment.sequence === committedSegment.sequence)
          ));
          active = Object.freeze({
            ...active,
            meeting: result.meeting,
            manifest: result.manifest,
            segments: Object.freeze(alreadyVisible || !committedSegment
              ? [...active.segments]
              : [...active.segments, committedSegment])
          });
          await reloadMeetings();
          notify();
          await onSegmentCommitted(Object.freeze({
            meetingId: active.meeting.meetingId,
            sourceId: `recorded-${active.meeting.meetingId}`,
            sequence: result.segment?.sequence,
            durationMs: active.meeting.committedDurationMs,
            mimeType: result.segment?.mimeType || recorderInfo?.actualMimeType || ''
          }));
          return result;
        },
        recordCaptureDiscontinuity(input = {}) {
          if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
          return store.recordCaptureDiscontinuity(context, {
            ...input,
            meetingId: active.meeting.meetingId,
            sourceId: `recorded-${active.meeting.meetingId}`
          });
        },
        replayPendingCaptureUnits() {
          if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
          return store.replayPendingCaptureUnits(context, { meetingId: active.meeting.meetingId });
        },
        finalizeCaptureManifest(input = {}) {
          if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
          return store.finalizeCaptureManifest(context, {
            ...input,
            meetingId: active.meeting.meetingId
          });
        }
      })
    });
    if (!recorder || typeof recorder.start !== 'function' || typeof recorder.stop !== 'function') throw codedError('MEETING_RECORDER_REQUIRED');
    return recorder;
  }

  async function handleCheckpointTrace(trace) {
    const meetingId = String(active?.meeting?.meetingId || '').trim();
    const sourceId = meetingId ? `recorded-${meetingId}` : '';
    try {
      await onCheckpointTrace(Object.freeze({
        ...trace,
        ...(meetingId ? { meetingId } : {}),
        ...(sourceId ? { sourceId } : {})
      }));
    } catch {
      // Checkpoint diagnostics are best-effort and never alter recording.
    }
  }

  async function persistTransition(event) {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    const result = transitionMeetingPhase1Session(active.meeting, event, { now: timestamp(now) });
    if (result.idempotent) return active;
    if (!result.accepted) throw codedError(result.errorCode || 'SESSION_TRANSITION_REJECTED');
    await store.saveSession(context, result.state);
    active = await store.getMeeting(context, result.state.meetingId);
    await reloadMeetings();
    notify();
    return active;
  }

  async function commitSegment({ blob, chunkToken, durationMs, mimeType, startedAt, endedAt }) {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    if (!blob?.arrayBuffer) throw codedError('AUDIO_BLOB_INVALID');
    const audioBytes = new Uint8Array(await blob.arrayBuffer());
    try {
      const result = await store.commitAudioSegment(context, {
        meetingId: active.meeting.meetingId,
        segment: {
          segmentId: chunkToken ? `segment-${chunkToken}` : randomId(cryptoImpl, 'segment'),
          chunkToken: chunkToken || undefined,
          startedAt,
          endedAt,
          durationMs,
          mimeType
        },
        bytes: audioBytes
      });
      active = await store.getMeeting(context, active.meeting.meetingId);
      const checkpoint = transitionMeetingPhase1Session(active.meeting, {
        type: 'persistence_checkpoint',
        lastPersistedSequence: result.segment?.sequence,
        lastCommittedDurationMs: active.meeting.committedDurationMs,
        lastSuccessfulPersistAt: active.meeting.lastSavedAt
      }, { now: timestamp(now) });
      if (checkpoint.accepted) {
        await store.saveSession(context, checkpoint.state);
        active = await store.getMeeting(context, active.meeting.meetingId);
      }
      await reloadMeetings();
      notify();
      await onSegmentCommitted(Object.freeze({
        meetingId: active.meeting.meetingId,
        sourceId: `recorded-${active.meeting.meetingId}`,
        sequence: result.segment?.sequence,
        durationMs: active.meeting.committedDurationMs,
        mimeType: result.segment?.mimeType || mimeType
      }));
      return result;
    } catch (error) {
      const code = error?.code || 'SEGMENT_COMMIT_FAILED';
      const finalizationInProgress = finalizationStopInProgress || recorder?.status === 'stopping';
      if (active?.meeting && !finalizationInProgress && ['recording', 'interrupted'].includes(active.meeting.recordingState)) {
        const failed = transitionMeetingPhase1Session(active.meeting, { type: 'segment_commit_failed', errorCode: code }, { now: timestamp(now) });
        if (failed.accepted) {
          await store.saveSession(context, failed.state);
          active = await store.getMeeting(context, active.meeting.meetingId);
          await reloadMeetings();
          notify();
        }
      }
      throw error;
    }
  }

  function handleSegment(input) {
    const task = segmentQueueTail.then(() => commitSegment(input));
    segmentQueueTail = task.catch(() => {});
    return task;
  }

  async function handleInterrupted({ reason }) {
    if (!active?.meeting || active.meeting.recordingState !== 'recording') return active;
    return persistTransition({ type: 'interrupted', reason });
  }

  function handleRecorderError(error) {
    if (finalizationStopInProgress) return;
    if (!active?.meeting || !['recording', 'interrupted'].includes(active.meeting.recordingState)) return;
    void (async () => {
      try {
        const failed = transitionMeetingPhase1Session(active.meeting, { type: 'segment_commit_failed', errorCode: error?.code || 'MEDIA_RECORDER_RUNTIME_ERROR' }, { now: timestamp(now) });
        if (failed.accepted) {
          await store.saveSession(context, failed.state);
          active = await store.getMeeting(context, active.meeting.meetingId);
          await reloadMeetings();
          notify();
        }
      } catch {
        // The original recorder error remains the visible failure signal.
      }
    })();
  }

  async function handlePersistenceStatus(status) {
    if (status?.phase !== 'stalled' || !active?.meeting) return;
    if (!['recording', 'interrupted'].includes(active.meeting.recordingState)) return;
    await persistTransition({
      type: usesRotatingIndependentMp4 ? 'persistence_interrupted' : 'persistence_stalled',
      errorCode: status.errorCode || 'RECORDING_PERSISTENCE_STALLED'
    });
  }

  async function retryRecording() {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    return persistTransition({ type: 'retry' });
  }

  function buildRecorderStartInput(explicitResume) {
    if (!usesRotatingIndependentMp4) return Object.freeze({ explicitResume });
    const currentEpoch = Number.isSafeInteger(active.meeting.captureEpoch)
      ? active.meeting.captureEpoch
      : -1;
    const captureEpoch = currentEpoch < 0
      ? 0
      : explicitResume
        ? currentEpoch + 1
        : currentEpoch;
    return Object.freeze({
      explicitResume,
      meetingId: active.meeting.meetingId,
      sourceId: `recorded-${active.meeting.meetingId}`,
      recordingAttemptId: String(active.meeting.recordingAttemptId || ''),
      captureEpoch,
      containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
    });
  }

  async function persistRecorderStarted({ explicitResume, startInput, startResult }) {
    if (!usesRotatingIndependentMp4) {
      return persistTransition({ type: 'recorder_started', actualStarted: true, explicitResume });
    }
    const info = { ...(recorderInfo || {}), ...(startResult || {}) };
    const recordingAttemptId = String(info.recordingAttemptId || startInput.recordingAttemptId || '').trim();
    const containerLayout = String(info.containerLayout || startInput.containerLayout || '').trim();
    const captureEpoch = Number(info.captureEpoch ?? startInput.captureEpoch);
    const persistedAttemptId = String(active.meeting.recordingAttemptId || '').trim();
    if (!recordingAttemptId) throw codedError('RECORDING_ATTEMPT_ID_REQUIRED');
    if (persistedAttemptId && persistedAttemptId !== recordingAttemptId) {
      await Promise.resolve(recorder?.interrupt?.('recording_attempt_mismatch')).catch(() => {});
      throw codedError('RECORDING_ATTEMPT_ID_MISMATCH');
    }
    if (containerLayout !== INDEPENDENT_MP4_SEGMENTS_V1) {
      await Promise.resolve(recorder?.interrupt?.('recording_container_layout_mismatch')).catch(() => {});
      throw codedError('RECORDING_CONTAINER_LAYOUT_MISMATCH');
    }
    if (captureEpoch !== startInput.captureEpoch) {
      await Promise.resolve(recorder?.interrupt?.('capture_epoch_mismatch')).catch(() => {});
      throw codedError('CAPTURE_EPOCH_MISMATCH');
    }
    return persistTransition({
      type: 'recorder_started',
      actualStarted: true,
      explicitResume,
      recordingAttemptId,
      captureEpoch,
      containerLayout
    });
  }

  async function resumePausedRecorder() {
    const startInput = buildRecorderStartInput(true);
    const startResult = usesRotatingIndependentMp4
      ? await recorder.resume(startInput)
      : await recorder.resume();
    return persistRecorderStarted({ explicitResume: true, startInput, startResult });
  }

  async function startRecording() {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    if (active.meeting.recordingState === 'stopped') throw codedError('SESSION_NOT_READY');
    if (active.meeting.recordingState === 'interrupted'
      && active.meeting.interruptionReason === 'user_pause'
      && recorder?.status === 'paused'
      && typeof recorder.resume === 'function') {
      return resumePausedRecorder();
    }
    if (active.meeting.recordingState === 'draft') await persistTransition({ type: 'prepare' });
    if (active.meeting.recordingState === 'failed_retryable') await retryRecording();
    const explicitResume = active.meeting.recordingState === 'interrupted';
    if (!['ready', 'interrupted'].includes(active.meeting.recordingState)) throw codedError('SESSION_NOT_READY');
    const activeRecorder = await ensureRecorder();
    const startInput = buildRecorderStartInput(explicitResume);
    let startResult;
    try {
      startResult = await activeRecorder.start(startInput);
    } catch (error) {
      const failureCode = error?.code || 'MEDIA_RECORDER_START_FAILED';
      const failed = transitionMeetingPhase1Session(active.meeting, { type: 'recorder_start_failed', errorCode: failureCode }, { now: timestamp(now) });
      if (failed.accepted) {
        await store.saveSession(context, failed.state);
        active = await store.getMeeting(context, active.meeting.meetingId);
        await reloadMeetings();
        notify();
      }
      throw error;
    }
    return persistRecorderStarted({ explicitResume, startInput, startResult });
  }

  async function stopRecording() {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    if (active.meeting.recordingState === 'stopped') return active;
    if (active.meeting.recordingState === 'finalization_pending') return retryFinalize();
    const activeRecorder = await ensureRecorder();
    let finalization;
    if (['recording', 'paused'].includes(activeRecorder.status)) {
      finalizationStopInProgress = true;
      try {
        finalization = await activeRecorder.stop({ reason: 'user_stop' });
      } catch (error) {
        finalization = {
          finalized: false,
          finalizationPending: true,
          finalizationErrorCode: error?.code || 'FINALIZATION_PENDING'
        };
      } finally {
        finalizationStopInProgress = false;
      }
    }
    if (usesRotatingIndependentMp4 && active?.meeting) {
      active = await store.getMeeting(context, active.meeting.meetingId);
    }
    if (!active?.meeting || active.meeting.recordingState === 'failed_retryable') return active;
    if (finalization?.finalizationPending === true || finalization?.finalized === false) {
      return persistTransition({
        type: 'finalization_pending',
        errorCode: finalization.finalizationErrorCode || finalization.errorCode || 'FINALIZATION_PENDING'
      });
    }
    return persistTransition({ type: 'stop' });
  }

  async function retryFinalize() {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    if (active.meeting.recordingState === 'stopped') return active;
    if (active.meeting.recordingState !== 'finalization_pending') throw codedError('SESSION_NOT_FINALIZATION_PENDING');
    if (active.meeting.containerLayout === INDEPENDENT_MP4_SEGMENTS_V1
      || active.manifest?.containerLayout === INDEPENDENT_MP4_SEGMENTS_V1) {
      try {
        await store.replayPendingCaptureUnits(context, { meetingId: active.meeting.meetingId });
        await store.finalizeCaptureManifest(context, {
          meetingId: active.meeting.meetingId,
          expectedRecordingAttemptId: active.meeting.recordingAttemptId,
          allowSafeTailClosure: true
        });
        active = await store.getMeeting(context, active.meeting.meetingId);
      } catch (error) {
        const code = String(error?.code || '');
        if (code.includes('JOURNAL') || code.includes('ENCRYPT') || code.includes('INTEGRITY')) {
          throw codedError('FINALIZATION_PENDING_JOURNAL', error);
        }
        if (code.includes('COMMIT') || code.includes('ATOMIC') || code.includes('OUT_OF_ORDER')) {
          throw codedError('FINALIZATION_PENDING_COMMIT', error);
        }
        throw codedError('FINALIZATION_PENDING_MANIFEST', error);
      }
    }
    return persistTransition({ type: 'finalize' });
  }

  async function pauseRecording() {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    if (active.meeting.recordingState !== 'recording') throw codedError('SESSION_NOT_RECORDING');
    const activeRecorder = await ensureRecorder();
    if (typeof activeRecorder.pause !== 'function') throw codedError('MEETING_RECORDER_PAUSE_REQUIRED');
    if (activeRecorder.status !== 'recording') throw codedError('RECORDER_NOT_RECORDING');
    const recorderPause = await activeRecorder.pause();
    if (usesRotatingIndependentMp4) {
      active = await store.getMeeting(context, active.meeting.meetingId);
    }
    const paused = await persistTransition({ type: 'interrupted', reason: 'user_pause' });
    if (recorderPause?.sessionBoundary !== true) return paused;
    return Object.freeze({
      ...paused,
      recorderSessionBoundary: true,
      recorderBoundaryPending: recorderPause.boundaryPending === true,
      recorderBoundaryErrorCode: String(recorderPause.errorCode || '')
    });
  }

  async function resumeRecording() {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    if (active.meeting.recordingState === 'interrupted'
      && active.meeting.interruptionReason === 'user_pause'
      && recorder?.status === 'paused'
      && typeof recorder.resume === 'function') {
      return resumePausedRecorder();
    }
    return startRecording();
  }

  async function interruptRecording(reason = 'recording_interrupted') {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    const activeRecorder = await ensureRecorder();
    if (!['recording', 'paused'].includes(activeRecorder.status)) {
      if (active.meeting.recordingState === 'interrupted') return active;
      return active;
    }
    finalizationStopInProgress = true;
    try {
      await activeRecorder.interrupt(reason);
    } finally {
      finalizationStopInProgress = false;
    }
    return active;
  }

  async function dispose() {
    if (['recording', 'paused'].includes(recorder?.status)) {
      finalizationStopInProgress = true;
      try {
        await recorder.interrupt('page_unmounted');
      } catch {
        // A page-unload flush can be cut short by the browser. Preserve the
        // already-started meeting as explicitly recoverable rather than
        // leaving a misleading recording state in storage.
        if (active?.meeting?.recordingState === 'recording') {
          await persistTransition({ type: 'interrupted', reason: 'page_unmounted' }).catch(() => {});
        }
      } finally {
        finalizationStopInProgress = false;
      }
    }
    if (importManager.getSnapshot().importState === 'importing' || importManager.getSnapshot().importState === 'validating') await importManager.cancelImport().catch(() => {});
    unsubscribeImport();
    listeners.clear();
  }

  async function importAudio(file, options = {}) {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    const result = await importManager.importFile({
      ...options,
      file,
      meetingId: active.meeting.meetingId
    });
    active = await store.getMeeting(context, active.meeting.meetingId);
    await reloadMeetings();
    notify();
    return result;
  }

  async function cancelAudioImport() {
    const result = await importManager.cancelImport();
    if (active?.meeting) active = await store.getMeeting(context, active.meeting.meetingId);
    notify();
    return result;
  }

  async function deleteAudioSource(sourceId) {
    if (!active?.meeting) throw codedError('MEETING_NOT_OPEN');
    await importManager.deleteSource(active.meeting.meetingId, sourceId);
    active = await store.getMeeting(context, active.meeting.meetingId);
    await reloadMeetings();
    notify();
    return true;
  }

  async function renameMeeting(meetingId, title, expectedTitle) {
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    if (['recording', 'paused'].includes(recorder?.status)
      || ['importing', 'validating'].includes(importManager.getSnapshot().importState)) throw codedError('MEETING_RENAME_BUSY');
    let meeting;
    try {
      meeting = await store.renameMeeting(context, { meetingId: normalizedMeetingId, title, expectedTitle });
    } catch (error) {
      if (error?.code === 'MEETING_RENAME_CONFLICT') {
        meetings = await store.listMeetings(context);
        const latest = meetings.find((item) => item.meetingId === normalizedMeetingId);
        if (latest && active?.meeting?.meetingId === normalizedMeetingId) active = { ...active, meeting: { ...active.meeting, title: latest.title } };
        notify();
      }
      throw error;
    }
    meetings = meetings.map((item) => item.meetingId === normalizedMeetingId ? { ...item, title: meeting.title } : item);
    if (active?.meeting?.meetingId === normalizedMeetingId) active = { ...active, meeting: { ...active.meeting, title: meeting.title } };
    notify();
    return meeting;
  }

  async function deleteMeeting(meetingId) {
    const normalizedMeetingId = required(meetingId, 'MEETING_ID_REQUIRED');
    const candidates = [active?.meeting, ...meetings].filter((meeting) => meeting?.meetingId === normalizedMeetingId);
    if (candidates.some((meeting) => ['recording', 'finalization_pending'].includes(meeting.recordingState))) {
      throw codedError('MEETING_DELETE_BUSY');
    }
    await store.deleteMeeting(context, normalizedMeetingId);
    meetings = meetings.filter((meeting) => meeting.meetingId !== normalizedMeetingId);
    if (active?.meeting?.meetingId === normalizedMeetingId) {
      active = null;
      recorderInfo = null;
    }
    notify();
    return true;
  }

  return Object.freeze({
    initialize,
    createMeeting,
    openMeeting,
    reloadMeetings,
    startRecording,
    pauseRecording,
    resumeRecording,
    stopRecording,
    retryFinalize,
    interruptRecording,
    retryRecording,
    importAudio,
    cancelAudioImport,
    deleteAudioSource,
    deleteMeeting,
    renameMeeting,
    dispose,
    getSnapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw codedError('MEETING_LISTENER_REQUIRED');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}
