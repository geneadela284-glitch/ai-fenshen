import {
  AAC_MP4_EXPERIMENT,
  AAC_MP4_MIME_TYPES,
  describeRecordingMimeType,
  getMeetingRecordingCodecExperiment,
  isAacMp4MimeType
} from './meetingRecordingCodecExperiment.js';
import {
  isVerifiedIosAacRecordingDevice,
  validateMeetingRecordingMediaProfile
} from './meetingRecordingMediaProfile.js';
import {
  ACTIVE_REQUEST_DATA_MODE,
  IOS_AAC_CAPTURE_UNIT_MS,
  IOS_AAC_NATIVE_TIMESLICE_MS,
  PASSIVE_NATIVE_TIMESLICE_MODE,
  ROTATING_INDEPENDENT_MP4_MODE,
  isPassiveNativeTimesliceMode,
  isRotatingIndependentMp4Mode
} from './meetingRecordingDurabilityMode.js';
import { createMeetingRecorderRotationCoordinator } from './meetingRecorderRotationCoordinator.js';
import { INDEPENDENT_MP4_SEGMENTS_V1 } from './meetingRecordingContainerLayout.js';

const DEFAULT_SEGMENT_DURATION_MS = 20_000;
const DEFAULT_MAX_SEGMENT_BYTES = 8 * 1024 * 1024;
const DEFAULT_CHECKPOINT_INTERVAL_MS = 12_000;
const DEFAULT_PERSISTENCE_STALL_TIMEOUT_MS = 40_000;
const DEFAULT_CHECKPOINT_EVENT_TIMEOUT_MS = 10_000;
const MIME_CANDIDATES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/wav'
]);

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function timestamp(now) {
  return typeof now === 'function' ? now() : now || new Date().toISOString();
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function selectAudioMimeType(MediaRecorderImpl, candidates = MIME_CANDIDATES) {
  if (typeof MediaRecorderImpl?.isTypeSupported !== 'function') return '';
  return candidates.find((mimeType) => {
    try {
      return MediaRecorderImpl.isTypeSupported(mimeType);
    } catch {
      return false;
    }
  }) || '';
}

export function inspectMeetingRecorderCapabilities(MediaRecorderImpl, candidates = MIME_CANDIDATES) {
  return Object.freeze([...candidates].map((requestedMimeType) => {
    let supported = false;
    try {
      supported = typeof MediaRecorderImpl?.isTypeSupported === 'function'
        && MediaRecorderImpl.isTypeSupported(requestedMimeType) === true;
    } catch {
      supported = false;
    }
    return Object.freeze({ requestedMimeType, supported });
  }));
}

export async function probeMeetingRecorderCodecs({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderImpl = globalThis.MediaRecorder,
  candidates = MIME_CANDIDATES,
  durationMs = 250,
  setTimeoutImpl = globalThis.setTimeout
} = {}) {
  if (!mediaDevices?.getUserMedia) throw codedError('AUDIO_INPUT_UNAVAILABLE');
  if (typeof MediaRecorderImpl !== 'function') throw codedError('MEDIA_RECORDER_UNAVAILABLE');
  if (!Number.isSafeInteger(durationMs) || durationMs < 0) throw codedError('MEDIA_PROBE_DURATION_INVALID');
  if (typeof setTimeoutImpl !== 'function') throw codedError('MEDIA_PROBE_TIMER_UNAVAILABLE');
  const capabilities = inspectMeetingRecorderCapabilities(MediaRecorderImpl, candidates);
  const stream = await mediaDevices.getUserMedia({ audio: true });
  try {
    const results = [];
    for (const capability of capabilities) {
      if (!capability.supported) {
        results.push(Object.freeze({ ...capability }));
        continue;
      }
      let recorder;
      try {
        recorder = new MediaRecorderImpl(stream, { mimeType: capability.requestedMimeType });
      } catch {
        results.push(Object.freeze({ ...capability, actualMimeType: null, encodedBytes: 0, errorCode: 'MEDIA_RECORDER_CONSTRUCTOR_FAILED' }));
        continue;
      }
      const payloads = [];
      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
        recorder.onerror = () => resolve();
      });
      recorder.ondataavailable = (event) => {
        if (event?.data?.size) payloads.push(event.data);
      };
      try {
        recorder.start();
        await new Promise((resolve, reject) => {
          setTimeoutImpl(() => {
            try {
              recorder.stop();
              resolve();
            } catch (error) {
              reject(error);
            }
          }, durationMs);
        });
        await stopped;
        // Safari may deliver the final dataavailable event after onstop.
        await new Promise((resolve) => setTimeoutImpl(resolve, 0));
        results.push(Object.freeze({
          ...capability,
          actualMimeType: String(recorder.mimeType || capability.requestedMimeType),
          encodedBytes: payloads.reduce((total, payload) => total + Number(payload.size || 0), 0)
        }));
      } catch {
        results.push(Object.freeze({ ...capability, actualMimeType: null, encodedBytes: 0, errorCode: 'MEDIA_RECORDER_PROBE_FAILED' }));
      }
    }
    return Object.freeze(results);
  } finally {
    stopTracks(stream);
  }
}

function normalizeMediaError(error) {
  if (error?.code) return error;
  if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return codedError('MEDIA_PERMISSION_DENIED', error);
  if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return codedError('AUDIO_INPUT_UNAVAILABLE', error);
  if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return codedError('AUDIO_INPUT_BUSY', error);
  return codedError('MEDIA_DEVICE_UNAVAILABLE', error);
}

function stopTracks(stream) {
  try {
    for (const track of stream?.getTracks?.() || []) track.stop?.();
  } catch {
    // Cleanup is best-effort; the state machine remains fail-closed.
  }
}

let rotatingControllerGeneration = 0;

async function prepareVerifiedRotatingAacRecorder({
  stream,
  MediaRecorderImpl,
  preferredMimeType,
  recordingCodecExperiment,
  windowImpl,
  mediaProfile,
  requireAacPrimaryGate,
  recordingAttemptEvidence,
  recordingAttemptId = ''
}) {
  if (requireAacPrimaryGate !== true || !isVerifiedIosAacRecordingDevice(mediaProfile)) {
    throw codedError('AAC_PRE_RECORD_GATE_REQUIRED');
  }
  if (typeof recordingAttemptEvidence !== 'function') {
    throw codedError('AAC_PRE_RECORD_EVIDENCE_UNAVAILABLE');
  }
  const experiment = String(recordingCodecExperiment || '').trim() === AAC_MP4_EXPERIMENT
    ? AAC_MP4_EXPERIMENT
    : getMeetingRecordingCodecExperiment({ storage: windowImpl?.sessionStorage });
  if (experiment !== AAC_MP4_EXPERIMENT) throw codedError('AAC_PRIMARY_NOT_ACTIVE');
  const preferred = String(preferredMimeType || '').trim();
  const candidates = preferred
    ? [preferred, ...AAC_MP4_MIME_TYPES.filter((candidate) => candidate !== preferred)]
    : [...AAC_MP4_MIME_TYPES];
  const requestedMimeType = selectAudioMimeType(MediaRecorderImpl, candidates);
  if (!requestedMimeType) throw codedError('AAC_EXPERIMENT_UNSUPPORTED');
  const constructorOptions = Object.freeze({ mimeType: requestedMimeType });
  let recorder;
  let constructorError = null;
  try {
    recorder = new MediaRecorderImpl(stream, constructorOptions);
  } catch (error) {
    constructorError = error;
  }
  if (constructorError) {
    await recordingAttemptEvidence(Object.freeze({
      ...(recordingAttemptId ? { recordingAttemptId } : {}),
      mediaProfile: mediaProfile || null,
      isIphoneProfile: true,
      requestedMimeType,
      constructorOptions,
      actualMimeType: '',
      capabilities: inspectMeetingRecorderCapabilities(MediaRecorderImpl, AAC_MP4_MIME_TYPES),
      recordingCodecExperiment: experiment,
      fallbackReason: mediaProfile?.fallback ? mediaProfile.reason : '',
      mismatchCode: 'AAC_CONSTRUCTOR_MIME_MISMATCH',
      constructorErrorCode: constructorError?.code || constructorError?.name || 'MEDIA_RECORDER_CONSTRUCTOR_FAILED'
    }));
    throw codedError('AAC_EXPERIMENT_UNSUPPORTED', constructorError);
  }
  const actualMimeType = String(recorder.mimeType || requestedMimeType);
  const profileValidation = validateMeetingRecordingMediaProfile({
    profile: mediaProfile?.profile || mediaProfile,
    actualMimeType
  });
  const runtimeEvidence = Object.freeze({
    ...(recordingAttemptId ? { recordingAttemptId } : {}),
    mediaProfile: mediaProfile || null,
    isIphoneProfile: true,
    requestedMimeType,
    constructorOptions,
    actualMimeType,
    capabilities: inspectMeetingRecorderCapabilities(MediaRecorderImpl, AAC_MP4_MIME_TYPES),
    recordingCodecExperiment: experiment,
    fallbackReason: mediaProfile?.fallback ? mediaProfile.reason : '',
    mismatchCode: profileValidation.ok ? '' : profileValidation.errorCode,
    constructorErrorCode: ''
  });
  const recordingAttemptAck = await recordingAttemptEvidence(runtimeEvidence);
  if (recordingAttemptAck?.ok !== true) {
    throw codedError(recordingAttemptAck?.errorCode || profileValidation.errorCode || 'AAC_PRIMARY_NOT_ACTIVE');
  }
  if (!profileValidation.ok || !isAacMp4MimeType(actualMimeType)) {
    throw codedError(profileValidation.errorCode || 'AAC_EXPERIMENT_MIME_MISMATCH');
  }
  const acknowledgedAttemptId = String(recordingAttemptAck.recordingAttemptId || recordingAttemptId || '').trim();
  if (!acknowledgedAttemptId) throw codedError('RECORDING_ATTEMPT_ID_REQUIRED');
  if (recordingAttemptId && acknowledgedAttemptId !== recordingAttemptId) {
    throw codedError('RECORDING_ATTEMPT_ID_MISMATCH');
  }
  return Object.freeze({
    recorder,
    requestedMimeType,
    actualMimeType,
    recordingAttemptId: acknowledgedAttemptId,
    recordingInfo: Object.freeze({
      recordingCodecExperiment: experiment,
      mediaProfile: mediaProfile || null,
      selectedMimeType: requestedMimeType,
      actualMimeType,
      recordingAttemptId: acknowledgedAttemptId,
      containerLayout: INDEPENDENT_MP4_SEGMENTS_V1,
      ...describeRecordingMimeType(actualMimeType)
    })
  });
}

function createRotatingMeetingRecorderController(options = {}) {
  const {
    mediaDevices = globalThis.navigator?.mediaDevices,
    MediaRecorderImpl = globalThis.MediaRecorder,
    windowImpl = globalThis.window,
    now = () => new Date().toISOString(),
    monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(),
    preferredMimeType = '',
    recordingCodecExperiment = '',
    mediaProfile = null,
    requireAacPrimaryGate = false,
    recordingAttemptEvidence = null,
    preRecordErrorCode = '',
    capturePersistencePort = null,
    captureUnitFactory,
    inspectContainer,
    captureUnitMs = IOS_AAC_CAPTURE_UNIT_MS,
    maxSegmentBytes = DEFAULT_MAX_SEGMENT_BYTES,
    stopTimeoutMs = 10_000,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
    onStarted = () => {},
    onInterrupted = async () => {},
    onError = () => {},
    onPersistenceStatus = async () => {},
    onCheckpointTrace = async () => {},
    pageEpoch = `page-rotation-${Date.now()}-${rotatingControllerGeneration + 1}`,
    recorderGeneration = rotatingControllerGeneration + 1
  } = options;
  rotatingControllerGeneration = Math.max(rotatingControllerGeneration + 1, Number(recorderGeneration) || 0);
  let status = 'idle';
  let coordinator = null;
  let startPromise = null;
  let recordingInfo = null;

  function report(error) {
    try { onError(error); } catch { /* Error reporting is isolated. */ }
  }

  async function start(input = {}) {
    if (coordinator?.status === 'recording') {
      return Object.freeze({ actualStarted: true, idempotent: true, ...(recordingInfo || {}) });
    }
    if (startPromise) return startPromise;
    const blockedCode = String(preRecordErrorCode || '').trim();
    if (blockedCode) throw codedError(blockedCode);
    if (!mediaDevices?.getUserMedia) throw codedError('AUDIO_INPUT_UNAVAILABLE');
    if (typeof MediaRecorderImpl !== 'function') throw codedError('MEDIA_RECORDER_UNAVAILABLE');
    status = 'starting';
    startPromise = (async () => {
      let initialStream = null;
      try {
        initialStream = await mediaDevices.getUserMedia({ audio: true });
        const prepared = await prepareVerifiedRotatingAacRecorder({
          stream: initialStream,
          MediaRecorderImpl,
          preferredMimeType,
          recordingCodecExperiment,
          windowImpl,
          mediaProfile,
          requireAacPrimaryGate,
          recordingAttemptEvidence,
          recordingAttemptId: input.recordingAttemptId
        });
        recordingInfo = prepared.recordingInfo;
        let firstStream = initialStream;
        coordinator = createMeetingRecorderRotationCoordinator({
          mediaDevices: {
            async getUserMedia(constraints) {
              if (firstStream) {
                const value = firstStream;
                firstStream = null;
                return value;
              }
              return mediaDevices.getUserMedia(constraints);
            }
          },
          MediaRecorderImpl,
          firstRecorderInstance: prepared.recorder,
          mimeType: prepared.actualMimeType,
          pageEpoch,
          recorderGeneration,
          ...(captureUnitFactory ? { captureUnitFactory } : {}),
          capturePersistencePort,
          ...(inspectContainer ? { inspectContainer } : {}),
          captureUnitMs,
          sealTimeoutMs: stopTimeoutMs,
          maxSegmentBytes,
          now,
          monotonicNow,
          setTimeoutImpl,
          clearTimeoutImpl,
          onStarted(info) {
            const result = Object.freeze({ ...info, ...recordingInfo, mimeType: prepared.actualMimeType });
            try { onStarted(result); } catch { /* Manager also receives the returned result. */ }
          },
          onInterrupted,
          onError: report,
          onPersistenceStatus,
          onCheckpointTrace
        });
        const started = await coordinator.start({
          ...input,
          recordingAttemptId: prepared.recordingAttemptId,
          containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
        });
        status = coordinator.status;
        return Object.freeze({ ...started, ...recordingInfo, mimeType: prepared.actualMimeType });
      } catch (error) {
        if (!coordinator) stopTracks(initialStream);
        status = 'idle';
        const normalized = error?.code ? error : normalizeMediaError(error);
        report(normalized);
        throw normalized;
      }
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function pause() {
    if (!coordinator) throw codedError('RECORDER_NOT_RECORDING');
    const result = await coordinator.pause();
    status = coordinator.status;
    return result;
  }

  async function resume(input = {}) {
    if (!coordinator) throw codedError('RECORDER_NOT_PAUSED');
    const result = await coordinator.resume(input);
    status = coordinator.status;
    return Object.freeze({ ...result, ...(recordingInfo || {}) });
  }

  async function stop(input = {}) {
    if (!coordinator) return Object.freeze({ idempotent: true, reason: input.reason || 'user_stop' });
    const result = await coordinator.stop(input);
    status = coordinator.status;
    return result;
  }

  async function interrupt(reason = 'recording_interrupted') {
    if (!coordinator) return Object.freeze({ idempotent: true, reason });
    const result = await coordinator.interrupt(reason);
    status = coordinator.status;
    return result;
  }

  function dispose() {
    const disposed = coordinator?.dispose?.() || false;
    status = coordinator?.status || 'idle';
    return disposed;
  }

  return Object.freeze({
    get status() { return coordinator?.status || status; },
    start,
    pause,
    resume,
    stop,
    interrupt,
    dispose,
    getSnapshot() {
      return coordinator?.getSnapshot?.() || Object.freeze({ status, recordingAttemptId: recordingInfo?.recordingAttemptId || '' });
    }
  });
}

export function createMeetingRecorderController(options = {}) {
  return isRotatingIndependentMp4Mode(options?.checkpointMode)
    ? createRotatingMeetingRecorderController(options)
    : createLegacyMeetingRecorderController(options);
}

function createLegacyMeetingRecorderController({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderImpl = globalThis.MediaRecorder,
  documentImpl = globalThis.document,
  windowImpl = globalThis.window,
  now = () => new Date().toISOString(),
  segmentDurationMs = DEFAULT_SEGMENT_DURATION_MS,
  maxSegmentBytes = DEFAULT_MAX_SEGMENT_BYTES,
  preferredMimeType = '',
  startTimeoutMs = 5_000,
  stopTimeoutMs = 5_000,
  onStarted = () => {},
  onSegment = async () => {},
  onInterrupted = async () => {},
  onError = () => {},
  onPersistenceStatus = async () => {},
  onCheckpointTrace = async () => {},
  recordingCodecExperiment = '',
  mediaProfile = null,
  recordingAttemptEvidence = null,
  requireAacPrimaryGate = false,
  preRecordErrorCode = '',
  checkpointMode = ACTIVE_REQUEST_DATA_MODE,
  nativeTimesliceMs = IOS_AAC_NATIVE_TIMESLICE_MS,
  checkpointIntervalMs = DEFAULT_CHECKPOINT_INTERVAL_MS,
  persistenceStallTimeoutMs = DEFAULT_PERSISTENCE_STALL_TIMEOUT_MS,
  checkpointEventTimeoutMs = DEFAULT_CHECKPOINT_EVENT_TIMEOUT_MS,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout
} = {}) {
  let status = 'idle';
  let recorder = null;
  let stream = null;
  let activeContext = null;
  let recorderGeneration = 0;
  let recorderInstanceCounter = 0;
  let stopPromise = null;
  let startPromise = null;
  let pausePromise = null;
  let resumePromise = null;
  let interruptionPromise = null;
  let requiresExplicitResume = false;
  let sessionBoundaryPaused = false;
  let removeLifecycleListeners = () => {};
  const reportedErrors = new WeakSet();

  function report(error) {
    if (error && typeof error === 'object') {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    try {
      onError(error);
    } catch {
      // Error reporting must never change the recording state contract.
    }
  }

  function isCurrentContext(context) {
    return activeContext === context && context?.generation === recorderGeneration;
  }

  function usesPassiveNativeTimeslice(context) {
    return isPassiveNativeTimesliceMode(context?.checkpointMode);
  }

  function resolveDataWaiters(context) {
    if (!context.dataWaiters.length) return;
    const remaining = [];
    for (const waiter of context.dataWaiters) {
      const event = context.dataEvents.find((candidate) => (
        candidate.serial > waiter.baseline
        && (!waiter.requireData || candidate.hasData)
      ));
      if (event) waiter.resolve(event);
      else remaining.push(waiter);
    }
    context.dataWaiters = remaining;
  }

  function waitForDataEvent(context, baseline, { requireData = false } = {}) {
    const existing = context.dataEvents.find((event) => (
      event.serial > baseline
      && (!requireData || event.hasData)
    ));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      context.dataWaiters.push({ baseline, requireData, resolve });
    });
  }

  function removeDataWaiter(context, baseline, requireData) {
    context.dataWaiters = context.dataWaiters.filter((waiter) => (
      waiter.baseline !== baseline || waiter.requireData !== requireData
    ));
  }

  async function waitForCheckpointData(context, baseline) {
    const wait = waitForDataEvent(context, baseline, { requireData: true });
    let timer = null;
    const finalFlushAbort = context.checkpointAbortPromise
      ? context.checkpointAbortPromise.then(() => {
        throw codedError(context.checkpointAbortCode || 'RECORDING_CHECKPOINT_ABORTED_FOR_FINAL_FLUSH');
      })
      : new Promise(() => {});
    const timeout = new Promise((_, reject) => {
      timer = setTimeoutImpl(() => reject(codedError('RECORDING_CHECKPOINT_DATA_TIMEOUT')), checkpointEventTimeoutMs);
    });
    try {
      return await Promise.race([wait, timeout, finalFlushAbort]);
    } finally {
      if (timer !== null) clearTimeoutImpl(timer);
      removeDataWaiter(context, baseline, true);
    }
  }

  async function reportPersistenceStatus(context, phase, extra = {}) {
    try {
      await onPersistenceStatus(Object.freeze({
        phase,
        lastSuccessfulPersistAt: context.lastSuccessfulPersistAt,
        lastPersistedSequence: context.lastPersistedSequence,
        lastCommittedDurationMs: context.lastCommittedDurationMs,
        ...extra
      }));
    } catch (error) {
      report(error);
    }
  }

  async function emitCheckpointTrace(context, event, extra = {}) {
    const activeTrace = context?.currentCheckpointTrace
      || context?.pauseBoundaryTrace
      || context?.finalizationTrace;
    const passive = usesPassiveNativeTimeslice(context);
    const trace = Object.freeze({
      event,
      timestamp: timestamp(now),
      recorderGeneration: context?.generation ?? recorderGeneration,
      pageEpoch: context?.pageEpoch || '',
      recordingAttemptId: context?.recordingInfo?.recordingAttemptId || '',
      checkpointId: activeTrace?.checkpointId || '',
      checkpointMode: context?.checkpointMode || ACTIVE_REQUEST_DATA_MODE,
      ...(passive ? {
        requestDataCalled: false,
        requestDataReturned: false
      } : {}),
      ...extra
    });
    try {
      await onCheckpointTrace(trace);
    } catch {
      // Diagnostic persistence must never alter recording behavior.
    }
    return trace;
  }

  function stopCheckpointScheduler(context) {
    if (context?.checkpointTimer === null || context?.checkpointTimer === undefined) return;
    clearIntervalImpl(context.checkpointTimer);
    context.checkpointTimer = null;
    void emitCheckpointTrace(context, 'checkpoint_scheduler_cancelled', {
      schedulerNextTick: 'cancelled',
      schedulerRole: usesPassiveNativeTimeslice(context) ? 'watchdog' : 'active-checkpoint',
      inFlight: Boolean(context.checkpointInFlight)
    });
  }

  function persistenceAgeMs(context) {
    const last = Date.parse(context.lastSuccessfulPersistAt || '');
    const current = Date.parse(timestamp(now));
    if (!Number.isFinite(last) || !Number.isFinite(current)) return Infinity;
    return Math.max(0, current - last);
  }

  async function runPeriodicCheckpoint(context, reason = 'periodic') {
    if (!isCurrentContext(context) || context.cleaned || status !== 'recording' || context.finalFlushStarted) return;
    if (typeof context.recorder?.requestData !== 'function') return;
    if (context.checkpointInFlight) {
      void emitCheckpointTrace(context, 'checkpoint_skipped_in_flight', { reason, inFlight: true });
      return;
    }
    const baseline = context.dataEventSerial;
    const errorBaseline = context.errors.length;
    const checkpointId = `checkpoint-${context.generation}-${context.checkpointRequestCount + 1}-${Date.now()}`;
    context.currentCheckpointTrace = {
      checkpointId,
      reason,
      requestedAt: timestamp(now),
      requestDataCalled: false,
      requestDataReturned: false,
      inFlight: true
    };
    void emitCheckpointTrace(context, 'checkpoint_requested', {
      reason,
      requestedAt: context.currentCheckpointTrace.requestedAt,
      inFlight: true
    });
    const run = (async () => {
      try {
        context.checkpointRequestCount += 1;
        const dataEvent = waitForCheckpointData(context, baseline);
        context.currentCheckpointTrace.requestDataCalled = true;
        try {
          context.recorder.requestData();
          context.currentCheckpointTrace.requestDataReturned = true;
        } catch (error) {
          void dataEvent.catch(() => {});
          throw codedError('RECORDING_CHECKPOINT_REQUEST_DATA_FAILED', error);
        }
        void emitCheckpointTrace(context, 'checkpoint_request_data', {
          requestDataCalled: true,
          requestDataReturned: true,
          inFlight: true
        });
        const event = await dataEvent;
        await event.commitPromise;
        await waitForQueue(context, errorBaseline);
        throwIfRecorderError(context);
        context.currentCheckpointTrace.inFlight = false;
        context.currentCheckpointTrace.success = true;
        context.lastCheckpointErrorCode = '';
        context.currentCheckpointTrace.committedSequence = context.lastPersistedSequence;
        context.currentCheckpointTrace.committedDurationMs = context.lastCommittedDurationMs;
        context.currentCheckpointTrace.persistedBytes = context.lastPersistedBytes;
        void emitCheckpointTrace(context, 'checkpoint_succeeded', {
          ...context.currentCheckpointTrace,
          inFlight: false,
          success: true
        });
        await reportPersistenceStatus(context, 'checkpoint_success', { reason });
      } catch (error) {
        const errorCode = error?.code || 'RECORDING_CHECKPOINT_FAILED';
        const aborted = errorCode.startsWith('RECORDING_CHECKPOINT_ABORTED_FOR_');
        if (!aborted) context.lastCheckpointErrorCode = errorCode;
        context.currentCheckpointTrace.inFlight = false;
        context.currentCheckpointTrace.success = false;
        context.currentCheckpointTrace.failure = !aborted;
        context.currentCheckpointTrace.errorCode = errorCode;
        context.currentCheckpointTrace.timeout = errorCode.includes('TIMEOUT');
        if (!aborted && errorCode === 'RECORDING_CHECKPOINT_DATA_TIMEOUT') {
          context.lateCheckpointDataPending = true;
          context.lateCheckpointDataBaseline = baseline;
          context.lateCheckpointId = context.currentCheckpointTrace.checkpointId;
        }
        void emitCheckpointTrace(context, aborted ? 'checkpoint_aborted' : 'checkpoint_failed', {
          ...context.currentCheckpointTrace,
          inFlight: false,
          success: false,
          failure: !aborted,
          aborted,
          errorCode,
          timeout: errorCode.includes('TIMEOUT')
        });
        if (!aborted) {
          await reportPersistenceStatus(context, 'checkpoint_failed', {
            reason,
            errorCode
          });
        }
      } finally {
        context.currentCheckpointTrace = null;
      }
    })();
    context.checkpointInFlight = run;
    try {
      await run;
    } finally {
      if (context.checkpointInFlight === run) context.checkpointInFlight = null;
      void emitCheckpointTrace(context, 'checkpoint_run_settled', { reason, inFlight: false });
    }
  }

  function checkPersistenceStall(context) {
    if (!isCurrentContext(context) || context.cleaned || status !== 'recording' || context.finalFlushStarted) return;
    if (persistenceAgeMs(context) < persistenceStallTimeoutMs || context.persistenceStallReported) return;
    context.persistenceStallReported = true;
    void reportPersistenceStatus(context, 'stalled', {
      errorCode: 'RECORDING_PERSISTENCE_STALLED',
      ageMs: persistenceAgeMs(context)
    });
  }

  function startCheckpointScheduler(context) {
    if (context.checkpointTimer || typeof setIntervalImpl !== 'function') return;
    const tick = () => {
      checkPersistenceStall(context);
      if (!usesPassiveNativeTimeslice(context)) {
        void runPeriodicCheckpoint(context).catch(report);
      }
    };
    context.checkpointTimer = setIntervalImpl(tick, checkpointIntervalMs);
    context.checkpointTimer?.unref?.();
    void emitCheckpointTrace(context, 'checkpoint_scheduler_armed', {
      schedulerNextTick: 'armed',
      schedulerRole: usesPassiveNativeTimeslice(context) ? 'watchdog' : 'active-checkpoint',
      inFlight: false
    });
  }

  function abortCheckpoint(context, code = 'RECORDING_CHECKPOINT_ABORTED_FOR_FINAL_FLUSH') {
    if (!context || context.checkpointAbortRequested) return;
    context.checkpointAbortRequested = true;
    context.checkpointAbortCode = code;
    context.resolveCheckpointAbort?.();
  }

  function abortCheckpointForFinalFlush(context) {
    abortCheckpoint(context, 'RECORDING_CHECKPOINT_ABORTED_FOR_FINAL_FLUSH');
  }

  function resetCheckpointAbort(context) {
    if (!context || context.cleaned || context.finalFlushStarted) return;
    context.checkpointAbortRequested = false;
    context.checkpointAbortCode = '';
    context.checkpointAbortPromise = new Promise((resolve) => {
      context.resolveCheckpointAbort = resolve;
    });
  }

  function throwIfRecorderError(context) {
    if (context.recorderError) throw context.recorderError;
  }

  function cleanupContext(context) {
    if (!context || context.cleaned) return;
    context.cleaned = true;
    context.dataWaiters = [];
    stopCheckpointScheduler(context);
    if (activeContext !== context) return;
    removeLifecycleListeners();
    removeLifecycleListeners = () => {};
    stopTracks(stream);
    stream = null;
    recorder = null;
    activeContext = null;
    status = 'idle';
  }

  function attachLifecycleListeners(context) {
    if (context.lifecycleAttached) return;
    context.lifecycleAttached = true;
    const onVisibilityChange = () => {
      if (documentImpl?.hidden === true) void interrupt('page_hidden').catch(report);
    };
    const onPageHide = () => {
      void emitCheckpointTrace(context, 'pagehide', { reason: 'page_hidden', inFlight: Boolean(context.checkpointInFlight) });
      void interrupt('page_hidden').catch(report);
    };
    documentImpl?.addEventListener?.('visibilitychange', onVisibilityChange);
    windowImpl?.addEventListener?.('pagehide', onPageHide);
    removeLifecycleListeners = () => {
      documentImpl?.removeEventListener?.('visibilitychange', onVisibilityChange);
      windowImpl?.removeEventListener?.('pagehide', onPageHide);
    };
  }

  function enqueueSegment(event, context, eventTrace = null, commitFailureEvent = '') {
    const blob = event?.data;
    if (!isCurrentContext(context)) {
      return Promise.resolve(Object.freeze({ ignored: true, errorCode: 'STALE_RECORDER_GENERATION' }));
    }
    if (!blob || !blob.size) {
      return Promise.resolve(Object.freeze({ ignored: true, errorCode: 'EMPTY_AUDIO_SEGMENT' }));
    }
    if (blob.size > maxSegmentBytes) {
      const error = codedError('SEGMENT_SIZE_LIMIT_EXCEEDED');
      report(error);
      context.errors.push(error);
      return Promise.reject(error);
    }

    const endedAt = timestamp(now);
    const startedAt = context.lastSegmentStartedAt || context.recordingStartedAt || endedAt;
    const elapsedMs = Date.parse(endedAt) - Date.parse(startedAt);
    const durationMs = Number.isFinite(elapsedMs)
      ? Math.max(1, elapsedMs)
      : segmentDurationMs;
    context.lastSegmentStartedAt = endedAt;
    const payload = Object.freeze({
      blob,
      chunkToken: `${context.instanceId}-${context.nextReceivedSequence}`,
      durationMs,
      mimeType: blob.type || context.recorder?.mimeType || 'audio/webm',
      startedAt,
      endedAt
    });
    context.nextReceivedSequence += 1;
    const traceContext = eventTrace;
    const failureEvent = commitFailureEvent || (traceContext
      ? 'checkpoint_commit_failed'
      : 'segment_commit_failed');
    const task = context.queueTail.then(async () => {
      try {
        if (traceContext) {
          const commitStartedAt = timestamp(now);
          traceContext.encryptionStartedAt ||= commitStartedAt;
          traceContext.commitStartedAt ||= commitStartedAt;
          if (usesPassiveNativeTimeslice(context)) {
            void emitCheckpointTrace(context, 'checkpoint_persistence_started', {
              ...traceContext,
              inFlight: true
            });
          }
        }
        const result = await onSegment(payload);
        context.committedNonEmptySegments += 1;
        context.lastSuccessfulPersistAt = payload.endedAt;
        context.lastPersistedSequence = Number.isSafeInteger(result?.segment?.sequence)
          ? result.segment.sequence
          : context.lastPersistedSequence + 1;
        context.lastCommittedDurationMs = Number.isSafeInteger(result?.meeting?.committedDurationMs)
          ? result.meeting.committedDurationMs
          : context.lastCommittedDurationMs + payload.durationMs;
        context.lastPersistedBytes += Number(blob.size || 0);
        if (traceContext) {
          traceContext.encryptionCompletedAt = timestamp(now);
          traceContext.commitCompletedAt = timestamp(now);
          traceContext.committedSequence = context.lastPersistedSequence;
          traceContext.committedDurationMs = context.lastCommittedDurationMs;
          traceContext.persistedBytes = context.lastPersistedBytes;
          traceContext.manifestRevision = Number.isSafeInteger(result?.manifest?.revision)
            ? result.manifest.revision
            : traceContext.manifestRevision;
          if (usesPassiveNativeTimeslice(context)) {
            void emitCheckpointTrace(context, 'checkpoint_persistence_completed', {
              ...traceContext,
              inFlight: true
            });
          }
        }
        context.persistenceStallReported = false;
        return result;
      } catch (error) {
        const errorCode = error?.code || 'SEGMENT_COMMIT_FAILED';
        if (traceContext) {
          traceContext.errorCode ||= errorCode;
          traceContext.failure = true;
          void emitCheckpointTrace(context, failureEvent, {
            ...traceContext,
            inFlight: Boolean(traceContext.inFlight),
            errorCode,
            failure: true
          });
        }
        throw error;
      }
    });
    context.queueTail = task.catch((error) => {
      context.errors.push(error);
    });
    return task;
  }

  function createPassiveTimesliceTrace(context, event, serial) {
    const blob = event?.data;
    const timesliceOrdinal = context.timesliceOrdinal;
    context.timesliceOrdinal += 1;
    return {
      checkpointMode: PASSIVE_NATIVE_TIMESLICE_MODE,
      checkpointId: `${context.pageEpoch}-${context.generation}-timeslice-${timesliceOrdinal}`,
      trigger: context.stopRequested ? 'stop-tail' : 'native-timeslice',
      timesliceOrdinal,
      dataEventSerial: serial,
      dataavailableAt: timestamp(now),
      blobSize: Number(blob?.size || 0),
      blobMime: String(blob?.type || context.recorder?.mimeType || ''),
      empty: !(blob?.size > 0),
      requestDataCalled: false,
      requestDataReturned: false,
      inFlight: true
    };
  }

  function handlePassiveTimeslice(event, context, serial) {
    const eventTrace = createPassiveTimesliceTrace(context, event, serial);
    if (!isCurrentContext(context) || context.cleaned) {
      eventTrace.inFlight = false;
      eventTrace.failure = true;
      eventTrace.errorCode = 'STALE_RECORDER_GENERATION';
      void emitCheckpointTrace(context, 'checkpoint_dataavailable_stale', {
        ...eventTrace,
        inFlight: false,
        failure: true
      });
      return Object.freeze({
        eventTrace,
        commitPromise: Promise.resolve(Object.freeze({ ignored: true, errorCode: eventTrace.errorCode }))
      });
    }
    if (eventTrace.empty) {
      eventTrace.inFlight = false;
      void emitCheckpointTrace(context, 'checkpoint_dataavailable', {
        ...eventTrace,
        inFlight: false
      });
      return Object.freeze({
        eventTrace,
        commitPromise: Promise.resolve(Object.freeze({ ignored: true, errorCode: 'EMPTY_AUDIO_SEGMENT' }))
      });
    }

    void emitCheckpointTrace(context, 'checkpoint_dataavailable', {
      ...eventTrace,
      inFlight: true
    });
    const commitPromise = enqueueSegment(event, context, eventTrace, 'checkpoint_commit_failed');
    let trackedCommit;
    trackedCommit = commitPromise.then(async (result) => {
      eventTrace.inFlight = false;
      eventTrace.success = true;
      context.lastCheckpointErrorCode = '';
      void emitCheckpointTrace(context, 'checkpoint_succeeded', {
        ...eventTrace,
        inFlight: false,
        success: true
      });
      await reportPersistenceStatus(context, 'checkpoint_success', {
        reason: eventTrace.trigger,
        checkpointId: eventTrace.checkpointId,
        timesliceOrdinal: eventTrace.timesliceOrdinal
      });
      return result;
    }, async (error) => {
      const errorCode = error?.code || 'SEGMENT_COMMIT_FAILED';
      context.lastCheckpointErrorCode = errorCode;
      eventTrace.inFlight = false;
      eventTrace.success = false;
      eventTrace.failure = true;
      eventTrace.errorCode = errorCode;
      eventTrace.timeout = errorCode.includes('TIMEOUT');
      void emitCheckpointTrace(context, 'checkpoint_failed', {
        ...eventTrace,
        inFlight: false,
        success: false,
        failure: true
      });
      await reportPersistenceStatus(context, 'checkpoint_failed', {
        reason: eventTrace.trigger,
        checkpointId: eventTrace.checkpointId,
        timesliceOrdinal: eventTrace.timesliceOrdinal,
        errorCode
      });
      return Object.freeze({ failed: true, errorCode });
    }).finally(() => {
      context.passiveCommitPromises.delete(trackedCommit);
    });
    context.passiveCommitPromises.add(trackedCommit);
    void trackedCommit.catch(report);
    return Object.freeze({ eventTrace, commitPromise });
  }

  async function waitForQueue(context, errorBaseline = 0) {
    let observedTail = null;
    do {
      observedTail = context.queueTail;
      await observedTail;
      await nextTurn();
    } while (observedTail !== context.queueTail);
    if (context.errors.length > errorBaseline) throw context.errors[errorBaseline];
  }

  async function waitForOptionalDataEvent(context, baseline) {
    const wait = waitForDataEvent(context, baseline);
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeoutImpl(() => resolve(null), stopTimeoutMs);
    });
    try {
      return await Promise.race([wait, timeout, context.recorderErrorPromise]);
    } finally {
      if (timer !== null) clearTimeoutImpl(timer);
      removeDataWaiter(context, baseline, false);
    }
  }

  function createFinalizationDeadline() {
    let timer = null;
    const promise = new Promise((_, reject) => {
      timer = setTimeoutImpl(() => {
        reject(codedError('MEDIA_RECORDER_FINAL_FLUSH_TIMEOUT'));
      }, stopTimeoutMs);
    });
    return Object.freeze({
      promise,
      cancel() {
        if (timer !== null) clearTimeoutImpl(timer);
      }
    });
  }

  async function waitForRecorderEvent(context, eventPromise, timeoutCode) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
      timer = setTimeoutImpl(() => reject(codedError(timeoutCode)), stopTimeoutMs);
    });
    try {
      return await Promise.race([eventPromise, timeout, context.recorderErrorPromise]);
    } finally {
      if (timer !== null) clearTimeoutImpl(timer);
    }
  }

  async function waitForResumeAcknowledgement(context) {
    let stateTimer = null;
    let settled = false;
    const stateObserved = new Promise((resolve) => {
      const observe = () => {
        if (settled) return;
        if (context.recorder?.state === 'recording') {
          resolve('native_state');
          return;
        }
        stateTimer = setTimeoutImpl(observe, Math.min(16, Math.max(1, stopTimeoutMs)));
      };
      observe();
    });
    const eventObserved = context.resumeObserved.then(() => 'resume_event');
    try {
      return await waitForRecorderEvent(
        context,
        Promise.race([eventObserved, stateObserved]),
        'MEDIA_RECORDER_NATIVE_RESUME_TIMEOUT'
      );
    } finally {
      settled = true;
      if (stateTimer !== null) clearTimeoutImpl(stateTimer);
    }
  }

  function usesDurablePauseBoundary(context) {
    return context?.recordingInfo?.recordingCodecExperiment === AAC_MP4_EXPERIMENT
      && isVerifiedIosAacRecordingDevice(context?.recordingInfo?.mediaProfile)
      && isAacMp4MimeType(context?.recordingInfo?.actualMimeType);
  }

  async function closePassivePauseBoundary(context, initialError = null) {
    const stopDataBaseline = context.dataEventSerial;
    const errorBaseline = context.errors.length;
    const committedBeforeStop = context.committedNonEmptySegments;
    let boundaryError = initialError;
    let stopDataEvent = null;
    let stopCallSucceeded = false;
    status = 'pausing';
    context.pauseBoundaryTrace = {
      checkpointId: `pause-boundary-${context.generation}-${Date.now()}`,
      checkpointMode: PASSIVE_NATIVE_TIMESLICE_MODE,
      requestDataCalled: false,
      requestDataReturned: false,
      inFlight: true,
      reason: 'user_pause'
    };
    void emitCheckpointTrace(context, 'recorder_pause_boundary_started', {
      recorderState: context.recorder?.state || '',
      inFlight: true,
      reason: 'user_pause'
    });

    try {
      context.stopRequested = true;
      try {
        context.recorder.stop();
        stopCallSucceeded = true;
        void emitCheckpointTrace(context, 'recorder_pause_boundary_stop_requested', {
          recorderState: context.recorder?.state || '',
          stopRequested: true,
          inFlight: true,
          reason: 'user_pause'
        });
      } catch (error) {
        boundaryError ||= codedError('MEDIA_RECORDER_PAUSE_BOUNDARY_STOP_FAILED', error);
      }

      if (stopCallSucceeded) {
        try {
          if (!context.stopObservedOnce) {
            await waitForRecorderEvent(
              context,
              context.stopObserved,
              'MEDIA_RECORDER_PAUSE_BOUNDARY_STOP_TIMEOUT'
            );
          }
        } catch (error) {
          boundaryError ||= error;
        }
        try {
          stopDataEvent = await waitForOptionalDataEvent(context, stopDataBaseline);
        } catch (error) {
          boundaryError ||= error?.code
            ? error
            : codedError('MEDIA_RECORDER_PAUSE_BOUNDARY_QUEUE_FAILED', error);
        }
      }

      if (stopDataEvent) {
        void emitCheckpointTrace(context, 'recorder_pause_boundary_dataavailable', {
          ...(stopDataEvent.checkpointTrace || {}),
          stopDataEventObserved: true,
          empty: !stopDataEvent.hasData,
          inFlight: Boolean(stopDataEvent.hasData)
        });
        try {
          await stopDataEvent.commitPromise;
        } catch (error) {
          boundaryError ||= error;
        }
      }
      try {
        await waitForQueue(context, errorBaseline);
        throwIfRecorderError(context);
      } catch (error) {
        boundaryError ||= error?.code
          ? error
          : codedError('MEDIA_RECORDER_PAUSE_BOUNDARY_QUEUE_FAILED', error);
      }
    } finally {
      const stopDataObserved = Boolean(stopDataEvent);
      const empty = stopDataObserved ? !stopDataEvent.hasData : undefined;
      const tailCommitted = context.committedNonEmptySegments > committedBeforeStop;
      const boundaryPending = Boolean(boundaryError)
        || !stopDataObserved
        || empty === true
        || !tailCommitted;
      context.pauseBoundaryTrace.inFlight = false;
      context.pauseBoundaryTrace.success = !boundaryPending;
      context.pauseBoundaryTrace.failure = Boolean(boundaryError);
      context.pauseBoundaryTrace.errorCode = boundaryError?.code || '';
      void emitCheckpointTrace(context, boundaryPending
        ? 'recorder_pause_boundary_pending'
        : 'recorder_pause_boundary_sealed', {
        recorderState: context.recorder?.state || '',
        stopRequested: true,
        stopObserved: context.stopObservedOnce,
        stopDataEventObserved: stopDataObserved,
        empty,
        committedSegmentCount: context.committedNonEmptySegments,
        lastPersistedSequence: context.lastPersistedSequence,
        lastCommittedDurationMs: context.lastCommittedDurationMs,
        inFlight: false,
        success: !boundaryPending,
        failure: Boolean(boundaryError),
        boundaryPending,
        errorCode: boundaryError?.code,
        reason: 'user_pause'
      });
      context.pauseBoundaryTrace = null;
      cleanupContext(context);
      status = 'paused';
      sessionBoundaryPaused = true;
      requiresExplicitResume = true;
    }

    const stopDataObserved = Boolean(stopDataEvent);
    const empty = stopDataObserved ? !stopDataEvent.hasData : undefined;
    const boundaryPending = Boolean(boundaryError)
      || !stopDataObserved
      || empty === true
      || context.committedNonEmptySegments <= committedBeforeStop;
    return Object.freeze({
      actualPaused: true,
      idempotent: false,
      sessionBoundary: true,
      boundaryPending,
      errorCode: boundaryError?.code || '',
      stopDataEventObserved: stopDataObserved,
      empty,
      committedSegmentCount: context.committedNonEmptySegments,
      lastPersistedSequence: context.lastPersistedSequence,
      lastCommittedDurationMs: context.lastCommittedDurationMs
    });
  }

  async function closeDurablePauseBoundary(context, initialError = null) {
    if (usesPassiveNativeTimeslice(context)) {
      return closePassivePauseBoundary(context, initialError);
    }
    const stopDataBaseline = context.dataEventSerial;
    let boundaryError = initialError;
    status = 'pausing';
    context.pauseBoundaryTrace = {
      checkpointId: `pause-boundary-${context.generation}-${Date.now()}`,
      inFlight: true,
      reason: 'user_pause'
    };
    void emitCheckpointTrace(context, 'recorder_pause_boundary_started', {
      recorderState: context.recorder?.state || '',
      inFlight: false,
      reason: 'user_pause'
    });
    context.stopRequested = true;
    try {
      context.recorder.stop();
      void emitCheckpointTrace(context, 'recorder_pause_boundary_stop_requested', {
        recorderState: context.recorder?.state || '',
        stopRequested: true,
        inFlight: true,
        reason: 'user_pause'
      });
      if (!context.stopObservedOnce) {
        await waitForRecorderEvent(
          context,
          context.stopObserved,
          'MEDIA_RECORDER_PAUSE_BOUNDARY_STOP_TIMEOUT'
        );
      }
    } catch (error) {
      boundaryError = error?.code
        ? error
        : codedError('MEDIA_RECORDER_PAUSE_BOUNDARY_STOP_FAILED', error);
    }
    await nextTurn();
    try {
      await waitForQueue(context);
      throwIfRecorderError(context);
    } catch (error) {
      boundaryError ||= error?.code
        ? error
        : codedError('MEDIA_RECORDER_PAUSE_BOUNDARY_QUEUE_FAILED', error);
    }
    const stopDataObserved = context.dataEvents.some((event) => event.serial > stopDataBaseline);
    context.pauseBoundaryTrace.inFlight = false;
    context.pauseBoundaryTrace.success = !boundaryError;
    context.pauseBoundaryTrace.failure = Boolean(boundaryError);
    context.pauseBoundaryTrace.errorCode = boundaryError?.code || '';
    void emitCheckpointTrace(context, boundaryError
      ? 'recorder_pause_boundary_pending'
      : 'recorder_pause_boundary_sealed', {
      recorderState: context.recorder?.state || '',
      stopRequested: true,
      stopObserved: context.stopObservedOnce,
      stopDataEventObserved: stopDataObserved,
      inFlight: false,
      success: !boundaryError,
      failure: Boolean(boundaryError),
      errorCode: boundaryError?.code,
      reason: 'user_pause'
    });
    context.pauseBoundaryTrace = null;
    cleanupContext(context);
    status = 'paused';
    sessionBoundaryPaused = true;
    requiresExplicitResume = true;
    return Object.freeze({
      actualPaused: true,
      idempotent: false,
      sessionBoundary: true,
      boundaryPending: Boolean(boundaryError),
      errorCode: boundaryError?.code || ''
    });
  }

  function preparePauseWaiter(context) {
    context.pauseObservedOnce = false;
    context.pauseObserved = new Promise((resolve) => {
      context.resolvePause = () => {
        if (context.pauseObservedOnce) return;
        context.pauseObservedOnce = true;
        resolve();
      };
    });
  }

  function prepareResumeWaiter(context) {
    context.resumeObservedOnce = false;
    context.resumeObserved = new Promise((resolve) => {
      context.resolveResume = () => {
        if (context.resumeObservedOnce) return;
        context.resumeObservedOnce = true;
        resolve();
      };
    });
  }

  async function pause() {
    if (status === 'paused') return Object.freeze({ actualPaused: true, idempotent: true });
    if (status === 'starting') throw codedError('RECORDER_START_IN_PROGRESS');
    if (status === 'stopping') throw codedError('RECORDER_STOP_IN_PROGRESS');
    if (status === 'resuming') throw codedError('RECORDER_RESUME_IN_PROGRESS');
    if (pausePromise) return pausePromise;
    if (status !== 'recording') throw codedError('RECORDER_NOT_RECORDING');
    const context = activeContext;
    if (!context || context.cleaned) throw codedError('RECORDER_NOT_RECORDING');
    const durableBoundary = usesDurablePauseBoundary(context);
    const passiveBoundary = durableBoundary && usesPassiveNativeTimeslice(context);
    if ((!passiveBoundary && typeof context.recorder?.requestData !== 'function')
      || (!durableBoundary && typeof context.recorder?.pause !== 'function')) {
      throw codedError('MEDIA_RECORDER_NATIVE_PAUSE_UNAVAILABLE');
    }
    pausePromise = (async () => {
      stopCheckpointScheduler(context);
      if (context.checkpointInFlight) {
        abortCheckpoint(context, 'RECORDING_CHECKPOINT_ABORTED_FOR_PAUSE');
        await context.checkpointInFlight;
        resetCheckpointAbort(context);
      }
      context.dataWaiters = [];
      context.lateCheckpointDataPending = false;
      context.lateCheckpointId = '';
      if (passiveBoundary) {
        const errorBaseline = context.errors.length;
        let queuedCommitError = null;
        try {
          await waitForQueue(context, errorBaseline);
          throwIfRecorderError(context);
        } catch (error) {
          queuedCommitError = error;
        }
        if (!isCurrentContext(context) || context.cleaned) throw codedError('RECORDER_NOT_RECORDING');
        return closeDurablePauseBoundary(context, queuedCommitError);
      }
      const committedBeforePause = context.committedNonEmptySegments;
      await runPeriodicCheckpoint(context, 'pause');
      if (!isCurrentContext(context) || context.cleaned) throw codedError('RECORDER_NOT_RECORDING');
      const pauseCheckpointError = context.committedNonEmptySegments <= committedBeforePause
        ? codedError(context.lastCheckpointErrorCode || 'RECORDING_PAUSE_CHECKPOINT_FAILED')
        : null;
      if (durableBoundary) return closeDurablePauseBoundary(context, pauseCheckpointError);
      if (pauseCheckpointError) throw pauseCheckpointError;
      if (context.recorder?.state !== 'recording') throw codedError('MEDIA_RECORDER_NATIVE_PAUSE_INVALID_STATE');
      preparePauseWaiter(context);
      context.pauseRequested = true;
      try {
        context.recorder.pause();
      } catch (error) {
        throw codedError('MEDIA_RECORDER_NATIVE_PAUSE_FAILED', error);
      }
      await waitForRecorderEvent(context, context.pauseObserved, 'MEDIA_RECORDER_NATIVE_PAUSE_TIMEOUT');
      status = 'paused';
      return Object.freeze({ actualPaused: true, idempotent: false });
    })();
    try {
      return await pausePromise;
    } catch (error) {
      if (isCurrentContext(context) && !context.cleaned && status === 'recording') {
        context.pauseRequested = false;
        startCheckpointScheduler(context);
      }
      throw error;
    } finally {
      pausePromise = null;
    }
  }

  async function resume() {
    if (status === 'recording') return Object.freeze({ actualStarted: true, idempotent: true });
    if (status === 'starting') throw codedError('RECORDER_START_IN_PROGRESS');
    if (status === 'stopping') throw codedError('RECORDER_STOP_IN_PROGRESS');
    if (status === 'pausing') throw codedError('RECORDER_PAUSE_IN_PROGRESS');
    if (resumePromise) return resumePromise;
    if (status !== 'paused') throw codedError('RECORDER_NOT_PAUSED');
    if (sessionBoundaryPaused && !activeContext) {
      throw codedError('RECORDER_PAGE_RELOAD_REQUIRED');
    }
    const context = activeContext;
    if (!context || context.cleaned || context.recorder?.state !== 'paused') throw codedError('RECORDER_NOT_PAUSED');
    if (typeof context.recorder?.resume !== 'function') throw codedError('MEDIA_RECORDER_NATIVE_RESUME_UNAVAILABLE');
    status = 'resuming';
    resumePromise = (async () => {
      context.dataWaiters = [];
      context.lateCheckpointDataPending = false;
      context.lateCheckpointId = '';
      resetCheckpointAbort(context);
      context.pauseRequested = false;
      preparePauseWaiter(context);
      prepareResumeWaiter(context);
      void emitCheckpointTrace(context, 'recorder_resume_requested', {
        recorderState: context.recorder?.state || '',
        inFlight: Boolean(context.checkpointInFlight)
      });
      try {
        context.recorder.resume();
      } catch (error) {
        const normalized = codedError('MEDIA_RECORDER_NATIVE_RESUME_FAILED', error);
        void emitCheckpointTrace(context, 'recorder_resume_failed', {
          recorderState: context.recorder?.state || '',
          errorCode: normalized.code,
          failure: true,
          inFlight: Boolean(context.checkpointInFlight),
          reason: 'resume_call'
        });
        throw normalized;
      }
      let acknowledgement;
      try {
        acknowledgement = await waitForResumeAcknowledgement(context);
      } catch (error) {
        void emitCheckpointTrace(context, 'recorder_resume_failed', {
          recorderState: context.recorder?.state || '',
          errorCode: error?.code || 'MEDIA_RECORDER_NATIVE_RESUME_TIMEOUT',
          failure: true,
          timeout: String(error?.code || '').includes('TIMEOUT'),
          inFlight: Boolean(context.checkpointInFlight),
          reason: 'resume_acknowledgement'
        });
        throw error;
      }
      status = 'recording';
      void emitCheckpointTrace(context, 'recorder_resume_acknowledged', {
        recorderState: context.recorder?.state || '',
        success: true,
        inFlight: Boolean(context.checkpointInFlight),
        reason: acknowledgement
      });
      startCheckpointScheduler(context);
      return Object.freeze({ actualStarted: true, idempotent: false });
    })();
    try {
      return await resumePromise;
    } catch (error) {
      if (isCurrentContext(context) && !context.cleaned && status === 'resuming') status = 'paused';
      throw error;
    } finally {
      resumePromise = null;
    }
  }

  async function runPassiveFinalization(context, reason) {
    const finalizationDeadline = createFinalizationDeadline();
    const errorBaseline = context.errors.length;
    let stopDataBaseline = null;
    let firstError = null;
    const markPending = (error, step) => {
      const normalized = error?.code ? error : codedError('MEDIA_RECORDER_FINAL_FLUSH_FAILED', error);
      if (!firstError) firstError = normalized;
      context.finalizationStep = step;
      context.finalizationTrace.finalizationStep = step;
      context.finalizationTrace.errorCode ||= normalized.code;
      context.finalizationTrace.failure = true;
      return normalized;
    };
    const awaitStage = async (promise, step) => {
      context.finalizationStep = step;
      context.finalizationTrace.finalizationStep = step;
      try {
        return await Promise.race([
          promise,
          finalizationDeadline.promise,
          context.recorderErrorPromise
        ]);
      } catch (error) {
        const normalized = error?.code === 'MEDIA_RECORDER_FINAL_FLUSH_TIMEOUT'
          ? codedError('MEDIA_RECORDER_STOP_TIMEOUT', error)
          : error;
        markPending(normalized, step);
        return null;
      }
    };
    const pendingResult = () => {
      const error = firstError || codedError('MEDIA_RECORDER_STOP_TIMEOUT');
      context.finalizationTrace.inFlight = false;
      context.finalizationTrace.finalizationPending = true;
      context.finalizationTrace.finalizationErrorCode = error.code;
      void emitCheckpointTrace(context, 'finalization_pending', {
        ...context.finalizationTrace,
        inFlight: false,
        finalizationPending: true,
        finalizationErrorCode: error.code,
        errorCode: error.code,
        committedSequence: context.lastPersistedSequence,
        committedDurationMs: context.lastCommittedDurationMs,
        persistedBytes: context.lastPersistedBytes,
        committedSegmentCount: context.committedNonEmptySegments,
        requestDataCalled: false,
        requestDataReturned: false,
        requestDataEventRequired: false,
        requestDataEventObserved: false,
        stopRequested: context.stopRequested,
        stopObserved: context.stopObservedOnce,
        stopDataEventObserved: context.stopDataEventObserved,
        success: false,
        failure: true
      });
      report(error);
      const result = Object.freeze({
        idempotent: false,
        reason,
        finalized: false,
        finalizationPending: true,
        errorCode: error.code,
        finalizationErrorCode: error.code,
        committedSegmentCount: context.committedNonEmptySegments,
        lastPersistedSequence: context.lastPersistedSequence,
        lastCommittedDurationMs: context.lastCommittedDurationMs,
        persistedBytes: context.lastPersistedBytes
      });
      cleanupContext(context);
      return result;
    };

    try {
      await awaitStage(waitForQueue(context, errorBaseline), 'drain_existing_queue');
      if (!firstError) {
        try {
          throwIfRecorderError(context);
        } catch (error) {
          markPending(error, 'recorder_error_before_stop');
        }
      }

      stopDataBaseline = context.dataEventSerial;
      const stopDataEventPromise = waitForDataEvent(context, stopDataBaseline);
      context.finalizationStep = 'stop_request';
      context.finalizationTrace.finalizationStep = context.finalizationStep;
      context.stopRequested = true;
      let stopCallSucceeded = false;
      try {
        context.recorder?.stop?.();
        stopCallSucceeded = true;
        void emitCheckpointTrace(context, 'finalization_stop_requested', {
          finalizationStep: context.finalizationStep,
          stopRequested: true,
          requestDataCalled: false,
          requestDataReturned: false,
          requestDataEventRequired: false,
          inFlight: true
        });
      } catch (error) {
        markPending(codedError('MEDIA_RECORDER_STOP_FAILED', error), 'stop_request');
        void emitCheckpointTrace(context, 'finalization_stop_failed', {
          finalizationStep: context.finalizationStep,
          stopRequested: true,
          stopObserved: false,
          requestDataCalled: false,
          requestDataReturned: false,
          requestDataEventRequired: false,
          inFlight: true,
          errorCode: 'MEDIA_RECORDER_STOP_FAILED',
          failure: true
        });
      }

      let stopDataEvent = null;
      if (stopCallSucceeded) {
        const barrier = awaitStage(Promise.all([
          context.stopObserved,
          stopDataEventPromise
        ]), 'await_stop_barrier');
        const barrierResult = await barrier;
        stopDataEvent = barrierResult?.[1] || null;
        if (!context.stopObservedOnce && !firstError) {
          markPending(codedError('MEDIA_RECORDER_STOP_TIMEOUT'), 'await_stop_event');
        }
        if (!stopDataEvent && !firstError) {
          markPending(codedError('MEDIA_RECORDER_STOP_TIMEOUT'), 'await_stop_data');
        }
      }

      if (stopDataEvent) {
        context.stopDataEventObserved = true;
        void emitCheckpointTrace(context, 'finalization_dataavailable', {
          ...(stopDataEvent.checkpointTrace || {}),
          finalizationStep: 'stop_tail',
          stopDataEventObserved: true,
          requestDataCalled: false,
          requestDataReturned: false,
          requestDataEventRequired: false,
          empty: !stopDataEvent.hasData,
          inFlight: Boolean(stopDataEvent.hasData)
        });
        if (!stopDataEvent.hasData) {
          await stopDataEvent.commitPromise;
          markPending(codedError('MEDIA_RECORDER_FINAL_DATA_EMPTY'), 'final_data_empty');
        } else {
          await awaitStage(stopDataEvent.commitPromise, 'stop_tail_commit');
          await awaitStage(waitForQueue(context, errorBaseline), 'final_queue_drain');
        }
      }
      if (!firstError) {
        try {
          throwIfRecorderError(context);
        } catch (error) {
          markPending(error, 'recorder_error');
        }
      }

      if (firstError) return pendingResult();

      context.finalizationTrace.inFlight = false;
      context.finalizationTrace.success = true;
      context.finalizationTrace.failure = false;
      context.finalizationTrace.finalizationStep = 'completed';
      void emitCheckpointTrace(context, 'finalization_succeeded', {
        ...context.finalizationTrace,
        inFlight: false,
        finalizationStep: 'completed',
        committedSequence: context.lastPersistedSequence,
        committedDurationMs: context.lastCommittedDurationMs,
        persistedBytes: context.lastPersistedBytes,
        committedSegmentCount: context.committedNonEmptySegments,
        requestDataCalled: false,
        requestDataReturned: false,
        requestDataEventRequired: false,
        requestDataEventObserved: false,
        stopRequested: true,
        stopObserved: context.stopObservedOnce,
        stopDataEventObserved: context.stopDataEventObserved,
        success: true,
        failure: false
      });
      const result = Object.freeze({
        idempotent: false,
        reason,
        finalized: true,
        finalizationPending: false,
        committedSegmentCount: context.committedNonEmptySegments,
        lastPersistedSequence: context.lastPersistedSequence,
        lastCommittedDurationMs: context.lastCommittedDurationMs,
        persistedBytes: context.lastPersistedBytes
      });
      cleanupContext(context);
      return result;
    } catch (error) {
      markPending(error, context.finalizationStep || 'finalization');
      return pendingResult();
    } finally {
      finalizationDeadline.cancel();
      if (stopDataBaseline !== null) removeDataWaiter(context, stopDataBaseline, false);
    }
  }

  async function finalize(context, reason) {
    if (context.finalFlushPromise) return context.finalFlushPromise;
    context.finalFlushStarted = true;
    stopCheckpointScheduler(context);
    abortCheckpointForFinalFlush(context);
    context.finalizationTrace = {
      checkpointId: `final-${context.generation}-${Date.now()}`,
      reason,
      ...(usesPassiveNativeTimeslice(context) ? {
        checkpointMode: PASSIVE_NATIVE_TIMESLICE_MODE,
        requestDataCalled: false,
        requestDataReturned: false
      } : {}),
      inFlight: true,
      finalizationStep: 'started'
    };
    context.finalizationStep = 'started';
    void emitCheckpointTrace(context, 'finalization_started', {
      reason,
      inFlight: true,
      finalizationStep: context.finalizationStep
    });
    if (usesPassiveNativeTimeslice(context)) {
      context.finalFlushPromise = runPassiveFinalization(context, reason);
      return context.finalFlushPromise;
    }
    context.finalFlushPromise = (async () => {
      const finalizationDeadline = createFinalizationDeadline();
      const awaitBeforeDeadline = (promise) => Promise.race([
        promise,
        finalizationDeadline.promise,
        context.recorderErrorPromise
      ]);
      let firstError = null;
      let deadlineExpired = false;
      const markPending = (error, step) => {
        const normalized = error?.code ? error : codedError('MEDIA_RECORDER_FINAL_FLUSH_FAILED', error);
        if (!firstError) firstError = normalized;
        context.finalizationStep = step;
        context.finalizationTrace.finalizationStep = step;
        context.finalizationTrace.errorCode ||= normalized.code;
        context.finalizationTrace.failure = true;
        return normalized;
      };
      const awaitStage = async (promise, step) => {
        context.finalizationStep = step;
        context.finalizationTrace.finalizationStep = step;
        if (deadlineExpired) return null;
        try {
          return await awaitBeforeDeadline(promise);
        } catch (error) {
          if (error?.code === 'MEDIA_RECORDER_FINAL_FLUSH_TIMEOUT') {
            deadlineExpired = true;
            const timeoutCode = step === 'await_final_pause'
              ? 'MEDIA_RECORDER_FINAL_FENCE_TIMEOUT'
              : step === 'await_final_data'
              ? 'MEDIA_RECORDER_FINAL_DATA_TIMEOUT'
              : ['await_stop_event', 'await_stop_data'].includes(step)
              ? 'MEDIA_RECORDER_STOP_TIMEOUT'
              : error.code;
            markPending(codedError(timeoutCode, error), step);
          } else {
            markPending(error, step);
          }
          return null;
        }
      };
      try {
        if (context.checkpointInFlight) await awaitStage(context.checkpointInFlight, 'await_inflight');
        const recorderCanFence = !context.requestDataIssued
          && typeof context.recorder?.requestData === 'function'
          && ['recording', 'paused'].includes(context.recorder?.state);
        if (recorderCanFence && context.recorder?.state === 'recording') {
          if (typeof context.recorder.pause !== 'function') {
            markPending(codedError('MEDIA_RECORDER_FINAL_FENCE_UNAVAILABLE'), 'final_pause');
          } else {
            context.finalizationStep = 'final_pause';
            context.finalizationTrace.finalizationStep = context.finalizationStep;
            if (!context.pauseRequested) {
              context.pauseRequested = true;
              try {
                context.recorder.pause();
              } catch (error) {
                markPending(codedError('MEDIA_RECORDER_FINAL_FENCE_FAILED', error), 'final_pause');
              }
            }
            if (!context.pauseObservedOnce && !firstError) {
              await awaitStage(context.pauseObserved, 'await_final_pause');
            }
          }
          if (!firstError) {
            try {
              throwIfRecorderError(context);
            } catch (error) {
              markPending(error, 'final_pause');
            }
          }
          if (!firstError && !deadlineExpired) {
            context.requestDataIssued = true;
            context.requestDataEventRequired = true;
            context.finalizationTrace.requestDataCalled = false;
            const requestDataBaseline = context.dataEventSerial;
            const requestDataEvent = waitForDataEvent(context, requestDataBaseline);
            context.finalizationStep = 'final_request_data';
            context.finalizationTrace.finalizationStep = context.finalizationStep;
            try {
              context.finalizationTrace.requestDataCalled = true;
              context.recorder.requestData();
              context.finalizationTrace.requestDataReturned = true;
              void emitCheckpointTrace(context, 'finalization_request_data', {
                requestDataCalled: true,
                requestDataReturned: true,
                inFlight: true,
                finalizationStep: context.finalizationStep
              });
            } catch (error) {
              context.requestDataError = codedError('MEDIA_RECORDER_REQUEST_DATA_FAILED', error);
              markPending(context.requestDataError, 'final_request_data');
              void emitCheckpointTrace(context, 'finalization_request_data_failed', {
                requestDataCalled: true,
                requestDataReturned: false,
                inFlight: true,
                finalizationStep: context.finalizationStep,
                errorCode: context.requestDataError.code,
                failure: true
              });
            }
            if (!firstError && !deadlineExpired) {
              const requestEvent = await awaitStage(requestDataEvent, 'await_final_data');
              if (requestEvent) {
                context.requestDataEventObserved = true;
                await awaitStage(requestEvent.commitPromise, 'final_commit');
                await awaitStage(waitForQueue(context), 'final_queue_drain');
                try {
                  throwIfRecorderError(context);
                } catch (error) {
                  markPending(error, 'final_queue_drain');
                }
              }
            }
          }
        } else if (!context.requestDataIssued
          && typeof context.recorder?.requestData === 'function'
          && context.recorder?.state === 'inactive') {
          markPending(codedError('MEDIA_RECORDER_FINAL_DATA_UNAVAILABLE'), 'final_request_data_state');
        }

        const stopDataBaseline = context.dataEventSerial;
        const stopDataEvent = waitForDataEvent(context, stopDataBaseline);
        let stopCallSucceeded = false;
        context.finalizationStep = 'stop_request';
        context.finalizationTrace.finalizationStep = context.finalizationStep;
        if (!context.stopRequested) {
          context.stopRequested = true;
          try {
            context.recorder?.stop?.();
            stopCallSucceeded = true;
          } catch (error) {
            markPending(codedError('MEDIA_RECORDER_STOP_FAILED', error), 'stop_request');
            void emitCheckpointTrace(context, 'finalization_stop_failed', {
              stopRequested: true,
              stopObserved: false,
              inFlight: true,
              finalizationStep: context.finalizationStep,
              errorCode: firstError?.code || 'MEDIA_RECORDER_STOP_FAILED',
              failure: true
            });
          }
        }
        // Keep the generation alive until stop and a post-stop-call dataavailable
        // event have both completed their persistence queue. The requestData
        // phase is deliberately completed before stop() is called so Safari
        // cannot collapse both flushes into empty callbacks in one task.
        if (stopCallSucceeded && !context.stopObservedOnce) await awaitStage(context.stopObserved, 'await_stop_event');
        const stopEvent = stopCallSucceeded ? await awaitStage(stopDataEvent, 'await_stop_data') : null;
        if (stopEvent) {
          context.stopDataEventObserved = true;
          await awaitStage(stopEvent.commitPromise, 'stop_commit');
          await awaitStage(waitForQueue(context), 'final_queue_drain');
          try {
            throwIfRecorderError(context);
          } catch (error) {
            markPending(error, 'final_queue_drain');
          }
        }
        if (context.committedNonEmptySegments === 0) {
          markPending(codedError('MEDIA_RECORDER_FINAL_DATA_EMPTY'), 'final_data_empty');
        }
        try {
          throwIfRecorderError(context);
        } catch (error) {
          markPending(error, 'recorder_error');
        }
        if (firstError) {
          finalizationDeadline.cancel();
          context.finalizationTrace.inFlight = false;
          context.finalizationTrace.finalizationPending = true;
          context.finalizationTrace.finalizationErrorCode = firstError.code;
          void emitCheckpointTrace(context, 'finalization_pending', {
            ...context.finalizationTrace,
            inFlight: false,
            finalizationPending: true,
            finalizationErrorCode: firstError.code,
            errorCode: firstError.code,
            committedSequence: context.lastPersistedSequence,
            committedDurationMs: context.lastCommittedDurationMs,
            persistedBytes: context.lastPersistedBytes,
            requestDataEventRequired: context.requestDataEventRequired,
            requestDataEventObserved: context.requestDataEventObserved,
            stopRequested: context.stopRequested,
            stopObserved: context.stopObservedOnce,
            stopDataEventObserved: context.stopDataEventObserved,
            success: false,
            failure: true
          });
          report(firstError);
          const pending = Object.freeze({
            idempotent: false,
            reason,
            finalized: false,
            finalizationPending: true,
            errorCode: firstError.code,
            finalizationErrorCode: firstError.code,
            committedSegmentCount: context.committedNonEmptySegments,
            lastPersistedSequence: context.lastPersistedSequence,
            lastCommittedDurationMs: context.lastCommittedDurationMs,
            persistedBytes: context.lastPersistedBytes
          });
          cleanupContext(context);
          return pending;
        }
        finalizationDeadline.cancel();
        context.finalizationTrace.inFlight = false;
        context.finalizationTrace.success = true;
        context.finalizationTrace.finalizationStep = 'completed';
        void emitCheckpointTrace(context, 'finalization_succeeded', {
          ...context.finalizationTrace,
          inFlight: false,
          finalizationStep: 'completed',
          committedSequence: context.lastPersistedSequence,
          committedDurationMs: context.lastCommittedDurationMs,
          persistedBytes: context.lastPersistedBytes,
          success: true,
          failure: false
        });
        cleanupContext(context);
        return Object.freeze({
          idempotent: false,
          reason,
          finalized: true,
          finalizationPending: false,
          committedSegmentCount: context.committedNonEmptySegments,
          lastPersistedSequence: context.lastPersistedSequence,
          lastCommittedDurationMs: context.lastCommittedDurationMs,
          persistedBytes: context.lastPersistedBytes
        });
      } catch (error) {
        finalizationDeadline.cancel();
        const normalized = markPending(error, context.finalizationStep || 'finalization');
        context.finalizationTrace.inFlight = false;
        context.finalizationTrace.finalizationPending = true;
        context.finalizationTrace.finalizationErrorCode = normalized.code;
        void emitCheckpointTrace(context, 'finalization_pending', {
          ...context.finalizationTrace,
          inFlight: false,
          finalizationPending: true,
          finalizationErrorCode: normalized.code,
          errorCode: normalized.code,
          committedSequence: context.lastPersistedSequence,
          committedDurationMs: context.lastCommittedDurationMs,
          persistedBytes: context.lastPersistedBytes,
          requestDataEventRequired: context.requestDataEventRequired,
          requestDataEventObserved: context.requestDataEventObserved,
          stopRequested: context.stopRequested,
          stopObserved: context.stopObservedOnce,
          stopDataEventObserved: context.stopDataEventObserved,
          success: false,
          failure: true
        });
        report(normalized);
        const pending = Object.freeze({
          idempotent: false,
          reason,
          finalized: false,
          finalizationPending: true,
          errorCode: normalized.code,
          finalizationErrorCode: normalized.code,
          committedSegmentCount: context.committedNonEmptySegments,
          lastPersistedSequence: context.lastPersistedSequence,
          lastCommittedDurationMs: context.lastCommittedDurationMs,
          persistedBytes: context.lastPersistedBytes
        });
        cleanupContext(context);
        return pending;
      }
    })();
    try {
      return await context.finalFlushPromise;
    } catch (error) {
      const normalized = error?.code ? error : codedError('MEDIA_RECORDER_FINAL_FLUSH_FAILED', error);
      report(normalized);
      cleanupContext(context);
      return Object.freeze({
        idempotent: false,
        reason,
        finalized: false,
        finalizationPending: true,
        errorCode: normalized.code,
        finalizationErrorCode: normalized.code,
        committedSegmentCount: context.committedNonEmptySegments,
        lastPersistedSequence: context.lastPersistedSequence,
        lastCommittedDurationMs: context.lastCommittedDurationMs,
        persistedBytes: context.lastPersistedBytes
      });
    }
  }

  function reportRecorderError(context, error) {
    const normalized = error?.code ? error : codedError('MEDIA_RECORDER_RUNTIME_ERROR', error);
    if (context.cleaned) return;
    if (context.finalFlushStarted || status === 'stopping') {
      if (!context.recorderError) {
        context.recorderError = normalized;
        context.rejectRecorderError(normalized);
      }
      return;
    }
    if (status === 'pausing' || status === 'resuming') {
      if (!context.recorderError) {
        context.recorderError = normalized;
        context.rejectRecorderError(normalized);
      }
      report(normalized);
      return;
    }
    if (status !== 'recording') {
      context.rejectStart?.(normalized);
      return;
    }
    report(normalized);
    void stop({ reason: 'recorder_error' }).catch(report);
  }

  async function start({ explicitResume = false } = {}) {
    if (status === 'recording') return Object.freeze({ actualStarted: true, idempotent: true });
    if (startPromise) return startPromise;
    if (status === 'stopping') throw codedError('RECORDER_STOP_IN_PROGRESS');
    if (requiresExplicitResume && explicitResume !== true) throw codedError('RESUME_CONFIRMATION_REQUIRED');
    const blockedCode = String(preRecordErrorCode || '').trim();
    if (blockedCode) throw codedError(blockedCode);
    if (!mediaDevices?.getUserMedia) throw codedError('AUDIO_INPUT_UNAVAILABLE');
    if (typeof MediaRecorderImpl !== 'function') throw codedError('MEDIA_RECORDER_UNAVAILABLE');

    status = 'starting';
    startPromise = (async () => {
      try {
        stream = await mediaDevices.getUserMedia({ audio: true });
        const experiment = String(recordingCodecExperiment || '').trim() === AAC_MP4_EXPERIMENT
          ? AAC_MP4_EXPERIMENT
          : getMeetingRecordingCodecExperiment({ storage: windowImpl?.sessionStorage });
        const aacExperiment = experiment === AAC_MP4_EXPERIMENT;
        const preferred = String(preferredMimeType || '').trim();
        const candidates = aacExperiment
          ? [...AAC_MP4_MIME_TYPES]
          : preferred
          ? [preferred, ...MIME_CANDIDATES.filter((candidate) => candidate !== preferred)]
          : MIME_CANDIDATES;
        const mimeType = selectAudioMimeType(MediaRecorderImpl, candidates);
        if (aacExperiment && !mimeType) throw codedError('AAC_EXPERIMENT_UNSUPPORTED');
        let constructorError = null;
        try {
          recorder = mimeType ? new MediaRecorderImpl(stream, { mimeType }) : new MediaRecorderImpl(stream);
        } catch (error) {
          constructorError = error;
        }
        if (constructorError) {
          if (requireAacPrimaryGate === true && isVerifiedIosAacRecordingDevice(mediaProfile) && typeof recordingAttemptEvidence === 'function') {
            const constructorOptions = mimeType ? { mimeType } : {};
            await recordingAttemptEvidence(Object.freeze({
              mediaProfile: mediaProfile || null,
              isIphoneProfile: true,
              requestedMimeType: mimeType || '',
              constructorOptions: Object.freeze({ ...constructorOptions }),
              actualMimeType: '',
              capabilities: inspectMeetingRecorderCapabilities(MediaRecorderImpl, AAC_MP4_MIME_TYPES),
              recordingCodecExperiment: experiment,
              fallbackReason: mediaProfile?.fallback ? mediaProfile.reason : '',
              mismatchCode: 'AAC_CONSTRUCTOR_MIME_MISMATCH',
              constructorErrorCode: constructorError?.code || constructorError?.name || 'MEDIA_RECORDER_CONSTRUCTOR_FAILED'
            }));
          }
          throw codedError(aacExperiment ? 'AAC_EXPERIMENT_UNSUPPORTED' : 'MEDIA_RECORDER_UNAVAILABLE', constructorError);
        }
        const actualMimeType = String(recorder.mimeType || mimeType || 'audio/webm');
        const profileValidation = validateMeetingRecordingMediaProfile({
          profile: mediaProfile?.profile || mediaProfile,
          actualMimeType
        });
        const constructorOptions = mimeType ? { mimeType } : {};
        let recordingAttemptAck = null;
        if (requireAacPrimaryGate === true && isVerifiedIosAacRecordingDevice(mediaProfile)) {
          if (typeof recordingAttemptEvidence !== 'function') {
            throw codedError('AAC_PRE_RECORD_EVIDENCE_UNAVAILABLE');
          }
          const runtimeEvidence = Object.freeze({
            mediaProfile: mediaProfile || null,
            isIphoneProfile: isVerifiedIosAacRecordingDevice(mediaProfile),
            requestedMimeType: mimeType || '',
            constructorOptions: Object.freeze({ ...constructorOptions }),
            actualMimeType,
            capabilities: inspectMeetingRecorderCapabilities(MediaRecorderImpl, AAC_MP4_MIME_TYPES),
            recordingCodecExperiment: experiment,
            fallbackReason: mediaProfile?.fallback ? mediaProfile.reason : '',
            mismatchCode: profileValidation.ok ? '' : profileValidation.errorCode,
            constructorErrorCode: ''
          });
          recordingAttemptAck = await recordingAttemptEvidence(runtimeEvidence);
          if (recordingAttemptAck?.ok !== true) {
            throw codedError(recordingAttemptAck?.errorCode || profileValidation.errorCode || 'AAC_PRIMARY_NOT_ACTIVE');
          }
        }
        if (!profileValidation.ok || (aacExperiment && !isAacMp4MimeType(actualMimeType))) {
          try { recorder.stop?.(); } catch { /* cleanup below */ }
          throw codedError(profileValidation.errorCode || 'AAC_EXPERIMENT_MIME_MISMATCH');
        }
        const recordingInfo = Object.freeze({
          recordingCodecExperiment: experiment,
          mediaProfile: mediaProfile || null,
          selectedMimeType: mimeType || actualMimeType,
          actualMimeType,
          recordingAttemptId: recordingAttemptAck?.recordingAttemptId || '',
          ...describeRecordingMimeType(actualMimeType)
        });
        let contextResolveStop;
        const context = {
          generation: ++recorderGeneration,
          instanceId: `recorder-${++recorderInstanceCounter}`,
          recorder,
          checkpointMode: isPassiveNativeTimesliceMode(checkpointMode)
            ? PASSIVE_NATIVE_TIMESLICE_MODE
            : ACTIVE_REQUEST_DATA_MODE,
          nativeTimesliceMs: Number.isSafeInteger(nativeTimesliceMs) && nativeTimesliceMs > 0
            ? nativeTimesliceMs
            : IOS_AAC_NATIVE_TIMESLICE_MS,
          queueTail: Promise.resolve(),
          errors: [],
          dataEventSerial: 0,
          dataEvents: [],
          dataWaiters: [],
          timesliceOrdinal: 0,
          passiveCommitPromises: new Set(),
          committedNonEmptySegments: 0,
          recorderError: null,
          recorderErrorPromise: null,
          rejectRecorderError: null,
          requestDataError: null,
          pauseRequested: false,
          pauseObserved: null,
          pauseObservedOnce: false,
          resolvePause: null,
          resumeObserved: null,
          resumeObservedOnce: false,
          resolveResume: null,
          requestDataEventRequired: false,
          requestDataEventObserved: false,
          stopDataEventObserved: false,
          nextReceivedSequence: 0,
          recordingStartedAt: '',
          lastSegmentStartedAt: '',
          finalFlushStarted: false,
          requestDataIssued: false,
          stopRequested: false,
          stopObserved: null,
          stopObservedOnce: false,
          lifecycleAttached: false,
          cleaned: false,
          rejectStart: null,
          checkpointTimer: null,
          checkpointInFlight: null,
          checkpointAbortPromise: null,
          resolveCheckpointAbort: null,
          checkpointAbortRequested: false,
          checkpointAbortCode: '',
          checkpointRequestCount: 0,
          lastCheckpointErrorCode: '',
          currentCheckpointTrace: null,
          pauseBoundaryTrace: null,
          finalizationTrace: null,
          finalizationStep: '',
          lateCheckpointDataPending: false,
          lateCheckpointDataBaseline: 0,
          lateCheckpointId: '',
          pageEpoch: `page-${recorderGeneration}`,
          recordingInfo,
          lastSuccessfulPersistAt: '',
          lastPersistedSequence: -1,
          lastCommittedDurationMs: 0,
          lastPersistedBytes: 0,
          persistenceStallReported: false
        };
        context.stopObserved = new Promise((resolve) => { contextResolveStop = resolve; });
        context.checkpointAbortPromise = new Promise((resolve) => {
          context.resolveCheckpointAbort = resolve;
        });
        let contextRejectRecorderError;
        context.recorderErrorPromise = new Promise((_, reject) => {
          contextRejectRecorderError = reject;
        });
        context.recorderErrorPromise.catch(() => {});
        context.rejectRecorderError = (error) => {
          contextRejectRecorderError(error);
        };
        let contextResolvePause;
        context.pauseObserved = new Promise((resolve) => { contextResolvePause = resolve; });
        context.resolvePause = () => {
          if (context.pauseObservedOnce) return;
          context.pauseObservedOnce = true;
          contextResolvePause();
        };
        let contextResolveResume;
        context.resumeObserved = new Promise((resolve) => { contextResolveResume = resolve; });
        context.resolveResume = () => {
          if (context.resumeObservedOnce) return;
          context.resumeObservedOnce = true;
          contextResolveResume();
        };
        context.resolveStop = () => {
          if (context.stopObservedOnce) return;
          context.stopObservedOnce = true;
          contextResolveStop();
        };
        activeContext = context;
        let startTimer = null;
        let resolveStart;
        let rejectStart;
        const started = new Promise((resolve, reject) => {
          resolveStart = resolve;
          rejectStart = reject;
        });
        context.rejectStart = rejectStart;
        recorder.onstart = () => {
          if (!isCurrentContext(context)) return;
          if (startTimer) clearTimeout(startTimer);
          status = 'recording';
          context.recordingStartedAt = timestamp(now);
          context.lastSegmentStartedAt = context.recordingStartedAt;
          context.lastSuccessfulPersistAt = context.recordingStartedAt;
          void emitCheckpointTrace(context, explicitResume ? 'recorder_resumed' : 'recorder_started', {
            recorderState: context.recorder?.state || 'recording',
            inFlight: false
          });
          startCheckpointScheduler(context);
          attachLifecycleListeners(context);
          try {
            onStarted({ actualStarted: true, explicitResume, ...recordingInfo, mimeType: actualMimeType });
          } catch (error) {
            report(error);
          }
          requiresExplicitResume = false;
          sessionBoundaryPaused = false;
          resolveStart({ actualStarted: true, idempotent: false, ...recordingInfo, mimeType: actualMimeType });
        };
        recorder.ondataavailable = (event) => {
          const serial = ++context.dataEventSerial;
          const blob = event?.data;
          if (usesPassiveNativeTimeslice(context)) {
            const { commitPromise, eventTrace } = handlePassiveTimeslice(event, context, serial);
            if (isCurrentContext(context) && !context.cleaned) {
              context.dataEvents.push(Object.freeze({
                serial,
                commitPromise,
                hasData: Boolean(blob?.size),
                checkpointTrace: eventTrace
              }));
              if (context.dataEvents.length > 32) context.dataEvents.splice(0, context.dataEvents.length - 32);
              resolveDataWaiters(context);
            }
            void commitPromise.catch(() => {});
            return;
          }
          const isLateCheckpointData = context.lateCheckpointDataPending
            && serial > context.lateCheckpointDataBaseline;
          let eventTrace = null;
          let commitFailureEvent = '';
          if (isLateCheckpointData) {
            context.lateCheckpointDataPending = false;
            void emitCheckpointTrace(context, 'checkpoint_dataavailable_late', {
              checkpointId: context.lateCheckpointId,
              dataEventSerial: serial,
              dataavailableAt: timestamp(now),
              blobSize: Number(blob?.size || 0),
              blobMime: String(blob?.type || context.recorder?.mimeType || ''),
              empty: !(blob?.size > 0),
              late: true,
              inFlight: false
            });
            context.lateCheckpointId = '';
          } else if (context.currentCheckpointTrace || context.pauseBoundaryTrace || context.finalizationTrace) {
            const activeTrace = context.currentCheckpointTrace
              || context.pauseBoundaryTrace
              || context.finalizationTrace;
            eventTrace = activeTrace;
            commitFailureEvent = context.currentCheckpointTrace
              ? 'checkpoint_commit_failed'
              : context.pauseBoundaryTrace
              ? 'recorder_pause_boundary_commit_failed'
              : 'finalization_commit_failed';
            activeTrace.dataavailableAt = timestamp(now);
            activeTrace.requestDataReturned = true;
            activeTrace.blobSize = Number(blob?.size || 0);
            activeTrace.blobMime = String(blob?.type || context.recorder?.mimeType || '');
            activeTrace.empty = !(blob?.size > 0);
            const dataEventName = context.currentCheckpointTrace
              ? 'checkpoint_dataavailable'
              : context.pauseBoundaryTrace
              ? 'recorder_pause_boundary_dataavailable'
              : 'finalization_dataavailable';
            void emitCheckpointTrace(context, dataEventName, {
              dataavailableAt: activeTrace.dataavailableAt,
              requestDataCalled: activeTrace.requestDataCalled,
              requestDataReturned: true,
              blobSize: activeTrace.blobSize,
              blobMime: activeTrace.blobMime,
              empty: activeTrace.empty,
              inFlight: Boolean(activeTrace.inFlight),
              finalizationStep: context.finalizationTrace && !context.currentCheckpointTrace
                ? context.finalizationStep
                : undefined
            });
          }
          const commitPromise = enqueueSegment(event, context, eventTrace, commitFailureEvent);
          context.dataEvents.push(Object.freeze({ serial, commitPromise, hasData: Boolean(event?.data?.size) }));
          if (context.dataEvents.length > 32) context.dataEvents.splice(0, context.dataEvents.length - 32);
          resolveDataWaiters(context);
          void commitPromise.catch(() => {});
        };
        recorder.onpause = () => {
          if (!isCurrentContext(context)) return;
          context.resolvePause();
          if (context.finalizationTrace) {
            context.finalizationTrace.pauseObservedAt = timestamp(now);
            void emitCheckpointTrace(context, 'finalization_pause_event', {
              finalizationStep: context.finalizationStep,
              pauseObserved: true,
              recorderState: context.recorder?.state || ''
            });
          }
        };
        recorder.onresume = () => {
          if (!isCurrentContext(context)) return;
          context.resolveResume();
        };
        recorder.onstop = () => {
          context.resolveStop();
          if (context.pauseBoundaryTrace) {
            void emitCheckpointTrace(context, 'recorder_pause_boundary_stop_event', {
              stopObserved: true,
              recorderState: context.recorder?.state || '',
              inFlight: true,
              reason: 'user_pause'
            });
          } else if (context.finalizationTrace) {
            context.finalizationTrace.stopObservedAt = timestamp(now);
            void emitCheckpointTrace(context, 'finalization_stop_event', {
              finalizationStep: context.finalizationStep,
              stopObserved: true,
              recorderState: context.recorder?.state || ''
            });
          }
        };
        recorder.onerror = (event) => reportRecorderError(context, event?.error || event);

        try {
          recorder.start(isPassiveNativeTimesliceMode(context.checkpointMode)
            ? context.nativeTimesliceMs
            : segmentDurationMs);
        } catch (error) {
          throw codedError('MEDIA_RECORDER_START_FAILED', error);
        }
        startTimer = setTimeout(() => rejectStart(codedError('MEDIA_RECORDER_NOT_STARTED')), startTimeoutMs);
        try {
          return await started;
        } catch (error) {
          if (startTimer) clearTimeout(startTimer);
          try { recorder?.stop?.(); } catch { /* cleanup below */ }
          cleanupContext(context);
          const normalized = error?.code ? error : codedError('MEDIA_RECORDER_NOT_STARTED', error);
          report(normalized);
          throw normalized;
        }
      } catch (error) {
        const normalized = error?.code ? error : normalizeMediaError(error);
        if (activeContext) cleanupContext(activeContext);
        else {
          stopTracks(stream);
          stream = null;
          recorder = null;
          status = 'idle';
        }
        report(normalized);
        throw normalized;
      }
    })();
    try {
      return await startPromise;
    } finally {
      startPromise = null;
    }
  }

  async function stop({ reason = 'user_stop' } = {}) {
    if (status === 'idle') return Object.freeze({ idempotent: true, reason });
    if (status === 'starting') throw codedError('RECORDER_START_IN_PROGRESS');
    if (pausePromise) throw codedError('RECORDER_PAUSE_IN_PROGRESS');
    if (status === 'resuming') throw codedError('RECORDER_RESUME_IN_PROGRESS');
    if (stopPromise) return stopPromise;
    const context = activeContext;
    if (!context) {
      status = 'idle';
      if (reason === 'user_stop') {
        requiresExplicitResume = false;
        sessionBoundaryPaused = false;
      }
      return Object.freeze({ idempotent: true, reason });
    }
    status = 'stopping';
    void emitCheckpointTrace(context, 'recorder_stop_requested', {
      reason,
      inFlight: Boolean(context.checkpointInFlight),
      stopRequested: true,
      recorderState: context.recorder?.state || ''
    });
    if (reason === 'user_stop') requiresExplicitResume = false;
    stopPromise = finalize(context, reason);
    try {
      return await stopPromise;
    } finally {
      stopPromise = null;
    }
  }

  async function interrupt(reason = 'recording_interrupted') {
    if (status === 'idle') return Object.freeze({ idempotent: true, reason });
    if (pausePromise) throw codedError('RECORDER_PAUSE_IN_PROGRESS');
    if (status === 'resuming') throw codedError('RECORDER_RESUME_IN_PROGRESS');
    if (interruptionPromise) return interruptionPromise;
    interruptionPromise = (async () => {
      void emitCheckpointTrace(activeContext, 'recorder_interrupted', {
        reason,
        inFlight: Boolean(activeContext?.checkpointInFlight)
      });
      await stop({ reason });
      requiresExplicitResume = true;
      await onInterrupted({ reason });
      return Object.freeze({ idempotent: false, reason });
    })();
    try {
      return await interruptionPromise;
    } finally {
      interruptionPromise = null;
    }
  }

  return Object.freeze({
    get status() {
      return status;
    },
    start,
    pause,
    resume,
    stop,
    interrupt
  });
}

export {
  DEFAULT_MAX_SEGMENT_BYTES,
  DEFAULT_SEGMENT_DURATION_MS,
  DEFAULT_CHECKPOINT_INTERVAL_MS,
  DEFAULT_PERSISTENCE_STALL_TIMEOUT_MS,
  DEFAULT_CHECKPOINT_EVENT_TIMEOUT_MS,
  MIME_CANDIDATES,
  selectAudioMimeType
};
