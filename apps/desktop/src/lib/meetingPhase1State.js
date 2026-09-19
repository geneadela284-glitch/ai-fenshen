import {
  CONTINUOUS_FRAGMENT_STREAM_V1,
  INDEPENDENT_MP4_SEGMENTS_V1,
  resolveRecordedContainerLayout
} from './meetingRecordingContainerLayout.js';

export const MEETING_PHASE1_SCHEMA_VERSION = 1;

export const MEETING_PHASE1_STATES = Object.freeze([
  'draft',
  'ready',
  'recording',
  'interrupted',
  'finalization_pending',
  'stopped',
  'failed_retryable',
  'failed_terminal'
]);

const CLIENT_ASSET_VERSION_MISMATCH = 'CLIENT_ASSET_VERSION_MISMATCH';

export function isDurableAssetGateRecoveryCandidate(session) {
  if (!session || !['interrupted', 'failed_retryable'].includes(session.recordingState)) return false;
  return session.errorCode === CLIENT_ASSET_VERSION_MISMATCH
    && Number(session.committedSegmentCount) > 0
    && Number(session.committedDurationMs) > 0
    && session.recoverable !== false;
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function timestamp(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const normalized = new Date(candidate || new Date()).toISOString();
  if (Number.isNaN(Date.parse(normalized))) throw codedError('MEETING_TIMESTAMP_INVALID');
  return normalized;
}

function frozen(value) {
  return Object.freeze(value);
}

export function createMeetingPhase1Session({
  meetingId,
  ownerId,
  scope = 'meeting',
  title = '未命名会议',
  now = () => new Date().toISOString(),
  revision = 1
} = {}) {
  const createdAt = timestamp(now);
  return frozen({
    schemaVersion: MEETING_PHASE1_SCHEMA_VERSION,
    meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
    ownerId: required(ownerId, 'OWNER_REQUIRED'),
    scope: required(scope, 'MEETING_SCOPE_REQUIRED'),
    title: String(title || '未命名会议').trim() || '未命名会议',
    createdAt,
    updatedAt: createdAt,
    recordingState: 'draft',
    audioManifestVersion: 1,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 1,
    committedSegmentCount: 0,
    committedDurationMs: 0,
    totalBytes: 0,
    actualRecorderStarted: false,
    startedAt: '',
    endedAt: '',
    lastSavedAt: '',
    recoverable: false,
    lastSuccessfulPersistAt: '',
    lastPersistedSequence: -1,
    lastCommittedDurationMs: 0,
    persistenceStalled: false,
    interruptionReason: '',
    errorCode: '',
    finalizationPending: false,
    finalizationErrorCode: '',
    recordingAttemptId: '',
    captureEpoch: -1,
    containerLayout: CONTINUOUS_FRAGMENT_STREAM_V1
  });
}

function result(state, { accepted = false, idempotent = false, errorCode = '' } = {}) {
  return Object.freeze({ state, accepted, idempotent, errorCode });
}

function nextState(session, changes, now) {
  return frozen({
    ...session,
    ...changes,
    updatedAt: timestamp(now),
    revision: session.revision + 1
  });
}

function invalid(session, errorCode) {
  return result(session, { errorCode });
}

export function transitionMeetingPhase1Session(session, event = {}, { now = () => new Date().toISOString() } = {}) {
  if (!session || typeof session !== 'object' || !MEETING_PHASE1_STATES.includes(session.recordingState)) {
    throw codedError('MEETING_SESSION_INVALID');
  }
  const normalizedSession = frozen({
    recoverable: ['recording', 'interrupted', 'finalization_pending'].includes(session.recordingState),
    lastSuccessfulPersistAt: String(session.lastSavedAt || ''),
    lastPersistedSequence: Math.max(-1, (Number(session.committedSegmentCount) || 0) - 1),
    lastCommittedDurationMs: Number(session.committedDurationMs) || 0,
    persistenceStalled: false,
    recordingAttemptId: '',
    captureEpoch: -1,
    containerLayout: CONTINUOUS_FRAGMENT_STREAM_V1,
    ...session,
    recordingAttemptId: String(session.recordingAttemptId || '').trim(),
    captureEpoch: Number.isSafeInteger(Number(session.captureEpoch))
      ? Number(session.captureEpoch)
      : -1,
    containerLayout: resolveRecordedContainerLayout(session.containerLayout)
  });
  const type = String(event.type || '').trim();
  const current = normalizedSession.recordingState;

  if (type === 'prepare') {
    if (current === 'ready') return result(normalizedSession, { idempotent: true });
    if (current !== 'draft') return invalid(normalizedSession, 'SESSION_NOT_DRAFT');
    return result(nextState(normalizedSession, { recordingState: 'ready', errorCode: '', persistenceStalled: false }, now), { accepted: true });
  }

  if (type === 'recorder_started') {
    if (event.actualStarted !== true) {
      if (!['ready', 'interrupted'].includes(current)) return invalid(normalizedSession, 'SESSION_NOT_READY');
      return result(nextState(normalizedSession, {
        recordingState: 'failed_retryable',
        actualRecorderStarted: false,
        errorCode: 'MEDIA_RECORDER_NOT_STARTED'
      }, now), { accepted: true, errorCode: 'MEDIA_RECORDER_NOT_STARTED' });
    }
    const currentAttemptId = normalizedSession.recordingAttemptId;
    const incomingAttemptId = String(event.recordingAttemptId || '').trim();
    const firstIdentity = !currentAttemptId && normalizedSession.captureEpoch < 0;
    const incomingLayout = event.containerLayout === undefined || event.containerLayout === null || event.containerLayout === ''
      ? normalizedSession.containerLayout
      : resolveRecordedContainerLayout(event.containerLayout);
    const incomingCaptureEpoch = event.captureEpoch === undefined || event.captureEpoch === null || event.captureEpoch === ''
      ? normalizedSession.captureEpoch
      : Number(event.captureEpoch);
    if (currentAttemptId && incomingAttemptId && currentAttemptId !== incomingAttemptId) {
      return invalid(normalizedSession, 'RECORDING_ATTEMPT_ID_MISMATCH');
    }
    if (!firstIdentity && incomingLayout !== normalizedSession.containerLayout) {
      return invalid(normalizedSession, 'RECORDING_CONTAINER_LAYOUT_MISMATCH');
    }
    if (firstIdentity && incomingLayout === INDEPENDENT_MP4_SEGMENTS_V1 && !incomingAttemptId) {
      return invalid(normalizedSession, 'RECORDING_ATTEMPT_ID_REQUIRED');
    }
    if (!Number.isSafeInteger(incomingCaptureEpoch) || incomingCaptureEpoch < -1) {
      return invalid(normalizedSession, 'CAPTURE_EPOCH_INVALID');
    }
    if (firstIdentity) {
      const identityProvided = Boolean(incomingAttemptId) || incomingLayout === INDEPENDENT_MP4_SEGMENTS_V1;
      if (identityProvided && incomingCaptureEpoch !== 0) return invalid(normalizedSession, 'CAPTURE_EPOCH_MISMATCH');
    } else if (event.explicitResume === true && event.captureEpoch !== undefined
      && incomingCaptureEpoch !== normalizedSession.captureEpoch + 1) {
      return invalid(normalizedSession, 'CAPTURE_EPOCH_MISMATCH');
    } else if (event.explicitResume !== true && event.captureEpoch !== undefined
      && incomingCaptureEpoch !== normalizedSession.captureEpoch) {
      return invalid(normalizedSession, 'CAPTURE_EPOCH_MISMATCH');
    }
    if (current === 'recording') return result(normalizedSession, { idempotent: true });
    if (current === 'interrupted' && event.explicitResume !== true) return invalid(normalizedSession, 'RESUME_CONFIRMATION_REQUIRED');
    if (!['ready', 'interrupted'].includes(current)) return invalid(normalizedSession, 'SESSION_NOT_READY');
    return result(nextState(normalizedSession, {
      recordingState: 'recording',
      actualRecorderStarted: true,
      startedAt: normalizedSession.startedAt || timestamp(now),
      endedAt: '',
      interruptionReason: '',
      errorCode: '',
      finalizationPending: false,
      finalizationErrorCode: '',
      recoverable: true,
      persistenceStalled: false,
      recordingAttemptId: currentAttemptId || incomingAttemptId,
      captureEpoch: incomingCaptureEpoch,
      containerLayout: firstIdentity ? incomingLayout : normalizedSession.containerLayout
    }, now), { accepted: true });
  }

  if (type === 'recorder_start_failed') {
    if (!['ready', 'interrupted'].includes(current)) return invalid(normalizedSession, 'SESSION_NOT_READY');
    const code = required(event.errorCode || 'MEDIA_RECORDER_START_FAILED', 'MEDIA_RECORDER_START_FAILED');
    if (current === 'interrupted'
        && code === CLIENT_ASSET_VERSION_MISMATCH
        && normalizedSession.committedSegmentCount > 0
        && normalizedSession.committedDurationMs > 0) {
      return result(nextState(normalizedSession, {
        recordingState: 'interrupted',
        actualRecorderStarted: false,
        errorCode: code,
        finalizationPending: false,
        finalizationErrorCode: '',
        recoverable: true
      }, now), { accepted: true, errorCode: code });
    }
    return result(nextState(normalizedSession, {
      recordingState: 'failed_retryable',
      actualRecorderStarted: false,
      errorCode: code,
      finalizationPending: false,
      finalizationErrorCode: '',
      recoverable: normalizedSession.committedSegmentCount > 0
    }, now), { accepted: true, errorCode: code });
  }

  if (type === 'segment_commit_failed') {
    if (!['recording', 'interrupted'].includes(current)) return invalid(normalizedSession, 'SESSION_NOT_RECORDING');
    const code = required(event.errorCode || 'SEGMENT_COMMIT_FAILED', 'SEGMENT_COMMIT_FAILED');
    return result(nextState(normalizedSession, {
      recordingState: 'failed_retryable',
      actualRecorderStarted: false,
      errorCode: code,
      recoverable: true,
      persistenceStalled: true
    }, now), { accepted: true, errorCode: code });
  }

  if (type === 'segment_committed') {
    if (current === 'stopped') return invalid(normalizedSession, 'SESSION_STOPPED');
    if (!['recording', 'interrupted'].includes(current)) return invalid(normalizedSession, 'SESSION_NOT_RECORDING');
    const durationMs = Number(event.durationMs);
    const byteLength = Number(event.byteLength);
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) return invalid(normalizedSession, 'SEGMENT_DURATION_INVALID');
    if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return invalid(normalizedSession, 'SEGMENT_SIZE_INVALID');
    return result(nextState(normalizedSession, {
      committedSegmentCount: normalizedSession.committedSegmentCount + 1,
      committedDurationMs: normalizedSession.committedDurationMs + durationMs,
      totalBytes: normalizedSession.totalBytes + byteLength,
      lastSavedAt: timestamp(now),
      lastSuccessfulPersistAt: timestamp(now),
      lastCommittedDurationMs: normalizedSession.committedDurationMs + durationMs,
      lastPersistedSequence: Number.isSafeInteger(event.sequence) ? event.sequence : normalizedSession.lastPersistedSequence + 1,
      recoverable: true,
      persistenceStalled: false,
      errorCode: '',
      finalizationPending: false,
      finalizationErrorCode: ''
    }, now), { accepted: true });
  }

  if (type === 'persistence_checkpoint') {
    if (!['recording', 'interrupted'].includes(current)) return invalid(normalizedSession, 'SESSION_NOT_RECORDING');
    const sequence = Number(event.lastPersistedSequence);
    const durationMs = Number(event.lastCommittedDurationMs);
    if (!Number.isSafeInteger(sequence) || sequence < -1) return invalid(normalizedSession, 'CHECKPOINT_SEQUENCE_INVALID');
    if (!Number.isSafeInteger(durationMs) || durationMs < 0) return invalid(normalizedSession, 'CHECKPOINT_DURATION_INVALID');
    return result(nextState(normalizedSession, {
      recoverable: true,
      lastPersistedSequence: sequence,
      lastSuccessfulPersistAt: timestamp(event.lastSuccessfulPersistAt || now),
      lastCommittedDurationMs: durationMs,
      persistenceStalled: false,
      errorCode: ''
    }, now), { accepted: true });
  }

  if (type === 'persistence_stalled') {
    if (!['recording', 'interrupted'].includes(current)) return invalid(normalizedSession, 'SESSION_NOT_RECORDING');
    const code = required(event.errorCode || 'RECORDING_PERSISTENCE_STALLED', 'RECORDING_PERSISTENCE_STALLED');
    return result(nextState(normalizedSession, {
      recoverable: true,
      persistenceStalled: true,
      errorCode: code
    }, now), { accepted: true, errorCode: code });
  }

  if (type === 'persistence_interrupted') {
    if (!['recording', 'interrupted'].includes(current)) return invalid(normalizedSession, 'SESSION_NOT_RECORDING');
    const code = required(event.errorCode || 'RECORDING_PERSISTENCE_STALLED', 'RECORDING_PERSISTENCE_STALLED');
    return result(nextState(normalizedSession, {
      recordingState: 'interrupted',
      actualRecorderStarted: false,
      interruptionReason: code,
      recoverable: true,
      persistenceStalled: true,
      errorCode: code
    }, now), { accepted: true, errorCode: code });
  }

  if (type === 'interrupted') {
    if (current === 'interrupted') return result(normalizedSession, { idempotent: true });
    if (current !== 'recording') return invalid(normalizedSession, 'SESSION_NOT_RECORDING');
    return result(nextState(normalizedSession, {
      recordingState: 'interrupted',
      actualRecorderStarted: false,
      interruptionReason: String(event.reason || 'recording_interrupted'),
      errorCode: '',
      finalizationPending: false,
      finalizationErrorCode: '',
      recoverable: true,
      persistenceStalled: false
    }, now), { accepted: true });
  }

  if (type === 'finalization_pending') {
    if (current === 'finalization_pending') return result(normalizedSession, { idempotent: true });
    if (!['recording', 'interrupted', 'failed_retryable'].includes(current)) return invalid(normalizedSession, 'SESSION_NOT_FINALIZABLE');
    const code = required(event.errorCode || 'FINALIZATION_PENDING', 'FINALIZATION_PENDING');
    return result(nextState(normalizedSession, {
      recordingState: 'finalization_pending',
      actualRecorderStarted: false,
      endedAt: '',
      errorCode: code,
      finalizationPending: true,
      finalizationErrorCode: code,
      recoverable: true,
      persistenceStalled: false
    }, now), { accepted: true, errorCode: code });
  }

  if (type === 'finalize') {
    if (current === 'stopped') return result(normalizedSession, { idempotent: true });
    if (current !== 'finalization_pending') return invalid(normalizedSession, 'SESSION_NOT_FINALIZATION_PENDING');
    return result(nextState(normalizedSession, {
      recordingState: 'stopped',
      actualRecorderStarted: false,
      endedAt: timestamp(now),
      errorCode: '',
      finalizationPending: false,
      finalizationErrorCode: '',
      recoverable: false,
      persistenceStalled: false
    }, now), { accepted: true });
  }

  if (type === 'stop') {
    if (current === 'stopped') return result(normalizedSession, { idempotent: true });
    if (!['recording', 'interrupted', 'failed_retryable', 'finalization_pending'].includes(current)) return invalid(normalizedSession, 'SESSION_NOT_READY');
    return result(nextState(normalizedSession, {
      recordingState: 'stopped',
      actualRecorderStarted: false,
      endedAt: timestamp(now),
      errorCode: '',
      finalizationPending: false,
      finalizationErrorCode: '',
      recoverable: false,
      persistenceStalled: false
    }, now), { accepted: true });
  }

  if (type === 'retry') {
    if (current === 'failed_retryable') {
      return result(nextState(normalizedSession, { recordingState: 'ready', errorCode: '', persistenceStalled: false }, now), { accepted: true });
    }
    if (current === 'ready') return result(normalizedSession, { idempotent: true });
    return invalid(normalizedSession, 'SESSION_NOT_RETRYABLE');
  }

  if (type === 'asset_gate_recovered') {
    if (!isDurableAssetGateRecoveryCandidate(normalizedSession)) {
      return invalid(normalizedSession, 'SESSION_NOT_ASSET_GATE_RECOVERABLE');
    }
    return result(nextState(normalizedSession, {
      recordingState: 'interrupted',
      actualRecorderStarted: false,
      interruptionReason: normalizedSession.interruptionReason || 'asset_gate_recovery',
      errorCode: '',
      finalizationPending: false,
      finalizationErrorCode: '',
      recoverable: true,
      persistenceStalled: false
    }, now), { accepted: true });
  }

  if (type === 'fail_terminal') {
    if (current === 'stopped' || current === 'failed_terminal') return invalid(normalizedSession, 'SESSION_TERMINAL');
    const code = required(event.errorCode || 'MEETING_FAILED', 'MEETING_FAILED');
    return result(nextState(normalizedSession, {
      recordingState: 'failed_terminal',
      actualRecorderStarted: false,
      errorCode: code,
      recoverable: normalizedSession.committedSegmentCount > 0
    }, now), { accepted: true, errorCode: code });
  }

  return invalid(normalizedSession, 'SESSION_EVENT_INVALID');
}
