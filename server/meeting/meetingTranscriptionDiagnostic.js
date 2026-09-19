import { appendFile, chmod, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createMeetingInputDiagnosticScope } from './meetingInputDiagnosticScope.js';

export const MEETING_TRANSCRIPTION_DIAGNOSTIC_SCHEMA_VERSION = 1;

const PHASES = new Set([
  'transport_request',
  'transport_error',
  'transport_probe',
  'request_received',
  'source_chunk_received',
  'source_assembled',
  'source_normalized',
  'source_windows_created',
  'xfyun_upload',
  'xfyun_get_result',
  'source_result_received',
  'stitching',
  'transcript_write',
  'diarization_result_summary',
  'diarization_backfill',
  'job_state',
  'cleanup',
  'state_snapshot',
  'recording_checkpoint',
  'failed'
]);

const ENDPOINTS = new Set(['/api/meeting/transcription/source', '/api/meeting/transcription/chunk', '/api/meeting/transcription/diagnostic']);

function safeString(value, maximum = 160) {
  return String(value ?? '')
    .replace(/XFYUN_(?:APP_ID|API_KEY|API_SECRET)\s*[=:]\s*[^\s,;]+/gi, 'XFYUN_REDACTED')
    .replace(/(signature|accessKeySecret|orderId)\s*[=:]\s*[^\s,;]+/gi, '$1=REDACTED')
    .slice(0, maximum);
}

export function hashDiagnosticIdentifier(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16) : null;
}

function safeInteger(value, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= minimum && normalized <= maximum ? normalized : null;
}

function safeSignedInteger(value, { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= minimum && normalized <= maximum ? normalized : null;
}

function safeSequenceList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 64).map((item) => safeInteger(item, { maximum: 64 * 1024 })).filter((item) => item !== null);
}

function safeDurationList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 32).map((item) => safeInteger(item, { minimum: 1, maximum: 4 * 60 * 60 * 1000 })).filter((item) => item !== null);
}

function safeRoleList(value) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 64).map((item) => safeInteger(item, { minimum: 1, maximum: 64 })).filter((item) => item !== null);
}

function safeUrl(value, { originOnly = false } = {}) {
  try {
    const parsed = new URL(String(value || ''));
    return originOnly ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return safeString(value, 160);
  }
}

function safeBoolean(value) {
  return value === true || value === false ? value : undefined;
}

function safeHash(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return /^[0-9a-f]{16,64}$/.test(normalized) ? normalized : null;
}

export function sanitizeMeetingTranscriptionDiagnostic(input = {}, { now = () => new Date().toISOString() } = {}) {
  const phase = String(input.phase || '').trim();
  if (!PHASES.has(phase)) throw new Error('MEETING_TRANSCRIPTION_DIAGNOSTIC_PHASE_INVALID');
  const traceId = safeString(input.traceId, 96);
  if (!traceId) throw new Error('MEETING_TRANSCRIPTION_DIAGNOSTIC_TRACE_REQUIRED');
  const endpoint = input.endpoint === undefined ? undefined : String(input.endpoint || '').trim();
  if (endpoint !== undefined && !ENDPOINTS.has(endpoint)) throw new Error('MEETING_TRANSCRIPTION_DIAGNOSTIC_ENDPOINT_INVALID');
  const entry = {
    schemaVersion: MEETING_TRANSCRIPTION_DIAGNOSTIC_SCHEMA_VERSION,
    timestamp: safeString(input.timestamp || now(), 40),
    traceId,
    ...(input.diagnosticMarker === 'meeting-input-diagnostic-20260907-s3' ? { diagnosticMarker: input.diagnosticMarker } : {}),
    phase,
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(input.meetingId === undefined ? {} : { meetingIdHash: hashDiagnosticIdentifier(input.meetingId) }),
    ...(input.sourceId === undefined ? {} : { sourceIdHash: hashDiagnosticIdentifier(input.sourceId) }),
    ...(input.jobId === undefined ? {} : { jobIdHash: hashDiagnosticIdentifier(input.jobId) }),
    ...(input.recordingAttemptId === undefined ? {} : { recordingAttemptIdHash: hashDiagnosticIdentifier(input.recordingAttemptId) }),
    ...(input.transcriptionRequestId === undefined ? {} : { transcriptionRequestIdHash: hashDiagnosticIdentifier(input.transcriptionRequestId) }),
    ...(input.ownerId === undefined ? {} : { ownerIdHash: hashDiagnosticIdentifier(input.ownerId) }),
    ...(input.scope === undefined ? {} : { scope: safeString(input.scope, 96) }),
    ...(input.transcriptId === undefined ? {} : { transcriptIdHash: hashDiagnosticIdentifier(input.transcriptId) }),
    ...(input.origin === undefined ? {} : { origin: safeUrl(input.origin, { originOnly: true }) }),
    ...(input.resolvedUrl === undefined ? {} : { resolvedUrl: safeUrl(input.resolvedUrl) }),
    ...(input.endpointPathname === undefined ? {} : { endpointPathname: safeString(input.endpointPathname, 160) }),
    ...(input.httpMethod === undefined ? {} : { httpMethod: safeString(input.httpMethod, 16) }),
    ...(input.requestBodyType === undefined ? {} : { requestBodyType: safeString(input.requestBodyType, 32) }),
    ...(input.requestBodyByteLength === undefined ? {} : { requestBodyByteLength: safeInteger(input.requestBodyByteLength, { minimum: 0, maximum: 1024 * 1024 * 1024 }) }),
    ...(input.credentialsMode === undefined ? {} : { credentialsMode: safeString(input.credentialsMode, 24) }),
    ...(input.requestMode === undefined ? {} : { requestMode: safeString(input.requestMode, 24) }),
    ...(input.signalAborted === undefined ? {} : { signalAborted: safeBoolean(input.signalAborted) }),
    ...(input.timeoutConfigured === undefined ? {} : { timeoutConfigured: safeBoolean(input.timeoutConfigured) }),
    ...(input.navigatorOnLine === undefined ? {} : { navigatorOnLine: safeBoolean(input.navigatorOnLine) }),
    ...(input.sameOrigin === undefined ? {} : { sameOrigin: safeBoolean(input.sameOrigin) }),
    ...(input.protocol === undefined ? {} : { protocol: safeString(input.protocol, 12) }),
    ...(input.host === undefined ? {} : { host: safeString(input.host, 160) }),
    ...(input.port === undefined ? {} : { port: safeInteger(input.port, { minimum: 0, maximum: 65535 }) }),
    ...(input.errorName === undefined ? {} : { errorName: safeString(input.errorName, 80) }),
    ...(input.errorMessage === undefined ? {} : { errorMessage: safeString(input.errorMessage, 240) }),
    ...(input.errorCause === undefined ? {} : { errorCause: safeString(input.errorCause, 160) }),
    ...(input.isAbortError === undefined ? {} : { isAbortError: safeBoolean(input.isAbortError) }),
    ...(input.isTypeError === undefined ? {} : { isTypeError: safeBoolean(input.isTypeError) }),
    ...(input.isTimeout === undefined ? {} : { isTimeout: safeBoolean(input.isTimeout) }),
    ...(input.isCors === undefined ? {} : { isCors: safeBoolean(input.isCors) }),
    ...(input.isMixedContent === undefined ? {} : { isMixedContent: safeBoolean(input.isMixedContent) }),
    ...(input.isTlsCertificate === undefined ? {} : { isTlsCertificate: safeBoolean(input.isTlsCertificate) }),
    ...(input.isConnectionRefused === undefined ? {} : { isConnectionRefused: safeBoolean(input.isConnectionRefused) }),
    ...(input.isWrongHostPort === undefined ? {} : { isWrongHostPort: safeBoolean(input.isWrongHostPort) }),
    ...(input.isLocalhostTarget === undefined ? {} : { isLocalhostTarget: safeBoolean(input.isLocalhostTarget) }),
    ...(input.isLegacyApiBase === undefined ? {} : { isLegacyApiBase: safeBoolean(input.isLegacyApiBase) }),
    ...(input.probeMethod === undefined ? {} : { probeMethod: safeString(input.probeMethod, 16) }),
    ...(input.probeStatus === undefined ? {} : { probeStatus: safeInteger(input.probeStatus, { minimum: 100, maximum: 599 }) }),
    ...(input.probeSuccess === undefined ? {} : { probeSuccess: safeBoolean(input.probeSuccess) }),
    ...(input.sourceAssembler === undefined ? {} : { sourceAssembler: input.sourceAssembler === true }),
    ...(input.segmentCount === undefined ? {} : { segmentCount: safeInteger(input.segmentCount, { minimum: 0, maximum: 4096 }) }),
    ...(input.sequences === undefined ? {} : { sequences: safeSequenceList(input.sequences) }),
    ...(input.totalBytes === undefined ? {} : { totalBytes: safeInteger(input.totalBytes, { minimum: 0, maximum: 1024 * 1024 * 1024 }) }),
    ...(input.reconstruction === undefined ? {} : { reconstruction: input.reconstruction === 'PASS' ? 'PASS' : 'FAIL' }),
    ...(input.ffmpegExitCode === undefined ? {} : { ffmpegExitCode: safeInteger(input.ffmpegExitCode, { minimum: 0, maximum: 255 }) }),
    ...(input.wavDurationMs === undefined ? {} : { wavDurationMs: safeInteger(input.wavDurationMs, { minimum: 0, maximum: 4 * 60 * 60 * 1000 }) }),
    ...(input.windowCount === undefined ? {} : { windowCount: safeInteger(input.windowCount, { minimum: 0, maximum: 64 }) }),
    ...(input.windowDurationsMs === undefined ? {} : { windowDurationsMs: safeDurationList(input.windowDurationsMs) }),
    ...(input.uploadIndex === undefined ? {} : { uploadIndex: safeInteger(input.uploadIndex, { minimum: 0, maximum: 64 }) }),
    ...(input.getResultIndex === undefined ? {} : { getResultIndex: safeInteger(input.getResultIndex, { minimum: 0, maximum: 256 }) }),
    ...(input.httpStatus === undefined ? {} : { httpStatus: safeInteger(input.httpStatus, { minimum: 100, maximum: 599 }) }),
    ...(input.providerCode === undefined ? {} : { providerCode: safeString(input.providerCode, 40) }),
    ...(input.providerId === undefined ? {} : { providerId: safeString(input.providerId, 64) }),
    ...(input.providerResponseCode === undefined ? {} : { providerResponseCode: safeString(input.providerResponseCode, 40) }),
    ...(input.providerErrorCode === undefined ? {} : { providerErrorCode: safeString(input.providerErrorCode, 40) }),
    ...(input.pollingState === undefined ? {} : { pollingState: safeString(input.pollingState, 40) }),
    ...(input.persistenceState === undefined ? {} : { persistenceState: safeString(input.persistenceState, 40) }),
    ...(input.diarizationState === undefined ? {} : { diarizationState: safeString(input.diarizationState, 40) }),
    ...(input.finalErrorCode === undefined ? {} : { finalErrorCode: safeString(input.finalErrorCode, 80) }),
    ...(input.orderIdHash === undefined ? {} : { orderIdHash: safeString(input.orderIdHash, 64) }),
    ...(input.descInfo === undefined ? {} : { descInfo: safeString(input.descInfo, 160) }),
    ...(input.transcriptIdHash === undefined ? {} : { transcriptIdHash: safeHash(input.transcriptIdHash) }),
    ...(input.generation === undefined ? {} : { generation: safeString(input.generation, 32) }),
    ...(input.recordingCodecExperiment === undefined ? {} : { recordingCodecExperiment: safeString(input.recordingCodecExperiment, 24) }),
    ...(input.selectedMimeType === undefined ? {} : { selectedMimeType: safeString(input.selectedMimeType, 96) }),
    ...(input.actualMimeType === undefined ? {} : { actualMimeType: safeString(input.actualMimeType, 96) }),
    ...(input.container === undefined ? {} : { container: safeString(input.container, 24) }),
    ...(input.codec === undefined ? {} : { codec: safeString(input.codec, 24) }),
    ...(input.audioSourceFormat === undefined ? {} : { audioSourceFormat: safeString(input.audioSourceFormat, 24) }),
    ...(input.audioSourceChunkCount === undefined ? {} : { audioSourceChunkCount: safeInteger(input.audioSourceChunkCount, { minimum: 0, maximum: 64 }) }),
    ...(input.gate === undefined ? {} : { gate: safeString(input.gate, 16) }),
    ...(input.backfillCondition === undefined ? {} : { backfillCondition: safeBoolean(input.backfillCondition) }),
    ...(input.revisionMissing === undefined ? {} : { revisionMissing: safeBoolean(input.revisionMissing) }),
    ...(input.diarizationJobFound === undefined ? {} : { diarizationJobFound: safeBoolean(input.diarizationJobFound) }),
    ...(input.diarizationJobStatus === undefined ? {} : { diarizationJobStatus: safeString(input.diarizationJobStatus, 40) }),
    ...(input.managerInvoked === undefined ? {} : { managerInvoked: safeBoolean(input.managerInvoked) }),
    ...(input.providerInvoked === undefined ? {} : { providerInvoked: safeBoolean(input.providerInvoked) }),
    ...(input.revisionPersisted === undefined ? {} : { revisionPersisted: safeBoolean(input.revisionPersisted) }),
    ...(input.encryptedPersistence === undefined ? {} : { encryptedPersistence: safeBoolean(input.encryptedPersistence) }),
    ...(input.uiRevisionLoaded === undefined ? {} : { uiRevisionLoaded: safeBoolean(input.uiRevisionLoaded) }),
    ...(input.roleType === undefined ? {} : { roleType: safeInteger(input.roleType, { minimum: 0, maximum: 1 }) }),
    ...(input.roleNum === undefined ? {} : { roleNum: safeInteger(input.roleNum, { minimum: 0, maximum: 4 }) }),
    ...(input.providerSegmentCount === undefined ? {} : { providerSegmentCount: safeInteger(input.providerSegmentCount, { minimum: 0, maximum: 4096 }) }),
    ...(input.providerRoles === undefined ? {} : { providerRoles: safeRoleList(input.providerRoles) }),
    ...(input.providerRoleCount === undefined ? {} : { providerRoleCount: safeInteger(input.providerRoleCount, { minimum: 0, maximum: 64 }) }),
    ...(input.firstStBg === undefined ? {} : { firstStBg: safeInteger(input.firstStBg, { minimum: 0, maximum: 4 * 60 * 60 * 1000 }) }),
    ...(input.lastStEd === undefined ? {} : { lastStEd: safeInteger(input.lastStEd, { minimum: 0, maximum: 4 * 60 * 60 * 1000 }) }),
    ...(input.diarizationRevisionIdHash === undefined ? {} : { diarizationRevisionIdHash: safeHash(input.diarizationRevisionIdHash) }),
    ...(input.diarizationRevision === undefined ? {} : { diarizationRevision: safeInteger(input.diarizationRevision, { minimum: 0, maximum: 256 }) }),
    ...(input.transcriptRevision === undefined ? {} : { transcriptRevision: safeInteger(input.transcriptRevision, { minimum: 0, maximum: 256 }) }),
    ...(input.transcriptFirstStartMs === undefined ? {} : { transcriptFirstStartMs: safeInteger(input.transcriptFirstStartMs, { minimum: 0, maximum: 4 * 60 * 60 * 1000 }) }),
    ...(input.transcriptLastStartMs === undefined ? {} : { transcriptLastStartMs: safeInteger(input.transcriptLastStartMs, { minimum: 0, maximum: 4 * 60 * 60 * 1000 }) }),
    ...(input.transcriptLastEndMs === undefined ? {} : { transcriptLastEndMs: safeInteger(input.transcriptLastEndMs, { minimum: 0, maximum: 4 * 60 * 60 * 1000 }) }),
    ...(input.decodedDurationMs === undefined ? {} : { decodedDurationMs: safeInteger(input.decodedDurationMs, { minimum: 0, maximum: 4 * 60 * 60 * 1000 }) }),
    ...(input.durationDeltaMs === undefined ? {} : { durationDeltaMs: safeSignedInteger(input.durationDeltaMs, { minimum: -4 * 60 * 60 * 1000, maximum: 4 * 60 * 60 * 1000 }) }),
    ...(input.stitching === undefined ? {} : { stitching: input.stitching === 'PASS' ? 'PASS' : 'FAIL' }),
    ...(input.transcriptWrite === undefined ? {} : { transcriptWrite: input.transcriptWrite === 'PASS' ? 'PASS' : 'FAIL' }),
    ...(input.jobState === undefined ? {} : { jobState: safeString(input.jobState, 40) }),
    ...(input.cleanup === undefined ? {} : { cleanup: input.cleanup === 'PASS' ? 'PASS' : 'FAIL' }),
    ...(input.stateSequence === undefined ? {} : { stateSequence: safeInteger(input.stateSequence, { minimum: 1, maximum: 64 }) }),
    ...(input.pageUrl === undefined ? {} : { pageUrl: safeUrl(input.pageUrl) }),
    ...(input.buildMarker === undefined ? {} : { buildMarker: safeString(input.buildMarker, 96) }),
    ...(input.sourceBaseCommit === undefined ? {} : { sourceBaseCommit: safeString(input.sourceBaseCommit, 64) }),
    ...(input.serviceWorkerPresent === undefined ? {} : { serviceWorkerPresent: safeBoolean(input.serviceWorkerPresent) }),
    ...(input.serviceWorkerController === undefined ? {} : { serviceWorkerController: safeBoolean(input.serviceWorkerController) }),
    ...(input.cacheVersion === undefined ? {} : { cacheVersion: safeString(input.cacheVersion, 96) }),
    ...(input.routeMeetingIdHash === undefined ? {} : { routeMeetingIdHash: safeHash(input.routeMeetingIdHash) }),
    ...(input.meetingRecordFound === undefined ? {} : { meetingRecordFound: safeBoolean(input.meetingRecordFound) }),
    ...(input.meetingRecordCount === undefined ? {} : { meetingRecordCount: safeInteger(input.meetingRecordCount, { minimum: 0, maximum: 256 }) }),
    ...(input.meetingState === undefined ? {} : { meetingState: safeString(input.meetingState, 40) }),
    ...(input.transcriptLookupExecuted === undefined ? {} : { transcriptLookupExecuted: safeBoolean(input.transcriptLookupExecuted) }),
    ...(input.transcriptFound === undefined ? {} : { transcriptFound: safeBoolean(input.transcriptFound) }),
    ...(input.transcriptRecordCount === undefined ? {} : { transcriptRecordCount: safeInteger(input.transcriptRecordCount, { minimum: 0, maximum: 256 }) }),
    ...(input.matchingRecordCount === undefined ? {} : { matchingRecordCount: safeInteger(input.matchingRecordCount, { minimum: 0, maximum: 256 }) }),
    ...(input.transcriptMeetingIdHash === undefined ? {} : { transcriptMeetingIdHash: safeHash(input.transcriptMeetingIdHash) }),
    ...(input.transcriptSourceIdHash === undefined ? {} : { transcriptSourceIdHash: safeHash(input.transcriptSourceIdHash) }),
    ...(input.transcriptState === undefined ? {} : { transcriptState: safeString(input.transcriptState, 40) }),
    ...(input.revisionCount === undefined ? {} : { revisionCount: safeInteger(input.revisionCount, { minimum: 0, maximum: 256 }) }),
    ...(input.latestRevision === undefined ? {} : { latestRevision: safeInteger(input.latestRevision, { minimum: 0, maximum: 256 }) }),
    ...(input.latestRevisionDecryptable === undefined ? {} : { latestRevisionDecryptable: safeBoolean(input.latestRevisionDecryptable) }),
    ...(input.audioSourceLookupExecuted === undefined ? {} : { audioSourceLookupExecuted: safeBoolean(input.audioSourceLookupExecuted) }),
    ...(input.audioSourceFound === undefined ? {} : { audioSourceFound: safeBoolean(input.audioSourceFound) }),
    ...(input.audioSourceState === undefined ? {} : { audioSourceState: safeString(input.audioSourceState, 40) }),
    ...(input.audioSourceDeleted === undefined ? {} : { audioSourceDeleted: safeBoolean(input.audioSourceDeleted) }),
    ...(input.audioSourceTombstone === undefined ? {} : { audioSourceTombstone: safeBoolean(input.audioSourceTombstone) }),
    ...(input.meetingTranscriptAssociated === undefined ? {} : { meetingTranscriptAssociated: safeBoolean(input.meetingTranscriptAssociated) }),
    ...(input.meetingSourceAssociated === undefined ? {} : { meetingSourceAssociated: safeBoolean(input.meetingSourceAssociated) }),
    ...(input.transcriptSourceAssociated === undefined ? {} : { transcriptSourceAssociated: safeBoolean(input.transcriptSourceAssociated) }),
    ...(input.computedMode === undefined ? {} : { computedMode: safeString(input.computedMode, 40) }),
    ...(input.fatalErrorCode === undefined ? {} : { fatalErrorCode: safeString(input.fatalErrorCode, 80) }),
    ...(input.fatalErrorFile === undefined ? {} : { fatalErrorFile: safeString(input.fatalErrorFile, 200) }),
    ...(input.fatalErrorFunction === undefined ? {} : { fatalErrorFunction: safeString(input.fatalErrorFunction, 160) }),
    ...(input.status === undefined ? {} : { status: input.status === 'PASS' ? 'PASS' : 'FAIL' }),
    ...(input.errorCode === undefined ? {} : { errorCode: safeString(input.errorCode, 80) }),
    ...(input.event === undefined ? {} : { event: safeString(input.event, 64) }),
    ...(input.checkpointId === undefined ? {} : { checkpointIdHash: hashDiagnosticIdentifier(input.checkpointId) }),
    ...(input.pageEpoch === undefined ? {} : { pageEpochHash: hashDiagnosticIdentifier(input.pageEpoch) }),
    ...(input.recorderGeneration === undefined ? {} : { recorderGeneration: safeInteger(input.recorderGeneration, { minimum: 0, maximum: 1_000_000 }) }),
    ...(input.captureEpoch === undefined ? {} : { captureEpoch: safeInteger(input.captureEpoch, { minimum: 0, maximum: 1_000_000 }) }),
    ...(input.captureOrdinal === undefined ? {} : { captureOrdinal: safeInteger(input.captureOrdinal, { minimum: 0, maximum: 1_000_000 }) }),
    ...(input.oldCaptureOrdinal === undefined ? {} : { oldCaptureOrdinal: safeInteger(input.oldCaptureOrdinal, { minimum: 0, maximum: 1_000_000 }) }),
    ...(input.successorCaptureOrdinal === undefined ? {} : { successorCaptureOrdinal: safeInteger(input.successorCaptureOrdinal, { minimum: 0, maximum: 1_000_000 }) }),
    ...(input.captureUnitId === undefined ? {} : { captureUnitIdHash: hashDiagnosticIdentifier(input.captureUnitId) }),
    ...(input.oldCaptureUnitId === undefined ? {} : { oldCaptureUnitIdHash: hashDiagnosticIdentifier(input.oldCaptureUnitId) }),
    ...(input.successorCaptureUnitId === undefined ? {} : { successorCaptureUnitIdHash: hashDiagnosticIdentifier(input.successorCaptureUnitId) }),
    ...(input.chunkToken === undefined ? {} : { chunkTokenHash: hashDiagnosticIdentifier(input.chunkToken) }),
    ...(input.journalId === undefined ? {} : { journalIdHash: hashDiagnosticIdentifier(input.journalId) }),
    ...(input.containerLayout === undefined ? {} : { containerLayout: safeString(input.containerLayout, 64) }),
    ...(input.captureUnitState === undefined ? {} : { captureUnitState: safeString(input.captureUnitState, 32) }),
    ...(input.partCount === undefined ? {} : { partCount: safeInteger(input.partCount, { minimum: 0, maximum: 1024 }) }),
    ...(input.captureUnitDurationMs === undefined ? {} : { captureUnitDurationMs: safeInteger(input.captureUnitDurationMs, { minimum: 0, maximum: 10 * 60 * 1000 }) }),
    ...(input.timerState === undefined ? {} : { timerState: safeString(input.timerState, 24) }),
    ...(input.queueDepth === undefined ? {} : { queueDepth: safeInteger(input.queueDepth, { minimum: 0, maximum: 64 }) }),
    ...(input.maxQueueDepth === undefined ? {} : { maxQueueDepth: safeInteger(input.maxQueueDepth, { minimum: 0, maximum: 64 }) }),
    ...(input.retryCount === undefined ? {} : { retryCount: safeInteger(input.retryCount, { minimum: 0, maximum: 16 }) }),
    ...(input.backpressure === undefined ? {} : { backpressure: safeBoolean(input.backpressure) }),
    ...(input.pendingDeleted === undefined ? {} : { pendingDeleted: safeBoolean(input.pendingDeleted) }),
    ...(input.validation === undefined ? {} : { validation: safeString(input.validation, 24) }),
    ...(input.eventOrder === undefined ? {} : { eventOrder: safeString(input.eventOrder, 48) }),
    ...(input.requestedAt === undefined ? {} : { requestedAt: safeString(input.requestedAt, 40) }),
    ...(input.requestDataCalled === undefined ? {} : { requestDataCalled: safeBoolean(input.requestDataCalled) }),
    ...(input.requestDataReturned === undefined ? {} : { requestDataReturned: safeBoolean(input.requestDataReturned) }),
    ...(input.dataavailableAt === undefined ? {} : { dataavailableAt: safeString(input.dataavailableAt, 40) }),
    ...(input.blobSize === undefined ? {} : { blobSize: safeInteger(input.blobSize, { minimum: 0, maximum: 64 * 1024 * 1024 }) }),
    ...(input.blobMime === undefined ? {} : { blobMime: safeString(input.blobMime, 96) }),
    ...(input.empty === undefined ? {} : { empty: safeBoolean(input.empty) }),
    ...(input.encryptionStartedAt === undefined ? {} : { encryptionStartedAt: safeString(input.encryptionStartedAt, 40) }),
    ...(input.encryptionCompletedAt === undefined ? {} : { encryptionCompletedAt: safeString(input.encryptionCompletedAt, 40) }),
    ...(input.commitStartedAt === undefined ? {} : { commitStartedAt: safeString(input.commitStartedAt, 40) }),
    ...(input.commitCompletedAt === undefined ? {} : { commitCompletedAt: safeString(input.commitCompletedAt, 40) }),
    ...(input.committedSequence === undefined ? {} : { committedSequence: safeSignedInteger(input.committedSequence, { minimum: -1, maximum: 1_000_000 }) }),
    ...(input.committedDurationMs === undefined ? {} : { committedDurationMs: safeInteger(input.committedDurationMs, { minimum: 0, maximum: 24 * 60 * 60 * 1000 }) }),
    ...(input.persistedBytes === undefined ? {} : { persistedBytes: safeInteger(input.persistedBytes, { minimum: 0, maximum: 1024 * 1024 * 1024 }) }),
    ...(input.manifestRevision === undefined ? {} : { manifestRevision: safeInteger(input.manifestRevision, { minimum: 0, maximum: 1_000_000 }) }),
    ...(input.success === undefined ? {} : { success: safeBoolean(input.success) }),
    ...(input.failure === undefined ? {} : { failure: safeBoolean(input.failure) }),
    ...(input.timeout === undefined ? {} : { timeout: safeBoolean(input.timeout) }),
    ...(input.schedulerNextTick === undefined ? {} : { schedulerNextTick: safeString(input.schedulerNextTick, 24) }),
    ...(input.inFlight === undefined ? {} : { inFlight: safeBoolean(input.inFlight) }),
    ...(input.reason === undefined ? {} : { reason: safeString(input.reason, 64) }),
    ...(input.recorderState === undefined ? {} : { recorderState: safeString(input.recorderState, 24) }),
    ...(input.inputStreamActive === undefined ? {} : { inputStreamActive: safeBoolean(input.inputStreamActive) }),
    ...(input.inputStateKnown === undefined ? {} : { inputStateKnown: safeBoolean(input.inputStateKnown) }),
    ...(input.audioTrackCount === undefined ? {} : { audioTrackCount: safeInteger(input.audioTrackCount, { maximum: 32 }) }),
    ...(input.audioLiveTrackCount === undefined ? {} : { audioLiveTrackCount: safeInteger(input.audioLiveTrackCount, { maximum: 32 }) }),
    ...(input.audioEnabledTrackCount === undefined ? {} : { audioEnabledTrackCount: safeInteger(input.audioEnabledTrackCount, { maximum: 32 }) }),
    ...(input.audioMutedTrackCount === undefined ? {} : { audioMutedTrackCount: safeInteger(input.audioMutedTrackCount, { maximum: 32 }) }),
    ...(input.visibilityState === undefined ? {} : { visibilityState: ['visible', 'hidden', 'prerender'].includes(input.visibilityState) ? input.visibilityState : 'unknown' }),
    ...(input.elapsedCaptureMs === undefined ? {} : { elapsedCaptureMs: safeInteger(input.elapsedCaptureMs, { maximum: 24 * 60 * 60 * 1000 }) }),
    ...(input.finalizationStep === undefined ? {} : { finalizationStep: safeString(input.finalizationStep, 48) }),
    ...(input.finalizationPending === undefined ? {} : { finalizationPending: safeBoolean(input.finalizationPending) }),
    ...(input.finalizationErrorCode === undefined ? {} : { finalizationErrorCode: safeString(input.finalizationErrorCode, 80) }),
    ...(input.pauseObservedAt === undefined ? {} : { pauseObservedAt: safeString(input.pauseObservedAt, 40) }),
    ...(input.stopRequested === undefined ? {} : { stopRequested: safeBoolean(input.stopRequested) }),
    ...(input.stopObserved === undefined ? {} : { stopObserved: safeBoolean(input.stopObserved) }),
    ...(input.stopObservedAt === undefined ? {} : { stopObservedAt: safeString(input.stopObservedAt, 40) }),
    ...(input.requestDataEventRequired === undefined ? {} : { requestDataEventRequired: safeBoolean(input.requestDataEventRequired) }),
    ...(input.requestDataEventObserved === undefined ? {} : { requestDataEventObserved: safeBoolean(input.requestDataEventObserved) }),
    ...(input.stopDataEventObserved === undefined ? {} : { stopDataEventObserved: safeBoolean(input.stopDataEventObserved) })
  };
  return Object.freeze(entry);
}

export function createMeetingTranscriptionDiagnosticLogger({ filePath = '', scopeFilePath = '', now = () => new Date().toISOString() } = {}) {
  const rawPath = String(filePath || '').trim();
  const normalizedPath = rawPath ? path.resolve(rawPath) : '';
  let initialized = false;
  let chain = Promise.resolve();
  const checkpointKeys = new Set();
  const admitScopedEvent = scopeFilePath ? createMeetingInputDiagnosticScope({ scopeFilePath, now }) : null;

  function checkpointKey(entry) {
    const checkpointHash = entry?.checkpointIdHash || (admitScopedEvent && hashDiagnosticIdentifier(entry?.traceId));
    if (entry?.phase !== 'recording_checkpoint'
      || !entry.recordingAttemptIdHash
      || !checkpointHash
      || !entry.event) return '';
    return [entry.ownerIdHash || '', entry.recordingAttemptIdHash, checkpointHash, entry.event].join(':');
  }

  async function loadCheckpointKeys() {
    if (!normalizedPath) return;
    try {
      const content = await readFile(normalizedPath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const key = checkpointKey(entry);
          if (key) checkpointKeys.add(key);
        } catch {
          // Preserve append-only logs even when an older line is malformed.
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async function ensureFile() {
    if (initialized || !normalizedPath) return;
    await mkdir(path.dirname(normalizedPath), { recursive: true, mode: 0o700 });
    await appendFile(normalizedPath, '', { mode: 0o600 });
    await chmod(normalizedPath, 0o600);
    await loadCheckpointKeys();
    initialized = true;
  }

  function enqueueLog(input = {}, { checkpoint = false } = {}) {
    if (!normalizedPath) return Promise.resolve(false);
    const task = chain.catch(() => {}).then(async () => {
      try {
        const entry = sanitizeMeetingTranscriptionDiagnostic(input, { now });
        if (admitScopedEvent && !await admitScopedEvent(input, entry)) {
          return checkpoint ? { accepted: true, duplicate: false, ignored: true } : false;
        }
        await ensureFile();
        if (checkpoint) {
          const key = checkpointKey(entry);
          if (key && checkpointKeys.has(key)) return { accepted: true, duplicate: true };
          if (key) {
            await appendFile(normalizedPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
            await chmod(normalizedPath, 0o600);
            checkpointKeys.add(key);
            return { accepted: true, duplicate: false };
          }
        }
        await appendFile(normalizedPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        await chmod(normalizedPath, 0o600);
        return checkpoint ? { accepted: true, duplicate: false } : true;
      } catch {
        return checkpoint ? { accepted: false, duplicate: false } : false;
      }
    });
    chain = task;
    return task;
  }

  function log(input = {}) {
    return enqueueLog(input);
  }

  function logRecordingCheckpoint(input = {}) {
    return enqueueLog(input, { checkpoint: true });
  }

  return Object.freeze({
    enabled: Boolean(normalizedPath),
    filePath: normalizedPath || null,
    log,
    logRecordingCheckpoint,
    async flush() { await chain.catch(() => {}); },
    async close() { await chain.catch(() => {}); }
  });
}
