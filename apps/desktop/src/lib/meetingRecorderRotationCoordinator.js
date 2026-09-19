import { inspectIndependentMp4Segment } from '../../../../core/meeting/stage3c/independentMp4.js';
import { createMeetingRecorderCaptureUnit } from './meetingRecorderCaptureUnit.js';
import { MEETING_INPUT_DIAGNOSTIC_MARKER } from './meetingRecorderInputDiagnostic.js';
import {
  INDEPENDENT_MP4_SEGMENTS_V1,
  IOS_AAC_CAPTURE_UNIT_MS,
  MAX_JOURNAL_WRITE_ATTEMPTS,
  MAX_SEALED_UNCOMMITTED_UNITS
} from './meetingRecordingContainerLayout.js';

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

function stopTracks(stream) {
  try {
    for (const track of stream?.getTracks?.() || []) track.stop?.();
  } catch {
    // Stream release is best effort after capture has already reached a boundary.
  }
}

function mapPersistenceError(error, phase) {
  const code = String(error?.code || '');
  if (code.includes('ENCRYPT')) return codedError('CAPTURE_UNIT_ENCRYPTION_FAILED', error);
  if (phase === 'journal') return codedError('CAPTURE_UNIT_JOURNAL_FAILED', error);
  if (phase === 'commit') return codedError('CAPTURE_UNIT_COMMIT_FAILED', error);
  return error?.code ? error : codedError('CAPTURE_UNIT_COMMIT_FAILED', error);
}

function mapFinalizationError(errorCode) {
  const code = String(errorCode || '');
  if (code.includes('JOURNAL') || code.includes('ENCRYPT')) return 'FINALIZATION_PENDING_JOURNAL';
  if (code.includes('COMMIT') || code.includes('ATOMIC')) return 'FINALIZATION_PENDING_COMMIT';
  if (code.includes('MANIFEST')) return 'FINALIZATION_PENDING_MANIFEST';
  return 'FINALIZATION_PENDING_TAIL_SEAL';
}

export function createMeetingRecorderRotationCoordinator({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderImpl = globalThis.MediaRecorder,
  initialStream = null,
  firstRecorderInstance = null,
  mimeType,
  pageEpoch = `page-${Date.now()}`,
  recorderGeneration = 1,
  captureUnitFactory = createMeetingRecorderCaptureUnit,
  capturePersistencePort,
  inspectContainer = inspectIndependentMp4Segment,
  captureUnitMs = IOS_AAC_CAPTURE_UNIT_MS,
  sealTimeoutMs = 10_000,
  maxSegmentBytes = 8 * 1024 * 1024,
  maxSealedUncommitted = MAX_SEALED_UNCOMMITTED_UNITS,
  maxJournalWriteAttempts = MAX_JOURNAL_WRITE_ATTEMPTS,
  now = () => new Date().toISOString(),
  monotonicNow = () => globalThis.performance?.now?.() ?? Date.now(),
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
  onStarted = () => {},
  onInterrupted = async () => {},
  onError = () => {},
  onPersistenceStatus = async () => {},
  onCheckpointTrace = () => {}
} = {}) {
  if (!mediaDevices?.getUserMedia) throw codedError('AUDIO_INPUT_UNAVAILABLE');
  if (typeof captureUnitFactory !== 'function') throw codedError('CAPTURE_UNIT_FACTORY_REQUIRED');
  if (!capturePersistencePort || typeof capturePersistencePort.reserveCaptureUnit !== 'function'
    || typeof capturePersistencePort.stagePendingCaptureUnit !== 'function'
    || typeof capturePersistencePort.commitPendingCaptureUnit !== 'function'
    || typeof capturePersistencePort.recordCaptureDiscontinuity !== 'function') {
    throw codedError('CAPTURE_PERSISTENCE_PORT_REQUIRED');
  }
  if (!Number.isSafeInteger(captureUnitMs) || captureUnitMs <= 0) throw codedError('CAPTURE_UNIT_DURATION_INVALID');
  if (!Number.isSafeInteger(maxSealedUncommitted) || maxSealedUncommitted <= 0) throw codedError('CAPTURE_BACKPRESSURE_LIMIT_INVALID');
  const selectedMimeType = required(mimeType, 'SEGMENT_MIME_TYPE_REQUIRED');
  const stablePageEpoch = required(pageEpoch, 'PAGE_EPOCH_REQUIRED');
  const stableRecorderGeneration = nonNegativeInteger(recorderGeneration, 'RECORDER_GENERATION_INVALID');
  let status = 'idle';
  let stream = initialStream;
  let availableFirstRecorder = firstRecorderInstance;
  let logical = null;
  let activeRecord = null;
  let successorReservation = null;
  let rotationTimer = null;
  let cutoverTail = Promise.resolve();
  let persistenceTail = Promise.resolve();
  let nextPersistenceOrdinal = null;
  let disposed = false;
  let errorCode = '';
  let consecutiveSealFailures = 0;
  let sealedUncommitted = 0;
  let maxObservedSealedUncommitted = 0;
  let lastPersistedSequence = -1;
  let lastCommittedDurationMs = 0;
  let lastManifestRevision = 0;
  let backpressureTriggered = false;
  let terminalShutdownStarted = false;
  let stopPromise = null;
  let pausePromise = null;
  let preservedRecordingError = '';
  let recordingErrorNotified = false;
  const terminalEntries = new Map();
  const units = new Set();

  function trace(event, fields = {}) {
    try {
      onCheckpointTrace(Object.freeze({
        event,
        diagnosticMarker: MEETING_INPUT_DIAGNOSTIC_MARKER,
        pageEpoch: stablePageEpoch,
        recorderGeneration: stableRecorderGeneration,
        captureEpoch: logical?.captureEpoch,
        status,
        ...fields
      }));
    } catch {
      // Persistent diagnostics never alter capture.
    }
  }

  function report(error) {
    try { onError(error); } catch { /* UI reporting is isolated. */ }
  }

  function normalizeLogical(input = {}) {
    const value = Object.freeze({
      meetingId: required(input.meetingId, 'MEETING_ID_REQUIRED'),
      sourceId: required(input.sourceId, 'SOURCE_ID_REQUIRED'),
      recordingAttemptId: required(input.recordingAttemptId, 'RECORDING_ATTEMPT_ID_REQUIRED'),
      captureEpoch: nonNegativeInteger(input.captureEpoch, 'CAPTURE_EPOCH_INVALID'),
      containerLayout: required(input.containerLayout, 'RECORDING_CONTAINER_LAYOUT_REQUIRED')
    });
    if (value.sourceId !== `recorded-${value.meetingId}`) throw codedError('SOURCE_SCOPE_MISMATCH');
    if (value.containerLayout !== INDEPENDENT_MP4_SEGMENTS_V1) {
      throw codedError('RECORDING_CONTAINER_LAYOUT_MISMATCH');
    }
    return value;
  }

  function assertSameLogical(candidate, { resume = false } = {}) {
    if (!logical) return;
    if (candidate.meetingId !== logical.meetingId || candidate.sourceId !== logical.sourceId) {
      throw codedError('MEETING_SOURCE_IDENTITY_MISMATCH');
    }
    if (candidate.recordingAttemptId !== logical.recordingAttemptId) {
      throw codedError('RECORDING_ATTEMPT_ID_MISMATCH');
    }
    if (candidate.containerLayout !== logical.containerLayout) {
      throw codedError('RECORDING_CONTAINER_LAYOUT_MISMATCH');
    }
    const expectedEpoch = resume ? logical.captureEpoch + 1 : logical.captureEpoch;
    if (candidate.captureEpoch !== expectedEpoch) throw codedError('CAPTURE_EPOCH_MISMATCH');
  }

  async function acquireStream() {
    if (stream) return stream;
    stream = await mediaDevices.getUserMedia({ audio: true });
    if (!stream) throw codedError('AUDIO_INPUT_UNAVAILABLE');
    return stream;
  }

  function releaseStream() {
    if (!stream) return;
    stopTracks(stream);
    stream = null;
  }

  function cancelRotationTimer() {
    if (rotationTimer !== null) clearTimeoutImpl(rotationTimer);
    rotationTimer = null;
  }

  function makeIdentity(reservation) {
    return Object.freeze({
      pageEpoch: stablePageEpoch,
      recorderGeneration: stableRecorderGeneration,
      captureEpoch: logical.captureEpoch,
      captureOrdinal: reservation.captureOrdinal,
      captureUnitId: reservation.captureUnitId,
      chunkToken: reservation.chunkToken
    });
  }

  function constructUnit(reservation) {
    const identity = makeIdentity(reservation);
    trace('recorder_constructed', {
      captureOrdinal: identity.captureOrdinal,
      captureUnitId: identity.captureUnitId,
      chunkToken: identity.chunkToken
    });
    const recorderInstance = availableFirstRecorder;
    availableFirstRecorder = null;
    const unit = captureUnitFactory({
      MediaRecorderImpl,
      recorderInstance,
      stream,
      mimeType: selectedMimeType,
      identity,
      inspectContainer,
      now,
      monotonicNow,
      setTimeoutImpl,
      clearTimeoutImpl,
      sealTimeoutMs,
      maxSegmentBytes,
      onTrace: onCheckpointTrace
    });
    if (!unit || typeof unit.start !== 'function' || typeof unit.requestStop !== 'function') {
      throw codedError('CAPTURE_UNIT_FACTORY_INVALID');
    }
    units.add(unit);
    return Object.freeze({ unit, reservation, identity });
  }

  async function reserveForCurrentEpoch() {
    const reservation = await capturePersistencePort.reserveCaptureUnit({
      meetingId: logical.meetingId,
      sourceId: logical.sourceId,
      recordingAttemptId: logical.recordingAttemptId,
      captureEpoch: logical.captureEpoch,
      pageEpoch: stablePageEpoch,
      recorderGeneration: stableRecorderGeneration
    });
    if (nextPersistenceOrdinal === null) {
      nextPersistenceOrdinal = nonNegativeInteger(reservation.captureOrdinal, 'CAPTURE_ORDINAL_INVALID');
    }
    trace('unit_reserved', {
      captureOrdinal: reservation.captureOrdinal,
      captureUnitId: reservation.captureUnitId,
      chunkToken: reservation.chunkToken
    });
    return reservation;
  }

  async function reserveSuccessorAndArm() {
    successorReservation = await reserveForCurrentEpoch();
    if (status !== 'recording' || !activeRecord) return;
    cancelRotationTimer();
    rotationTimer = setTimeoutImpl(() => {
      rotationTimer = null;
      trace('rotation_timer_fired', { captureOrdinal: activeRecord?.identity.captureOrdinal });
      cutoverTail = cutoverTail.then(() => rotate()).catch((error) => {
        errorCode = error?.code || 'CAPTURE_ROTATION_FAILED';
        if (status !== 'interrupted') status = 'stalled';
        report(error);
      });
    }, captureUnitMs);
    trace('rotation_timer_armed', {
      captureOrdinal: activeRecord.identity.captureOrdinal,
      successorCaptureOrdinal: successorReservation.captureOrdinal,
      successorCaptureUnitId: successorReservation.captureUnitId,
      timerState: 'armed'
    });
  }

  function makeTerminalEntry(record, kind = 'normal', forcedErrorCode = '') {
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    return { record, kind, forcedErrorCode, completion, resolveCompletion, result: null, error: null };
  }

  function scheduleTerminalDrain() {
    if (nextPersistenceOrdinal === null) return;
    while (terminalEntries.has(nextPersistenceOrdinal)) {
      const entry = terminalEntries.get(nextPersistenceOrdinal);
      terminalEntries.delete(nextPersistenceOrdinal);
      nextPersistenceOrdinal += 1;
      const run = persistenceTail.then(() => processTerminalEntry(entry));
      persistenceTail = run.catch(() => {});
      run.then(entry.resolveCompletion, (error) => entry.resolveCompletion({ ok: false, errorCode: error?.code || 'CAPTURE_UNIT_COMMIT_FAILED' }));
    }
  }

  function registerTerminal(record, terminalPromise, { kind = 'normal', forcedErrorCode = '' } = {}) {
    const entry = makeTerminalEntry(record, kind, forcedErrorCode);
    Promise.resolve(terminalPromise).then((result) => {
      entry.result = result;
      if (kind === 'normal') {
        sealedUncommitted += 1;
        maxObservedSealedUncommitted = Math.max(maxObservedSealedUncommitted, sealedUncommitted);
      }
      terminalEntries.set(record.identity.captureOrdinal, entry);
      scheduleTerminalDrain();
      if (kind === 'normal' && sealedUncommitted >= maxSealedUncommitted) triggerBackpressure();
    }, (error) => {
      entry.error = error;
      terminalEntries.set(record.identity.captureOrdinal, entry);
      scheduleTerminalDrain();
    });
    return entry.completion;
  }

  async function persistDiscontinuity(record, exactErrorCode) {
    await capturePersistencePort.recordCaptureDiscontinuity({
      meetingId: logical.meetingId,
      sourceId: logical.sourceId,
      recordingAttemptId: logical.recordingAttemptId,
      captureEpoch: record.identity.captureEpoch,
      captureOrdinal: record.identity.captureOrdinal,
      captureUnitId: record.identity.captureUnitId,
      chunkToken: record.identity.chunkToken,
      errorCode: exactErrorCode
    });
    trace('capture_discontinuity_recorded', {
      captureOrdinal: record.identity.captureOrdinal,
      errorCode: exactErrorCode
    });
  }

  async function processTerminalEntry(entry) {
    const { record } = entry;
    try {
    if (entry.kind !== 'normal') {
      const exactCode = entry.forcedErrorCode || entry.error?.code || 'CAPTURE_UNIT_TOKEN_STALE';
      await persistDiscontinuity(record, exactCode);
      return Object.freeze({ ok: false, discarded: true, errorCode: exactCode });
    }
    if (entry.error) {
      const exactCode = entry.error?.code || 'CAPTURE_UNIT_SEAL_FAILED';
      await persistDiscontinuity(record, exactCode);
      consecutiveSealFailures += 1;
      errorCode = exactCode;
      trace('capture_unit_failed', {
        captureOrdinal: record.identity.captureOrdinal,
        consecutiveSealFailures,
        errorCode: exactCode,
        failure: true
      });
      if (consecutiveSealFailures >= 2 && !['pausing', 'stopping'].includes(status)) {
        triggerTerminalFailure(exactCode);
      }
      return Object.freeze({ ok: false, errorCode: exactCode });
    }

    consecutiveSealFailures = 0;
    let staged = null;
    let journalError = null;
    for (let attempt = 0; attempt < maxJournalWriteAttempts; attempt += 1) {
      try {
        trace('encryption_started', {
          captureOrdinal: record.identity.captureOrdinal,
          captureUnitId: record.identity.captureUnitId,
          retryCount: attempt,
          queueDepth: sealedUncommitted
        });
        staged = await capturePersistencePort.stagePendingCaptureUnit({
          meetingId: logical.meetingId,
          sourceId: logical.sourceId,
          recordingAttemptId: logical.recordingAttemptId,
          captureEpoch: record.identity.captureEpoch,
          unit: Object.freeze({
            ...entry.result,
            identity: record.identity,
            containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
          }),
          bytes: entry.result.bytes
        });
        trace('encryption_completed', {
          captureOrdinal: record.identity.captureOrdinal,
          captureUnitId: record.identity.captureUnitId,
          retryCount: attempt,
          queueDepth: sealedUncommitted
        });
        journalError = null;
        trace('journal_committed', {
          captureOrdinal: record.identity.captureOrdinal,
          journalId: staged.journalId,
          retryCount: attempt,
          queueDepth: sealedUncommitted
        });
        break;
      } catch (error) {
        journalError = error;
      }
    }
    if (!staged) {
      const normalized = mapPersistenceError(journalError, 'journal');
      haltForPersistenceStall(normalized.code, { notify: status === 'recording' });
      sealedUncommitted = Math.max(0, sealedUncommitted - 1);
      return Object.freeze({ ok: false, errorCode: normalized.code });
    }

    try {
      trace('commit_started', {
        captureOrdinal: record.identity.captureOrdinal,
        captureUnitId: record.identity.captureUnitId,
        journalId: staged.journalId,
        queueDepth: sealedUncommitted
      });
      const committed = await capturePersistencePort.commitPendingCaptureUnit({
        meetingId: logical.meetingId,
        journalId: staged.journalId
      });
      lastPersistedSequence = Number.isSafeInteger(committed?.segment?.sequence)
        ? committed.segment.sequence
        : lastPersistedSequence + 1;
      lastCommittedDurationMs = Number.isSafeInteger(committed?.meeting?.committedDurationMs)
        ? committed.meeting.committedDurationMs
        : lastCommittedDurationMs + entry.result.durationMs;
      lastManifestRevision = Number.isSafeInteger(committed?.manifest?.revision)
        ? committed.manifest.revision
        : lastManifestRevision + 1;
      trace('manifest_committed', {
        captureOrdinal: record.identity.captureOrdinal,
        committedSequence: lastPersistedSequence,
        committedDurationMs: lastCommittedDurationMs,
        manifestRevision: lastManifestRevision,
        queueDepth: Math.max(0, sealedUncommitted - 1)
      });
      trace('pending_deleted', {
        captureOrdinal: record.identity.captureOrdinal,
        captureUnitId: record.identity.captureUnitId,
        journalId: staged.journalId,
        pendingDeleted: true,
        queueDepth: Math.max(0, sealedUncommitted - 1)
      });
      if (entry.result.recordingErrorCode) {
        preservedRecordingError ||= entry.result.recordingErrorCode;
        errorCode = preservedRecordingError;
        // SEALED means recoverable audio, not a healthy encoder. Do not await
        // stop here: its normal, non-discarding flush joins this persistence job.
        if (status === 'recording') void stop({ reason: preservedRecordingError }).catch(report);
      }
      return Object.freeze({ ok: true, committed });
    } catch (error) {
      const normalized = mapPersistenceError(error, 'commit');
      haltForPersistenceStall(normalized.code, { notify: status === 'recording' });
      return Object.freeze({ ok: false, errorCode: normalized.code });
    } finally {
      sealedUncommitted = Math.max(0, sealedUncommitted - 1);
    }
    } finally {
      units.delete(record.unit);
      record.unit.dispose?.();
      trace('unit_disposed', {
        captureOrdinal: record.identity.captureOrdinal,
        captureUnitId: record.identity.captureUnitId,
        chunkToken: record.identity.chunkToken
      });
    }
  }

  async function cancelReservation(reservation, reason) {
    if (!reservation) return Object.freeze({ ok: true, idempotent: true });
    const record = {
      unit: { dispose() {} },
      identity: makeIdentity(reservation),
      reservation
    };
    const completion = registerTerminal(record, Promise.resolve(null), {
      kind: 'discard',
      forcedErrorCode: reason
    });
    if (successorReservation === reservation) successorReservation = null;
    return completion;
  }

  function stopActiveWithoutSuccessor(reason, forcedErrorCode) {
    const record = activeRecord;
    activeRecord = null;
    if (!record) return Promise.resolve({ ok: true, idempotent: true });
    let terminal;
    try {
      terminal = record.unit.requestStop(reason);
    } catch (error) {
      terminal = Promise.reject(error);
    }
    return registerTerminal(record, terminal, {
      kind: 'discard',
      forcedErrorCode
    });
  }

  function triggerBackpressure() {
    if (backpressureTriggered || disposed || ['pausing', 'stopping', 'interrupted', 'stalled'].includes(status)) return;
    backpressureTriggered = true;
    status = 'stalled';
    errorCode = 'CAPTURE_ROTATION_BACKPRESSURE';
    cancelRotationTimer();
    const unused = successorReservation;
    successorReservation = null;
    void Promise.all([
      stopActiveWithoutSuccessor('backpressure', 'CAPTURE_ROTATION_BACKPRESSURE'),
      cancelReservation(unused, 'CAPTURE_ROTATION_BACKPRESSURE')
    ]).finally(releaseStream);
    trace('capture_rotation_backpressure', {
      queueDepth: sealedUncommitted,
      maxQueueDepth: maxObservedSealedUncommitted,
      errorCode
    });
    void onPersistenceStatus({ phase: 'stalled', errorCode });
  }

  function haltForPersistenceStall(exactErrorCode, { notify = false } = {}) {
    if (terminalShutdownStarted || disposed) return;
    terminalShutdownStarted = true;
    status = 'stalled';
    errorCode = exactErrorCode;
    cancelRotationTimer();
    const unused = successorReservation;
    successorReservation = null;
    const shutdown = Promise.all([
      stopActiveWithoutSuccessor('persistence_stalled', exactErrorCode),
      cancelReservation(unused, exactErrorCode)
    ]).finally(releaseStream);
    if (notify) {
      void shutdown
        .then(() => onPersistenceStatus({ phase: 'stalled', errorCode: exactErrorCode }))
        .catch(() => {});
    }
    trace('capture_persistence_stalled', {
      queueDepth: sealedUncommitted,
      maxQueueDepth: maxObservedSealedUncommitted,
      errorCode: exactErrorCode,
      failure: true
    });
  }

  function triggerTerminalFailure(exactErrorCode) {
    if (terminalShutdownStarted || disposed) return;
    terminalShutdownStarted = true;
    status = 'interrupted';
    errorCode = exactErrorCode;
    cancelRotationTimer();
    const unused = successorReservation;
    successorReservation = null;
    void Promise.all([
      stopActiveWithoutSuccessor('terminal_failure', exactErrorCode),
      cancelReservation(unused, exactErrorCode)
    ]).finally(async () => {
      releaseStream();
      await onInterrupted({ reason: exactErrorCode });
      trace('capture_input_session_finished', { reason: exactErrorCode });
    });
  }

  async function rotate() {
    if (status !== 'recording' || !activeRecord || disposed) return;
    if (!successorReservation) throw codedError('CAPTURE_SUCCESSOR_RESERVATION_MISSING');
    const oldRecord = activeRecord;
    const nextReservation = successorReservation;
    successorReservation = null;
    let successor;
    try {
      successor = constructUnit(nextReservation);
    } catch (error) {
      const exactCode = error?.code || 'CAPTURE_UNIT_START_FAILED';
      successorReservation = nextReservation;
      triggerTerminalFailure(exactCode);
      return;
    }
    trace('cutover_started', {
      oldCaptureOrdinal: oldRecord.identity.captureOrdinal,
      oldCaptureUnitId: oldRecord.identity.captureUnitId,
      successorCaptureOrdinal: successor.identity.captureOrdinal,
      successorCaptureUnitId: successor.identity.captureUnitId
    });
    cancelRotationTimer();
    let terminal;
    try {
      terminal = oldRecord.unit.requestStop('rotation');
      trace('old_stop_requested', {
        captureOrdinal: oldRecord.identity.captureOrdinal,
        captureUnitId: oldRecord.identity.captureUnitId
      });
    } catch (error) {
      terminal = Promise.reject(error);
    }
    terminal = Promise.resolve(terminal);
    terminal.catch(() => {});
    trace('successor_start_requested', {
      captureOrdinal: successor.identity.captureOrdinal,
      captureUnitId: successor.identity.captureUnitId
    });
    try {
      await successor.unit.start();
    } catch (error) {
      const oldCompletion = registerTerminal(oldRecord, terminal);
      activeRecord = null;
      await registerTerminal(successor, Promise.resolve(null), {
        kind: 'discard',
        forcedErrorCode: error?.code || 'CAPTURE_UNIT_START_FAILED'
      });
      await oldCompletion;
      triggerTerminalFailure(error?.code || 'CAPTURE_UNIT_START_FAILED');
      return;
    }
    activeRecord = successor;
    try {
      // Reserve the next ordinal before the old unit is allowed to mutate the
      // manifest. The successor is already recording, so this preserves the
      // gap-free cutover while avoiding a reserve/commit lost-update race.
      await reserveSuccessorAndArm();
    } catch (error) {
      const exactCode = error?.code || 'CAPTURE_SUCCESSOR_RESERVATION_FAILED';
      const oldCompletion = registerTerminal(oldRecord, terminal);
      activeRecord = null;
      let successorTerminal;
      try {
        successorTerminal = successor.unit.requestStop('successor_reservation_failed');
      } catch (stopError) {
        successorTerminal = Promise.reject(stopError);
      }
      await registerTerminal(successor, successorTerminal, {
        kind: 'discard',
        forcedErrorCode: exactCode
      });
      await oldCompletion;
      triggerTerminalFailure(exactCode);
      return;
    }
    registerTerminal(oldRecord, terminal);
  }

  async function begin(logicalInput, { resumed = false } = {}) {
    let reservation = null;
    let record = null;
    try {
      await acquireStream();
      await capturePersistencePort.replayPendingCaptureUnits?.({ meetingId: logicalInput.meetingId });
      reservation = await reserveForCurrentEpoch();
      record = constructUnit(reservation);
      await record.unit.start();
      activeRecord = record;
      status = 'recording';
      errorCode = '';
      preservedRecordingError = '';
      recordingErrorNotified = false;
      backpressureTriggered = false;
      terminalShutdownStarted = false;
      trace(resumed ? 'recorder_resumed' : 'recorder_started', {
        captureOrdinal: record.identity.captureOrdinal,
        success: true
      });
      const info = Object.freeze({
        actualStarted: true,
        idempotent: false,
        explicitResume: resumed,
        recordingAttemptId: logical.recordingAttemptId,
        captureEpoch: logical.captureEpoch,
        containerLayout: logical.containerLayout,
        actualMimeType: selectedMimeType,
        selectedMimeType,
        mimeType: selectedMimeType,
        pageEpoch: stablePageEpoch,
        recorderGeneration: stableRecorderGeneration
      });
      await reserveSuccessorAndArm();
      // Explicit resume already acquired a fresh microphone stream. Reacquiring
      // it again while that stream is recording can interrupt WebKit's encoder.
      // Every rotation in this epoch must use the same live input stream.
      try { onStarted(info); } catch { /* Manager observes returned identity too. */ }
      return info;
    } catch (error) {
      cancelRotationTimer();
      const exactCode = error?.code || 'CAPTURE_UNIT_START_FAILED';
      const unusedSuccessor = successorReservation;
      successorReservation = null;
      if (activeRecord === record) activeRecord = null;
      const rollback = [];
      if (record) {
        let terminal = Promise.resolve(null);
        if (record.unit.getSnapshot?.().state === 'RECORDING') {
          try {
            terminal = record.unit.requestStop('start_rollback');
          } catch (stopError) {
            terminal = Promise.reject(stopError);
          }
        }
        rollback.push(registerTerminal(record, terminal, {
          kind: 'discard',
          forcedErrorCode: exactCode
        }));
      } else if (reservation) {
        rollback.push(cancelReservation(reservation, exactCode));
      }
      if (unusedSuccessor && unusedSuccessor !== reservation) {
        rollback.push(cancelReservation(unusedSuccessor, exactCode));
      }
      await Promise.all(rollback);
      await persistenceTail;
      throw error;
    }
  }

  async function start(input = {}) {
    if (status === 'recording') return Object.freeze({ actualStarted: true, idempotent: true, ...logical });
    if (disposed) throw codedError('RECORDER_DISPOSED');
    if (!['idle', 'paused'].includes(status)) throw codedError('RECORDER_START_IN_PROGRESS');
    const candidate = normalizeLogical(input);
    if (logical) assertSameLogical(candidate, { resume: status === 'paused' });
    const previousLogical = logical;
    logical = candidate;
    status = 'starting';
    try {
      return await begin(candidate, { resumed: input.explicitResume === true });
    } catch (error) {
      logical = previousLogical;
      status = 'idle';
      releaseStream();
      throw error;
    }
  }

  async function finishRecordingError(result) {
    if (!preservedRecordingError) return result;
    status = 'interrupted';
    errorCode = result.errorCode || preservedRecordingError;
    if (!recordingErrorNotified && !disposed) {
      recordingErrorNotified = true;
      await onInterrupted({ reason: preservedRecordingError });
    }
    return Object.freeze({ ...result, interrupted: true, errorCode, recordingErrorCode: preservedRecordingError });
  }

  function pause() {
    if (stopPromise) return stopPromise;
    if (pausePromise) return pausePromise;
    pausePromise = performPause().then(finishRecordingError).finally(() => { pausePromise = null; });
    return pausePromise;
  }

  async function performPause() {
    if (status === 'paused') return Object.freeze({ actualPaused: true, idempotent: true });
    if (status !== 'recording' || !activeRecord) throw codedError('RECORDER_NOT_RECORDING');
    status = 'pausing';
    cancelRotationTimer();
    // A timer cutover may already be starting its successor. Finish that
    // boundary before selecting the recorder whose tail must be persisted.
    await cutoverTail;
    const record = activeRecord;
    activeRecord = null;
    const unused = successorReservation;
    successorReservation = null;
    let terminal;
    try { terminal = record.unit.requestStop('user_pause'); } catch (error) { terminal = Promise.reject(error); }
    const [tail] = await Promise.all([
      registerTerminal(record, terminal),
      cancelReservation(unused, 'CAPTURE_RESERVATION_CANCELLED_FOR_PAUSE')
    ]);
    await persistenceTail;
    releaseStream();
    status = 'paused';
    return Object.freeze({
      actualPaused: true,
      idempotent: false,
      sessionBoundary: true,
      boundaryPending: tail?.ok !== true,
      errorCode: tail?.ok === true ? '' : tail?.errorCode || '',
      lastPersistedSequence,
      lastCommittedDurationMs
    });
  }

  async function resume(input = {}) {
    if (status === 'recording') return Object.freeze({ actualStarted: true, idempotent: true, ...logical });
    if (status !== 'paused') throw codedError('RECORDER_NOT_PAUSED');
    const candidate = normalizeLogical(input);
    assertSameLogical(candidate, { resume: true });
    const previousLogical = logical;
    logical = candidate;
    status = 'starting';
    try {
      return await begin(candidate, { resumed: true });
    } catch (error) {
      logical = previousLogical;
      status = 'paused';
      releaseStream();
      throw error;
    }
  }

  async function performStop({ reason = 'user_stop' } = {}) {
    status = 'stopping';
    cancelRotationTimer();
    await cutoverTail;
    const record = activeRecord;
    activeRecord = null;
    const unused = successorReservation;
    successorReservation = null;
    let tail = { ok: true, idempotent: true };
    if (record) {
      let terminal;
      try { terminal = record.unit.requestStop(reason); } catch (error) { terminal = Promise.reject(error); }
      tail = await registerTerminal(record, terminal);
    }
    await cancelReservation(unused, 'CAPTURE_RESERVATION_CANCELLED_FOR_FINALIZE');
    await persistenceTail;
    releaseStream();
    if (tail?.ok !== true) {
      status = 'idle';
      errorCode = mapFinalizationError(tail?.errorCode);
      return Object.freeze({
        idempotent: false,
        reason,
        finalized: false,
        finalizationPending: true,
        errorCode,
        finalizationErrorCode: errorCode,
        lastPersistedSequence,
        lastCommittedDurationMs
      });
    }
    try {
      const finalized = await capturePersistencePort.finalizeCaptureManifest?.({
        meetingId: logical.meetingId,
        expectedRecordingAttemptId: logical.recordingAttemptId,
        allowSafeTailClosure: true
      });
      status = 'idle';
      return Object.freeze({
        idempotent: false,
        reason,
        finalized: finalized?.finalized !== false,
        finalizationPending: finalized?.finalizationPending === true,
        lastPersistedSequence,
        lastCommittedDurationMs,
        manifestRevision: lastManifestRevision
      });
    } catch (error) {
      status = 'idle';
      errorCode = 'FINALIZATION_PENDING_MANIFEST';
      return Object.freeze({
        idempotent: false,
        reason,
        finalized: false,
        finalizationPending: true,
        errorCode,
        finalizationErrorCode: errorCode,
        lastPersistedSequence,
        lastCommittedDurationMs
      });
    }
  }

  function stop(input = {}) {
    const reason = input.reason || 'user_stop';
    if (stopPromise) return stopPromise;
    if (status === 'idle') return Promise.resolve(Object.freeze({ idempotent: true, reason }));
    const boundary = pausePromise
      ? pausePromise.then(() => performStop({ reason }))
      : performStop({ reason });
    stopPromise = boundary.then(finishRecordingError).finally(() => {
      trace('capture_input_session_finished', { reason });
      stopPromise = null;
    });
    return stopPromise;
  }

  async function interrupt(reason = 'recording_interrupted') {
    if (preservedRecordingError && (stopPromise || pausePromise)) return stopPromise || pausePromise;
    if (['idle', 'paused'].includes(status)) return Object.freeze({ idempotent: true, reason });
    const stopped = await stop({ reason });
    if (!preservedRecordingError) await onInterrupted({ reason });
    return stopped;
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    cancelRotationTimer();
    successorReservation = null;
    if (activeRecord) {
      activeRecord.unit.dispose?.();
      units.delete(activeRecord.unit);
      activeRecord = null;
    }
    for (const unit of units) unit.dispose?.();
    units.clear();
    releaseStream();
    if (!['idle', 'paused'].includes(status)) status = 'idle';
    return true;
  }

  function getSnapshot() {
    return Object.freeze({
      status,
      errorCode,
      pageEpoch: stablePageEpoch,
      recorderGeneration: stableRecorderGeneration,
      recordingAttemptId: logical?.recordingAttemptId || '',
      captureEpoch: logical?.captureEpoch ?? -1,
      activeCaptureOrdinal: activeRecord?.identity.captureOrdinal ?? -1,
      successorCaptureOrdinal: successorReservation?.captureOrdinal ?? -1,
      lastPersistedSequence,
      lastCommittedDurationMs,
      manifestRevision: lastManifestRevision,
      consecutiveSealFailures,
      sealedUncommitted,
      maxSealedUncommitted: maxObservedSealedUncommitted,
      timerCount: rotationTimer === null ? 0 : 1,
      activeUnitCount: units.size,
      streamActive: Boolean(stream),
      disposed
    });
  }

  return Object.freeze({
    get status() { return status; },
    start,
    pause,
    resume,
    stop,
    interrupt,
    dispose,
    getSnapshot
  });
}

export { codedError };
