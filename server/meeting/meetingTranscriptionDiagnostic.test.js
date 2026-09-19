import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createMeetingTranscriptionDiagnosticLogger,
  hashDiagnosticIdentifier,
  sanitizeMeetingTranscriptionDiagnostic
} from './meetingTranscriptionDiagnostic.js';

test('diagnostic entries hash identifiers and keep only allowlisted safe fields', () => {
  const entry = sanitizeMeetingTranscriptionDiagnostic({
    traceId: 'meeting-trace-test',
    phase: 'diarization_result_summary',
    endpoint: '/api/meeting/transcription/source',
    meetingId: 'meeting-private',
    sourceId: 'source-private',
    jobId: 'job-private',
    recordingAttemptId: 'attempt-private',
    transcriptionRequestId: 'request-private',
    providerId: 'xfyun_asr_llm',
    providerResponseCode: '000000',
    pollingState: 'completed',
    persistenceState: 'ready',
    diarizationState: 'not_started',
    finalErrorCode: '',
    transcriptIdHash: '1122334455667788',
    roleType: 1,
    roleNum: 0,
    providerSegmentCount: 30,
    providerRoles: [1, 2],
    providerRoleCount: 2,
    firstStBg: 0,
    lastStEd: 185_700,
    diarizationRevisionIdHash: 'aabbccddeeff0011',
    diarizationRevision: 1,
    transcriptRevision: 7,
    transcriptFirstStartMs: 0,
    transcriptLastStartMs: 179_033,
    transcriptLastEndMs: 185_700,
    decodedDurationMs: 186_035,
    durationDeltaMs: 335,
    segmentCount: 5,
    sequences: [0, 1, 2, 3, 4],
    totalBytes: 2_701_749,
    reconstruction: 'PASS',
    ffmpegExitCode: 0,
    wavDurationMs: 100_000,
    windowCount: 2,
    windowDurationsMs: [60_000, 40_000],
    httpStatus: 200,
    providerCode: '000000',
    orderIdHash: 'order-hash',
    descInfo: 'signature=secret-value XFYUN_API_SECRET=secret-value',
    transcriptText: '不得进入日志',
    audioBytes: Buffer.from('不得进入日志')
  });
  assert.equal(entry.meetingIdHash, hashDiagnosticIdentifier('meeting-private'));
  assert.equal(entry.sourceIdHash, hashDiagnosticIdentifier('source-private'));
  assert.equal(entry.jobIdHash, hashDiagnosticIdentifier('job-private'));
  assert.equal(entry.recordingAttemptIdHash, hashDiagnosticIdentifier('attempt-private'));
  assert.equal(entry.transcriptionRequestIdHash, hashDiagnosticIdentifier('request-private'));
  assert.equal(entry.providerId, 'xfyun_asr_llm');
  assert.equal(entry.providerResponseCode, '000000');
  assert.equal(entry.pollingState, 'completed');
  assert.equal(entry.roleType, 1);
  assert.equal(entry.roleNum, 0);
  assert.deepEqual(entry.providerRoles, [1, 2]);
  assert.equal(entry.durationDeltaMs, 335);
  assert.equal('transcriptText' in entry, false);
  assert.equal('audioBytes' in entry, false);
  assert.match(entry.descInfo, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(entry), /secret-value|不得进入日志/);
});

test('recording checkpoint traces persist only bounded lifecycle metadata', () => {
  const entry = sanitizeMeetingTranscriptionDiagnostic({
    traceId: 'checkpoint-trace',
    phase: 'recording_checkpoint',
    meetingId: 'meeting-private',
    sourceId: 'source-private',
    recordingAttemptId: 'attempt-private',
    event: 'checkpoint_succeeded',
    checkpointId: 'checkpoint-1',
    pageEpoch: 'page-1',
    recorderGeneration: 2,
    captureEpoch: 3,
    captureOrdinal: 25,
    oldCaptureOrdinal: 24,
    successorCaptureOrdinal: 26,
    captureUnitId: 'unit-private-25',
    oldCaptureUnitId: 'unit-private-24',
    successorCaptureUnitId: 'unit-private-26',
    chunkToken: 'chunk-private-25',
    journalId: 'journal-private-25',
    containerLayout: 'independent-mp4-segments-v1',
    captureUnitState: 'SEALED',
    partCount: 2,
    captureUnitDurationMs: 12_000,
    timerState: 'armed',
    queueDepth: 1,
    maxQueueDepth: 3,
    retryCount: 1,
    backpressure: false,
    pendingDeleted: true,
    validation: 'PASS',
    eventOrder: 'data-before-stop',
    requestDataCalled: true,
    requestDataReturned: true,
    blobSize: 1234,
    blobMime: 'audio/mp4;codecs=mp4a.40.2',
    empty: false,
    committedSequence: 4,
    committedDurationMs: 80_000,
    persistedBytes: 45_000,
    success: true,
    schedulerNextTick: 'armed',
    inFlight: false,
    finalizationStep: 'final_request_data',
    finalizationPending: false,
    finalizationErrorCode: '',
    pauseObservedAt: '2026-08-14T14:00:00.000Z',
    stopRequested: true,
    stopObserved: true,
    stopObservedAt: '2026-08-14T14:00:01.000Z',
    requestDataEventRequired: true,
    requestDataEventObserved: true,
    stopDataEventObserved: true,
    transcriptText: '不得进入日志',
    audioBytes: Buffer.from('不得进入日志')
  });
  assert.equal(entry.phase, 'recording_checkpoint');
  assert.equal(entry.event, 'checkpoint_succeeded');
  assert.equal(entry.checkpointIdHash, hashDiagnosticIdentifier('checkpoint-1'));
  assert.equal(entry.pageEpochHash, hashDiagnosticIdentifier('page-1'));
  assert.equal(entry.recorderGeneration, 2);
  assert.equal(entry.captureEpoch, 3);
  assert.equal(entry.captureOrdinal, 25);
  assert.equal(entry.captureUnitIdHash, hashDiagnosticIdentifier('unit-private-25'));
  assert.equal(entry.chunkTokenHash, hashDiagnosticIdentifier('chunk-private-25'));
  assert.equal(entry.journalIdHash, hashDiagnosticIdentifier('journal-private-25'));
  assert.equal(entry.containerLayout, 'independent-mp4-segments-v1');
  assert.equal(entry.partCount, 2);
  assert.equal(entry.pendingDeleted, true);
  assert.equal(entry.committedDurationMs, 80_000);
  assert.equal(entry.success, true);
  assert.equal(entry.finalizationStep, 'final_request_data');
  assert.equal(entry.finalizationPending, false);
  assert.equal(entry.stopObserved, true);
  assert.equal(entry.requestDataEventObserved, true);
  assert.equal('transcriptText' in entry, false);
  assert.equal('audioBytes' in entry, false);
  assert.equal('captureUnitId' in entry, false);
  assert.equal('chunkToken' in entry, false);
  assert.doesNotMatch(JSON.stringify(entry), /unit-private|chunk-private|journal-private/);
});

test('state snapshot keeps only safe lifecycle metadata and hashed relationships', () => {
  const entry = sanitizeMeetingTranscriptionDiagnostic({
    traceId: 'meeting-state-test',
    phase: 'state_snapshot',
    stateSequence: 5,
    pageUrl: 'https://192.168.110.233:18443/meeting',
    buildMarker: 'stage3a-state-evidence-g210',
    sourceBaseCommit: '318113f',
    serviceWorkerPresent: false,
    serviceWorkerController: false,
    cacheVersion: 'none-declared',
    routeMeetingIdHash: '0123456789abcdef',
    meetingRecordFound: true,
    meetingRecordCount: 1,
    transcriptLookupExecuted: true,
    transcriptFound: true,
    transcriptRecordCount: 1,
    transcriptMeetingIdHash: 'fedcba9876543210',
    transcriptSourceIdHash: '0011223344556677',
    transcriptState: 'ready',
    revisionCount: 2,
    latestRevision: 2,
    latestRevisionDecryptable: true,
    audioSourceLookupExecuted: true,
    audioSourceFound: false,
    audioSourceState: 'AUDIO_SOURCE_NOT_FOUND',
    audioSourceDeleted: true,
    audioSourceTombstone: false,
    meetingTranscriptAssociated: true,
    meetingSourceAssociated: false,
    transcriptSourceAssociated: true,
    computedMode: 'TRANSCRIPT_ONLY',
    fatalErrorCode: 'AUDIO_SOURCE_NOT_FOUND',
    fatalErrorFile: 'apps/desktop/src/components/MeetingCenter.jsx',
    fatalErrorFunction: 'MeetingCenter.initialization.catch',
    rawMeetingId: 'meeting-private',
    transcriptText: '不得进入日志',
    audioBytes: Buffer.from('不得进入日志')
  });
  assert.equal(entry.stateSequence, 5);
  assert.equal(entry.routeMeetingIdHash, '0123456789abcdef');
  assert.equal(entry.transcriptState, 'ready');
  assert.equal(entry.computedMode, 'TRANSCRIPT_ONLY');
  assert.equal('rawMeetingId' in entry, false);
  assert.equal('transcriptText' in entry, false);
  assert.equal('audioBytes' in entry, false);
  assert.doesNotMatch(JSON.stringify(entry), /meeting-private|不得进入日志/);
});

test('diarization backfill audit records only safe gate metadata', () => {
  const entry = sanitizeMeetingTranscriptionDiagnostic({
    traceId: 'diarization-backfill-test',
    phase: 'diarization_backfill',
    ownerId: 'owner-private',
    meetingId: 'meeting-private',
    sourceId: 'source-private',
    transcriptId: 'transcript-private',
    generation: '218',
    buildMarker: 'stage3b-a-review-generation-218',
    sourceBaseCommit: '90bae01a6f4156a5abb84b870f7ed587484d073f',
    gate: 'G3',
    transcriptState: 'ready',
    transcriptRevision: 2,
    revisionMissing: true,
    diarizationJobFound: false,
    diarizationJobStatus: null,
    backfillCondition: true,
    managerInvoked: true,
    providerInvoked: false,
    revisionPersisted: false,
    encryptedPersistence: false,
    uiRevisionLoaded: false,
    recordingCodecExperiment: 'aac-mp4',
    selectedMimeType: 'audio/mp4;codecs=mp4a.40.2',
    actualMimeType: 'audio/mp4;codecs=mp4a.40.2',
    container: 'MP4',
    codec: 'AAC',
    audioSourceFormat: 'm4a',
    audioSourceChunkCount: 5,
    status: 'PASS',
    transcriptText: '不得进入日志',
    audioBytes: Buffer.from('不得进入日志')
  });
  assert.equal(entry.ownerIdHash, hashDiagnosticIdentifier('owner-private'));
  assert.equal(entry.meetingIdHash, hashDiagnosticIdentifier('meeting-private'));
  assert.equal(entry.transcriptIdHash, hashDiagnosticIdentifier('transcript-private'));
  assert.equal(entry.generation, '218');
  assert.equal(entry.gate, 'G3');
  assert.equal(entry.backfillCondition, true);
  assert.equal(entry.managerInvoked, true);
  assert.equal(entry.providerInvoked, false);
  assert.equal(entry.revisionPersisted, false);
  assert.equal(entry.encryptedPersistence, false);
  assert.equal(entry.uiRevisionLoaded, false);
  assert.equal(entry.recordingCodecExperiment, 'aac-mp4');
  assert.equal(entry.selectedMimeType, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(entry.actualMimeType, 'audio/mp4;codecs=mp4a.40.2');
  assert.equal(entry.container, 'MP4');
  assert.equal(entry.codec, 'AAC');
  assert.equal(entry.audioSourceFormat, 'm4a');
  assert.equal(entry.audioSourceChunkCount, 5);
  assert.equal('ownerId' in entry, false);
  assert.equal('transcriptText' in entry, false);
  assert.equal('audioBytes' in entry, false);
  assert.doesNotMatch(JSON.stringify(entry), /owner-private|meeting-private|transcript-private|不得进入日志/);
});

test('diagnostic logger writes a mode 0600 JSONL file and does not fail the caller', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-transcription-diagnostic-test-'));
  const filePath = path.join(root, 'candidate', 'meeting-transcription.jsonl');
  const logger = createMeetingTranscriptionDiagnosticLogger({ filePath, now: () => '2026-08-08T01:22:00.000Z' });
  assert.equal(await logger.log({ traceId: 'meeting-trace-test', phase: 'job_state', jobState: 'paused_retryable', status: 'FAIL' }), true);
  await logger.flush();
  const content = await readFile(filePath, 'utf8');
  assert.equal(content.trim().split('\n').length, 1);
  assert.equal(JSON.parse(content).timestamp, '2026-08-08T01:22:00.000Z');
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  await chmod(filePath, 0o600);
});

test('recording checkpoint logger is idempotent across duplicate uploads and logger restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'meeting-transcription-checkpoint-idempotency-'));
  const filePath = path.join(root, 'meeting-transcription.jsonl');
  const event = {
    traceId: 'trace-checkpoint-1',
    phase: 'recording_checkpoint',
    ownerId: 'owner-a',
    scope: 'meeting-space',
    recordingAttemptId: 'attempt-a',
    meetingId: 'meeting-a',
    sourceId: 'source-a',
    checkpointId: 'checkpoint-1',
    event: 'checkpoint_succeeded',
    committedDurationMs: 36_000,
    success: true
  };
  const firstLogger = createMeetingTranscriptionDiagnosticLogger({ filePath });
  assert.deepEqual(await firstLogger.logRecordingCheckpoint(event), { accepted: true, duplicate: false });
  assert.deepEqual(await firstLogger.logRecordingCheckpoint({ ...event, traceId: 'trace-checkpoint-1-retry' }), { accepted: true, duplicate: true });
  await firstLogger.flush();

  const restartedLogger = createMeetingTranscriptionDiagnosticLogger({ filePath });
  assert.deepEqual(await restartedLogger.logRecordingCheckpoint({ ...event, traceId: 'trace-checkpoint-1-after-restart' }), { accepted: true, duplicate: true });
  assert.deepEqual(await restartedLogger.logRecordingCheckpoint({ ...event, checkpointId: 'checkpoint-2', traceId: 'trace-checkpoint-2' }), { accepted: true, duplicate: false });
  await restartedLogger.flush();
  const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
  assert.equal(lines.length, 2);
});
