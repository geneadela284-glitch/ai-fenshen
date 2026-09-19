import { isAacMp4MimeType } from './meetingRecordingCodecExperiment.js';
import { MEETING_INPUT_DIAGNOSTIC_MARKER, observeMeetingRecorderInput, snapshotMeetingRecorderInput } from './meetingRecorderInputDiagnostic.js';

const CAPTURE_UNIT_STATES = new Set([
  'CREATED',
  'STARTING',
  'RECORDING',
  'STOP_REQUESTED',
  'SEALING',
  'SEALED',
  'START_FAILED',
  'STOP_FAILED',
  'SEAL_TIMEOUT',
  'EMPTY_BLOB',
  'CONTAINER_INVALID',
  'STALE'
]);

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw codedError(code);
  return numeric;
}

function normalizeIdentity(value = {}) {
  return Object.freeze({
    pageEpoch: required(value.pageEpoch, 'PAGE_EPOCH_REQUIRED'),
    recorderGeneration: nonNegativeInteger(value.recorderGeneration, 'RECORDER_GENERATION_INVALID'),
    captureEpoch: nonNegativeInteger(value.captureEpoch, 'CAPTURE_EPOCH_INVALID'),
    captureOrdinal: nonNegativeInteger(value.captureOrdinal, 'CAPTURE_ORDINAL_INVALID'),
    captureUnitId: required(value.captureUnitId, 'CAPTURE_UNIT_ID_REQUIRED'),
    chunkToken: required(value.chunkToken, 'SEGMENT_CHUNK_TOKEN_REQUIRED')
  });
}

function nowValue(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = new Date(value || new Date());
  if (Number.isNaN(date.getTime())) throw codedError('CAPTURE_UNIT_TIMESTAMP_INVALID');
  return date.toISOString();
}

function toMonotonic(monotonicNow) {
  const value = Number(typeof monotonicNow === 'function' ? monotonicNow() : monotonicNow);
  if (!Number.isFinite(value)) throw codedError('CAPTURE_UNIT_CLOCK_INVALID');
  return value;
}

export function createMeetingRecorderCaptureUnit({
  MediaRecorderImpl,
  recorderInstance = null,
  stream,
  documentImpl = globalThis.document,
  mimeType,
  identity: inputIdentity,
  inspectContainer,
  now = () => new Date().toISOString(),
  monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  sealTimeoutMs = 10_000,
  maxSegmentBytes = 8 * 1024 * 1024,
  onTrace = () => {}
} = {}) {
  if (!recorderInstance && typeof MediaRecorderImpl !== 'function') throw codedError('MEDIA_RECORDER_UNAVAILABLE');
  if (!stream) throw codedError('MEDIA_STREAM_REQUIRED');
  if (typeof inspectContainer !== 'function') throw codedError('CAPTURE_UNIT_INSPECTOR_REQUIRED');
  if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') {
    throw codedError('CAPTURE_UNIT_TIMER_REQUIRED');
  }
  if (!Number.isSafeInteger(sealTimeoutMs) || sealTimeoutMs <= 0) throw codedError('CAPTURE_UNIT_TIMEOUT_INVALID');
  if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes <= 0) throw codedError('CAPTURE_UNIT_SIZE_LIMIT_INVALID');
  const identity = normalizeIdentity(inputIdentity);
  const selectedMimeType = required(mimeType, 'SEGMENT_MIME_TYPE_REQUIRED');
  let recorder;
  try {
    recorder = recorderInstance || new MediaRecorderImpl(stream, { mimeType: selectedMimeType });
  } catch (error) {
    throw codedError('CAPTURE_UNIT_START_FAILED', error);
  }
  const actualMimeType = String(recorder?.mimeType || selectedMimeType);
  if (!isAacMp4MimeType(actualMimeType)) {
    throw codedError('CAPTURE_UNIT_START_FAILED', codedError('AAC_PRIMARY_MIME_MISMATCH'));
  }
  let state = 'CREATED';
  let active = true;
  let startPromise = null;
  let stopPromise = null;
  let resolveStop = null;
  let rejectStop = null;
  let startTimer = null;
  let sealTimer = null;
  let terminalSettleTimer = null;
  let startedAt = '';
  let endedAt = '';
  let startedMonotonic = 0;
  let stoppedMonotonic = 0;
  let stopObserved = false;
  let dataSignalObserved = false;
  let terminalEventOrder = '';
  let settled = false;
  let sealing = false;
  let recordingError = null;
  let stopCalled = false;
  let detachInputDiagnostic = () => {};
  const parts = [];

  function trace(event, fields = {}) {
    try {
      onTrace(Object.freeze({
        event, ...identity, state, captureUnitState: state,
        diagnosticMarker: MEETING_INPUT_DIAGNOSTIC_MARKER,
        ...snapshotMeetingRecorderInput(stream, documentImpl),
        recorderState: recorder.state,
        stopRequested: stopCalled,
        ...(startedAt ? { elapsedCaptureMs: Math.max(0, Math.round(toMonotonic(monotonicNow) - startedMonotonic)) } : {}),
        ...fields
      }));
    } catch {
      // Diagnostics never mutate capture state.
    }
  }

  function clearTimer(name) {
    const timer = name === 'start'
      ? startTimer
      : name === 'seal'
        ? sealTimer
        : terminalSettleTimer;
    if (timer !== null) clearTimeoutImpl(timer);
    if (name === 'start') startTimer = null;
    else if (name === 'seal') sealTimer = null;
    else terminalSettleTimer = null;
  }

  function detachHandlers() {
    recorder.onstart = null;
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
  }

  function cleanup() {
    detachInputDiagnostic();
    clearTimer('start');
    clearTimer('seal');
    clearTimer('settle');
    detachHandlers();
  }

  function staleEvent(event) {
    trace('capture_unit_event_stale', { staleEvent: event, failure: true, errorCode: 'CAPTURE_UNIT_TOKEN_STALE' });
  }

  function beginTerminal() {
    if (stopPromise) return stopPromise;
    endedAt = nowValue(now);
    stoppedMonotonic = toMonotonic(monotonicNow);
    stopPromise = new Promise((resolve, reject) => {
      resolveStop = resolve;
      rejectStop = reject;
    });
    // The browser may finish before the coordinator asks for this result.
    // Keep the original promise (including rejection) available to that caller.
    stopPromise.catch(() => {});
    sealTimer = setTimeoutImpl(() => {
      failStop(
        recordingError?.code || 'CAPTURE_UNIT_SEAL_TIMEOUT',
        recordingError ? 'STOP_FAILED' : 'SEAL_TIMEOUT',
        recordingError?.cause
      );
    }, sealTimeoutMs);
    return stopPromise;
  }

  function failStop(code, nextState, cause = null) {
    if (settled) return;
    settled = true;
    state = nextState;
    cleanup();
    const error = codedError(code, cause);
    trace('capture_unit_failed', { errorCode: code, failure: true });
    rejectStop?.(error);
  }

  async function seal() {
    if (settled || sealing || !active) return;
    sealing = true;
    clearTimer('settle');
    if (!parts.length) {
      settled = true;
      state = 'EMPTY_BLOB';
      cleanup();
      const error = codedError('CAPTURE_UNIT_EMPTY_BLOB');
      trace('capture_unit_failed', { errorCode: error.code, empty: true, failure: true });
      rejectStop?.(error);
      return;
    }
    const blob = new Blob(parts, { type: selectedMimeType });
    if (!blob.size || blob.size > maxSegmentBytes) {
      settled = true;
      state = blob.size ? 'CONTAINER_INVALID' : 'EMPTY_BLOB';
      cleanup();
      const error = codedError(blob.size ? 'CAPTURE_UNIT_CONTAINER_INVALID' : 'CAPTURE_UNIT_EMPTY_BLOB');
      trace('capture_unit_failed', { errorCode: error.code, blobSize: blob.size, failure: true });
      rejectStop?.(error);
      return;
    }
    let bytes;
    let inspection;
    let durationMs;
    try {
      bytes = new Uint8Array(await blob.arrayBuffer());
      if (!active || settled) {
        staleEvent('seal_complete');
        return;
      }
      inspection = inspectContainer(bytes);
      durationMs = inspection?.durationMs;
      if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
        throw codedError('INDEPENDENT_MP4_DURATION_UNRESOLVED');
      }
    } catch (error) {
      if (!active || settled) return;
      settled = true;
      state = 'CONTAINER_INVALID';
      cleanup();
      const normalized = codedError('CAPTURE_UNIT_CONTAINER_INVALID', error);
      trace('capture_unit_failed', { errorCode: normalized.code, blobSize: blob.size, failure: true });
      rejectStop?.(normalized);
      return;
    }
    trace('container_validated', {
      validation: 'PASS',
      blobSize: bytes.byteLength,
      blobMime: actualMimeType,
      partCount: parts.length,
      captureUnitDurationMs: durationMs,
      eventOrder: terminalEventOrder
    });
    settled = true;
    state = 'SEALED';
    cleanup();
    const result = Object.freeze({
      state,
      identity,
      blob,
      bytes,
      inspection,
      startedAt,
      endedAt,
      durationMs,
      recordingErrorCode: recordingError?.code || '',
      mimeType: selectedMimeType,
      partCount: parts.length,
      byteLength: bytes.byteLength
    });
    trace('capture_unit_sealed', {
      durationMs,
      elapsedCaptureMs: Math.max(0, Math.round(stoppedMonotonic - startedMonotonic)),
      recordingErrorCode: recordingError?.code || '',
      partCount: parts.length,
      blobSize: bytes.byteLength,
      blobMime: actualMimeType,
      eventOrder: terminalEventOrder,
      success: true
    });
    resolveStop?.(result);
  }

  function maybeSettle() {
    if (!active || settled || sealing || !stopObserved || !dataSignalObserved || terminalSettleTimer !== null) return;
    terminalSettleTimer = setTimeoutImpl(() => {
      terminalSettleTimer = null;
      void seal();
    }, 0);
  }

  recorder.ondataavailable = (event) => {
    if (!active || settled || sealing) {
      staleEvent('dataavailable');
      return;
    }
    dataSignalObserved = true;
    if (!terminalEventOrder) terminalEventOrder = stopObserved ? 'stop-before-data' : 'data-before-stop';
    const blob = event?.data;
    if (blob?.size > 0) parts.push(blob);
    trace('capture_unit_dataavailable', {
      blobSize: Number(blob?.size || 0),
      empty: !(blob?.size > 0),
      partCount: parts.length
    });
    maybeSettle();
  };
  recorder.onstop = () => {
    if (!active || settled) {
      staleEvent('stop');
      return;
    }
    if (stopObserved) return;
    beginTerminal();
    stopObserved = true;
    if (!terminalEventOrder) terminalEventOrder = dataSignalObserved ? 'data-before-stop' : 'stop-before-data';
    state = 'SEALING';
    trace('capture_unit_stop_observed', { stopObserved: true });
    maybeSettle();
  };
  recorder.onerror = (event) => {
    const cause = event?.error || event;
    if (!active || settled) {
      staleEvent('error');
      return;
    }
    if (state === 'STARTING') return;
    recordingError ||= codedError('CAPTURE_UNIT_STOP_FAILED', cause);
    beginTerminal();
    if (cause?.name === 'SecurityError' || cause?.name === 'NotAllowedError') {
      failStop('CAPTURE_UNIT_STOP_FAILED', 'STOP_FAILED', cause);
      return;
    }
    // Runtime errors can be followed by a usable final blob and stop event.
    // Retain that tail within the existing deadline without hiding the error.
    state = 'SEALING';
    const errorName = ['Error', 'AbortError', 'InvalidStateError', 'NotAllowedError', 'NotFoundError',
      'NotReadableError', 'NotSupportedError', 'OverconstrainedError', 'SecurityError', 'UnknownError']
      .includes(cause?.name) ? cause.name : 'UnknownError';
    trace('capture_unit_recording_error', { errorCode: recordingError.code, errorName, failure: true });
  };

  function start() {
    if (state === 'RECORDING') return Promise.resolve(Object.freeze({ actualStarted: true, idempotent: true, identity }));
    if (startPromise) return startPromise;
    if (state !== 'CREATED') return Promise.reject(codedError('CAPTURE_UNIT_START_FAILED'));
    detachInputDiagnostic = observeMeetingRecorderInput(stream, event => trace(event), documentImpl);
    state = 'STARTING';
    startPromise = new Promise((resolve, reject) => {
      recorder.onstart = () => {
        if (!active) {
          staleEvent('start');
          return;
        }
        if (state !== 'STARTING') return;
        clearTimer('start');
        state = 'RECORDING';
        startedAt = nowValue(now);
        startedMonotonic = toMonotonic(monotonicNow);
        trace('capture_unit_start_acknowledged', { success: true });
        resolve(Object.freeze({ actualStarted: true, idempotent: false, identity, mimeType: selectedMimeType }));
      };
      try {
        trace('capture_unit_start_requested', { startArgumentCount: 0 });
        recorder.start();
      } catch (error) {
        state = 'START_FAILED';
        cleanup();
        reject(codedError('CAPTURE_UNIT_START_FAILED', error));
        return;
      }
      startTimer = setTimeoutImpl(() => {
        if (state !== 'STARTING') return;
        state = 'START_FAILED';
        cleanup();
        reject(codedError('CAPTURE_UNIT_START_FAILED'));
      }, sealTimeoutMs);
    });
    return startPromise;
  }

  function requestStop(reason = 'rotation') {
    if (stopPromise) return stopPromise;
    if (state !== 'RECORDING') return Promise.reject(codedError('CAPTURE_UNIT_STOP_FAILED'));
    state = 'STOP_REQUESTED';
    beginTerminal();
    trace('capture_unit_stop_requested', { reason });
    try {
      if (!stopCalled) {
        stopCalled = true;
        recorder.stop();
      }
    } catch (error) {
      failStop('CAPTURE_UNIT_STOP_FAILED', 'STOP_FAILED', error);
    }
    return stopPromise;
  }

  function dispose() {
    if (!active) return false;
    active = false;
    if (state !== 'SEALED') state = 'STALE';
    cleanup();
    if (stopPromise && !settled) {
      settled = true;
      rejectStop?.(codedError('CAPTURE_UNIT_TOKEN_STALE'));
    }
    trace('capture_unit_disposed', { disposed: true });
    return true;
  }

  function getSnapshot() {
    if (!CAPTURE_UNIT_STATES.has(state)) throw codedError('CAPTURE_UNIT_STATE_INVALID');
    return Object.freeze({
      state,
      identity,
      partCount: parts.length,
      byteLength: parts.reduce((total, part) => total + Number(part.size || 0), 0),
      stopObserved,
      dataSignalObserved,
      stopCalled,
      timerArmed: startTimer !== null || sealTimer !== null || terminalSettleTimer !== null
    });
  }

  return Object.freeze({ start, requestStop, dispose, getSnapshot });
}

export { CAPTURE_UNIT_STATES, codedError };
