import {
  assertCommittedAudioSource,
  assertOwnerContext,
  createCorrectionRevision,
  createTranscriptDocument,
  createTranscriptRevision
} from '../../../../core/meeting/stage3a/transcriptContracts.js';
import { createAudioChunkStream } from '../../../../core/meeting/stage3a/audioChunking.js';
import { createMeetingSpeechGateway } from '../../../../core/meeting/stage3a/meetingSpeechGateway.js';
import { stitchTranscriptChunks } from '../../../../core/meeting/stage3a/transcriptStitching.js';
import {
  createTranscriptionJob,
  transitionTranscriptionJob
} from '../../../../core/meeting/stage3a/transcriptionJob.js';

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
  const value = typeof now === 'function' ? now() : now;
  const normalized = new Date(value || new Date()).toISOString();
  if (Number.isNaN(Date.parse(normalized))) throw codedError('TRANSCRIPTION_TIMESTAMP_INVALID');
  return normalized;
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function randomId(cryptoImpl, prefix) {
  const random = cryptoImpl?.getRandomValues ? cryptoImpl.getRandomValues(new Uint8Array(12)) : new Uint8Array();
  let binary = '';
  for (const value of random) binary += String.fromCharCode(value);
  const encoded = binary
    ? (globalThis.btoa || ((value) => Buffer.from(value, 'binary').toString('base64')))(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${encoded}`;
}

function sourceTranscriptId(source) {
  return `transcript-${encodeURIComponent(source.sourceId)}-${source.revision}`;
}

function sourceJobId(source) {
  return `transcription-${encodeURIComponent(source.sourceId)}-${source.revision}`;
}

function isRecoverableLookupError(error) {
  return ['AUDIO_SOURCE_NOT_FOUND', 'AUDIO_SOURCE_NOT_AVAILABLE', 'MEETING_NOT_FOUND'].includes(error?.code);
}

function isActiveStatus(status) {
  return ['queued', 'preparing', 'transcribing', 'stitching'].includes(status);
}

function isContinuousAudioSource(source) {
  return ['webm-opus', 'm4a'].includes(String(source?.format || '').trim().toLowerCase());
}

async function hashStateIdentifier(cryptoImpl, value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || !cryptoImpl?.subtle?.digest) return null;
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

function stateErrorCode(error) {
  const code = String(error?.code || '').trim();
  return code ? code.slice(0, 80) : 'STATE_EVIDENCE_LOOKUP_FAILED';
}

const BINARY_TRANSPORT_PROBE_BYTES = 538_970;

export function createMeetingTranscriptionManager({
  ownerContext: inputOwnerContext,
  audioStore,
  transcriptStore,
  speechGateway = createMeetingSpeechGateway(),
  cryptoImpl = globalThis.crypto,
  now = () => new Date().toISOString(),
  chunkOptions = {}
} = {}) {
  const context = assertOwnerContext(inputOwnerContext);
  if (!audioStore || typeof audioStore.getAudioSource !== 'function' || typeof audioStore.streamAudioSourceDetailed !== 'function') throw codedError('MEETING_AUDIO_STORE_REQUIRED');
  if (!transcriptStore || typeof transcriptStore.createRawTranscript !== 'function' || typeof transcriptStore.saveJob !== 'function') throw codedError('MEETING_TRANSCRIPT_STORE_REQUIRED');
  if (!speechGateway || typeof speechGateway.transcribeChunk !== 'function') throw codedError('MEETING_SPEECH_GATEWAY_REQUIRED');

  const jobs = new Map();
  // UI-only progress: never added to the encrypted persisted job contract.
  const sourceProgress = new Map();
  const transcriptOnlyJobIds = new Set();
  const runs = new Map();
  const persistenceRuns = new Map();
  const controllers = new Map();
  const cancelledJobs = new Set();
  const listeners = new Set();
  let initialized = false;

  function notify() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // Observers must not interrupt an encrypted job.
      }
    }
  }

  function snapshotJob(job) {
    let progress = sourceProgress.get(job.jobId);
    if (job.status === 'ready') progress = { phase: 'ready', percent: 100 };
    else if (job.status === 'stitching') progress = { phase: 'saving', percent: 99 };
    else if (progress?.phase === 'saving') progress = { phase: 'saving', percent: 90 + Math.min(9, Math.floor(9 * job.nextChunkSequence / Math.max(1, job.chunkCount))) };
    else if (!progress) progress = { phase: job.status, percent: Math.min(99, Math.floor(100 * (job.nextChunkSequence || 0) / Math.max(1, (job.chunkCount || 0) + 1))) };
    return { ...clone(job), progress: { ...progress } };
  }

  function getSnapshot() {
    const values = [...jobs.values()].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const activeJob = values.find((job) => isActiveStatus(job.status) && !transcriptOnlyJobIds.has(job.jobId)) || null;
    return Object.freeze({
      initialized,
      provider: speechGateway.describe?.() || Object.freeze({ status: 'unknown', available: false }),
      jobs: Object.freeze(values.map(snapshotJob)),
      activeJob: activeJob ? snapshotJob(activeJob) : null,
      transcriptOnlyJobIds: Object.freeze([...transcriptOnlyJobIds])
    });
  }

  async function collectStateEvidence({ routeMeetingId = '' } = {}) {
    const events = [];
    let stateSequence = 0;
    const normalizedRouteMeetingId = String(routeMeetingId || '').trim();
    let meetings = [];
    let meetingLookupError = null;
    try {
      meetings = typeof audioStore.listMeetings === 'function' ? await audioStore.listMeetings(context) : [];
    } catch (error) {
      meetingLookupError = error;
    }
    const storedJobs = typeof transcriptStore.listJobs === 'function' ? await transcriptStore.listJobs(context) : [...jobs.values()];
    const matchingJobs = normalizedRouteMeetingId
      ? storedJobs.filter((job) => String(job?.meetingId || '').trim() === normalizedRouteMeetingId)
      : storedJobs;
    const normalizedMeetings = Array.isArray(meetings) ? meetings : [];
    const lookupMeetingId = normalizedRouteMeetingId || String(matchingJobs[0]?.meetingId || '').trim();
    const meetingRecord = normalizedMeetings.find((item) => String(item?.meetingId || '').trim() === lookupMeetingId) || null;
    const push = (event) => {
      events.push(Object.freeze({
        phase: 'state_snapshot',
        stateSequence: stateSequence += 1,
        ...event
      }));
    };

    push({
      stateStep: 'meetingLookup',
      routeMeetingIdHash: await hashStateIdentifier(cryptoImpl, normalizedRouteMeetingId),
      meetingRecordFound: Boolean(meetingRecord),
      meetingRecordCount: normalizedMeetings.length,
      meetingState: meetingRecord?.meeting?.recordingState || meetingRecord?.recordingState || meetingRecord?.state || null,
      status: meetingLookupError ? 'FAIL' : 'PASS',
      errorCode: meetingLookupError ? stateErrorCode(meetingLookupError) : undefined
    });

    if (!matchingJobs.length) {
      push({
        stateStep: 'transcriptLookup',
        transcriptLookupExecuted: false,
        transcriptFound: false,
        transcriptRecordCount: 0,
        matchingRecordCount: 0,
        status: 'PASS'
      });
      push({
        stateStep: 'modeDecision',
        computedMode: 'AUDIO_SOURCE_REQUIRED',
        meetingTranscriptAssociated: false,
        meetingSourceAssociated: false,
        transcriptSourceAssociated: false,
        status: 'PASS'
      });
      return Object.freeze({ events: Object.freeze(events), nextStateSequence: stateSequence + 1 });
    }

    for (const job of matchingJobs) {
      const meetingId = String(job?.meetingId || '').trim();
      const sourceId = String(job?.sourceId || '').trim();
      const transcriptId = String(job?.transcriptId || '').trim();
      const jobIdHash = await hashStateIdentifier(cryptoImpl, job?.jobId);
      const meetingIdHash = await hashStateIdentifier(cryptoImpl, meetingId);
      const sourceIdHash = await hashStateIdentifier(cryptoImpl, sourceId);
      let transcript = null;
      let transcriptError = null;
      try {
        transcript = await transcriptStore.getTranscript(context, { meetingId, transcriptId });
      } catch (error) {
        transcriptError = error;
      }
      const document = transcript?.document || null;
      const transcriptFound = Boolean(document);
      const transcriptReady = document?.status === 'ready';
      push({
        stateStep: 'transcriptLookup',
        jobIdHash,
        meetingIdHash,
        sourceIdHash,
        transcriptLookupExecuted: true,
        transcriptFound,
        transcriptRecordCount: transcriptFound ? 1 : 0,
        matchingRecordCount: matchingJobs.length,
        transcriptMeetingIdHash: await hashStateIdentifier(cryptoImpl, document?.meetingId),
        transcriptSourceIdHash: await hashStateIdentifier(cryptoImpl, document?.sourceId),
        transcriptState: document?.status || (transcriptError ? stateErrorCode(transcriptError) : null),
        status: transcriptError && transcriptError?.code !== 'TRANSCRIPT_NOT_FOUND' ? 'FAIL' : 'PASS',
        errorCode: transcriptError ? stateErrorCode(transcriptError) : undefined
      });
      push({
        stateStep: 'revisionLookup',
        jobIdHash,
        meetingIdHash,
        sourceIdHash,
        revisionCount: Array.isArray(transcript?.revisions) ? transcript.revisions.length : 0,
        latestRevision: Number.isSafeInteger(document?.transcriptRevision) ? document.transcriptRevision : null,
        latestRevisionDecryptable: transcriptFound,
        status: transcriptError && transcriptError?.code !== 'TRANSCRIPT_NOT_FOUND' ? 'FAIL' : 'PASS',
        errorCode: transcriptError ? stateErrorCode(transcriptError) : undefined
      });

      let audioSource = null;
      let audioSourceError = null;
      try {
        audioSource = await audioStore.getAudioSource(context, meetingId, sourceId);
      } catch (error) {
        audioSourceError = error;
      }
      const audioSourceFound = Boolean(audioSource);
      const sourceErrorCode = audioSourceError ? stateErrorCode(audioSourceError) : null;
      const sourceState = audioSource?.importState || audioSource?.recordingState || audioSource?.state || sourceErrorCode;
      push({
        stateStep: 'sourceLookup',
        jobIdHash,
        meetingIdHash,
        sourceIdHash,
        audioSourceLookupExecuted: true,
        audioSourceFound,
        audioSourceState: sourceState || null,
        audioSourceDeleted: audioSourceFound
          ? audioSource?.importState === 'deleted' || audioSource?.state === 'deleted'
          : sourceErrorCode === 'AUDIO_SOURCE_NOT_FOUND',
        audioSourceTombstone: sourceErrorCode === 'AUDIO_SOURCE_NOT_AVAILABLE',
        status: audioSourceError && !isRecoverableLookupError(audioSourceError) ? 'FAIL' : 'PASS',
        errorCode: sourceErrorCode || undefined
      });

      push({
        stateStep: 'modeDecision',
        jobIdHash,
        meetingIdHash,
        sourceIdHash,
        computedMode: transcriptReady ? (audioSourceFound ? 'NORMAL' : 'TRANSCRIPT_ONLY') : 'AUDIO_SOURCE_REQUIRED',
        meetingTranscriptAssociated: Boolean(meetingRecord && document?.meetingId === meetingId),
        meetingSourceAssociated: Boolean(meetingRecord && audioSourceFound && audioSource?.meetingId === meetingId),
        transcriptSourceAssociated: Boolean(document && document.sourceId === sourceId),
        status: 'PASS'
      });
    }
    return Object.freeze({ events: Object.freeze(events), nextStateSequence: stateSequence + 1 });
  }

  async function resolveSource(sourceId) {
    const normalizedSourceId = required(sourceId, 'SOURCE_ID_REQUIRED');
    if (typeof audioStore.findAudioSource === 'function') {
      const found = await audioStore.findAudioSource(context, normalizedSourceId);
      if (found) return assertCommittedAudioSource({ ownerContext: context, source: found });
    }
    if (typeof audioStore.listMeetings !== 'function') throw codedError('MEETING_SOURCE_LOOKUP_REQUIRED');
    const meetings = await audioStore.listMeetings(context);
    for (const meeting of meetings) {
      const meetingId = String(meeting?.meetingId || '').trim();
      if (!meetingId) continue;
      try {
        const source = await audioStore.getAudioSource(context, meetingId, normalizedSourceId);
        if (source) return assertCommittedAudioSource({ ownerContext: context, source });
      } catch (error) {
        if (!isRecoverableLookupError(error)) throw error;
      }
    }
    throw codedError('AUDIO_SOURCE_NOT_FOUND');
  }

  async function currentSource(source) {
    const latest = await audioStore.getAudioSource(context, source.meetingId, source.sourceId);
    assertCommittedAudioSource({ ownerContext: context, source: latest });
    if (latest.revision !== source.revision || latest.checksum !== source.checksum) throw codedError('SOURCE_REVISION_MISMATCH');
    return latest;
  }

  async function recordDiagnostic(job, source, traceId, event = {}) {
    if (!traceId || typeof speechGateway.recordDiagnostic !== 'function') return;
    try {
      await speechGateway.recordDiagnostic({
        ...event,
        traceId,
        meetingId: source.meetingId,
        sourceId: source.sourceId,
        jobId: job.jobId,
        transcriptionRequestId: event.transcriptionRequestId || event.requestId || job.requestId || undefined,
        providerId: event.providerId || speechGateway.describe?.().providerId || undefined
      });
    } catch {
      // Candidate diagnostics are best effort and must never change transcription behavior.
    }
  }

  async function persistJob(job, { force = false } = {}) {
    if (!force && cancelledJobs.has(job.jobId)) return jobs.get(job.jobId) || job;
    const previous = persistenceRuns.get(job.jobId) || Promise.resolve();
    const current = previous.catch(() => {}).then(async () => {
      if (!force && cancelledJobs.has(job.jobId)) return jobs.get(job.jobId) || job;
      const result = await transcriptStore.saveJob(context, { job });
      jobs.set(job.jobId, clone(result.job || job));
      notify();
      return jobs.get(job.jobId);
    });
    persistenceRuns.set(job.jobId, current);
    try {
      return await current;
    } finally {
      if (persistenceRuns.get(job.jobId) === current) persistenceRuns.delete(job.jobId);
    }
  }

  async function waitForPersistence(jobId) {
    const pending = persistenceRuns.get(jobId);
    if (pending) await pending.catch(() => {});
  }

  async function waitForRunCompletion(jobId) {
    const running = runs.get(jobId);
    if (running) await running.catch(() => {});
  }

  async function transitionAndPersist(job, event) {
    if (cancelledJobs.has(job.jobId) && event.type !== 'cancel') return jobs.get(job.jobId) || job;
    const result = transitionTranscriptionJob(job, event, { now: timestamp(now) });
    if (result.idempotent) {
      jobs.set(job.jobId, clone(job));
      notify();
      return job;
    }
    if (!result.accepted) throw codedError(result.errorCode || 'TRANSCRIPTION_JOB_TRANSITION_REJECTED');
    return persistJob(result.state);
  }

  async function loadExistingJob(source) {
    if (typeof transcriptStore.getJob !== 'function') return null;
    try {
      const job = await transcriptStore.getJob(context, { jobId: sourceJobId(source) });
      if (job.sourceRevision !== source.revision || job.sourceId !== source.sourceId) throw codedError('SOURCE_REVISION_MISMATCH');
      jobs.set(job.jobId, clone(job));
      return job;
    } catch (error) {
      if (error?.code === 'TRANSCRIPTION_JOB_NOT_FOUND') return null;
      throw error;
    }
  }

  async function processChunk(job, chunk, source, signal, traceId) {
    let current = job;
    let providerRequestId = '';
    while (true) {
      if (signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('TRANSCRIPTION_CANCELLED');
      try {
        providerRequestId = randomId(cryptoImpl, 'transcription-request');
        const response = await speechGateway.transcribeChunk({
          ownerId: context.ownerId,
          meetingId: source.meetingId,
          sourceId: source.sourceId,
          sourceRevision: source.revision,
          requestId: providerRequestId,
          traceId,
          attempt: Math.max(1, current.attempts + 1),
          chunk
        });
        if (signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('TRANSCRIPTION_CANCELLED');
        const result = {
          provider: response.provider,
          model: response.model,
          startMs: chunk.startMs,
          endMs: chunk.endMs,
          sourceChunkRefs: chunk.sourceChunkRefs,
          segments: response.segments
        };
        await recordDiagnostic(current, source, traceId, {
          phase: 'job_state',
          transcriptionRequestId: response.requestId || providerRequestId,
          providerId: response.provider,
          providerInvoked: true,
          pollingState: response.cursor?.status || 'completed',
          status: 'PASS'
        });
        await transcriptStore.saveChunkResult(context, { job: current, sequence: chunk.sequence, result });
        if (signal.aborted || cancelledJobs.has(job.jobId)) {
          await transcriptStore.deleteTranscriptionArtifacts?.(context, { jobId: job.jobId });
          throw codedError('TRANSCRIPTION_CANCELLED');
        }
        return { job: await transitionAndPersist(current, {
          type: 'chunk_completed',
          sequence: chunk.sequence,
          chunkCount: Math.max(current.chunkCount, chunk.sequence + 1),
          requestId: response.requestId,
          lease: response.lease,
          cursor: response.cursor
        }), provider: response.provider, model: response.model };
      } catch (error) {
        if (error?.code === 'TRANSCRIPTION_CANCELLED' || signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('TRANSCRIPTION_CANCELLED');
        const retryable = error?.code !== 'REAL_MEETING_ASR_PROVIDER_BLOCKED';
        const failed = await transitionAndPersist(current, {
          type: 'provider_failed',
          errorCode: error?.code || 'TRANSCRIPTION_PROVIDER_FAILED',
          retryable
        });
        await recordDiagnostic(failed, source, traceId, {
          phase: 'failed',
          transcriptionRequestId: providerRequestId || failed.requestId,
          providerErrorCode: error?.providerErrorCode,
          errorCode: error?.code || 'TRANSCRIPTION_PROVIDER_FAILED',
          jobState: failed.status,
          status: 'FAIL'
        });
        if (!retryable || failed.status === 'paused_retryable') return { job: failed, provider: '', model: '' };
        current = await transitionAndPersist(failed, { type: 'retry' });
        current = await transitionAndPersist(current, { type: 'prepare' });
        current = await transitionAndPersist(current, { type: 'begin_transcribing', requestId: randomId(cryptoImpl, 'transcription-request') });
      }
    }
  }

  function sourceStream(source) {
    return (async function* enrichSourceStream() {
      for await (const piece of audioStore.streamAudioSourceDetailed(context, { meetingId: source.meetingId, sourceId: source.sourceId })) {
        yield {
          ...piece,
          fileName: piece.fileName || source.originalFileName,
          mimeType: piece.mimeType || source.mimeType,
          format: piece.format || source.format,
          ...((piece.containerLayout || source.containerLayout)
            ? { containerLayout: piece.containerLayout || source.containerLayout }
            : {})
        };
      }
    }());
  }

  async function readBinaryTransportProbeBytes(source, targetLength = BINARY_TRANSPORT_PROBE_BYTES) {
    const parts = [];
    let total = 0;
    for await (const piece of audioStore.streamAudioSourceDetailed(context, { meetingId: source.meetingId, sourceId: source.sourceId })) {
      const bytes = piece?.bytes instanceof Uint8Array ? piece.bytes : new Uint8Array(piece?.bytes || []);
      if (!bytes.byteLength) continue;
      const remaining = targetLength - total;
      const part = bytes.slice(0, remaining);
      parts.push(part);
      total += part.byteLength;
      if (total >= targetLength) break;
    }
    if (total < targetLength) throw codedError('MEETING_BINARY_TRANSPORT_PROBE_SOURCE_TOO_SMALL');
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  }

  async function processSource(job, source, signal, traceId) {
    let current = job;
    let providerRequestId = '';
    while (true) {
      if (signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('TRANSCRIPTION_CANCELLED');
      try {
        sourceProgress.set(job.jobId, { phase: 'uploading', percent: 0 });
        notify();
        providerRequestId = randomId(cryptoImpl, 'transcription-source-request');
        const response = await speechGateway.transcribeSource({
          ownerId: context.ownerId,
          meetingId: source.meetingId,
          sourceId: source.sourceId,
          sourceRevision: source.revision,
          requestId: providerRequestId,
          traceId,
          attempt: Math.max(1, current.attempts + 1),
          source: {
            fileName: source.originalFileName,
            mimeType: source.mimeType,
            format: source.format,
            byteLength: source.byteLength,
            durationMs: source.durationMs,
            chunkCount: source.chunkCount,
            checksum: source.checksum,
            ...(source.containerLayout ? { containerLayout: source.containerLayout } : {})
          },
          sourceChunks: sourceStream(source),
          onProgress(progress) {
            if (signal.aborted || cancelledJobs.has(job.jobId)) return;
            const { phase, completedChunks, totalChunks } = progress || {};
            if (!['uploading', 'recognizing', 'saving'].includes(phase)
              || !Number.isSafeInteger(completedChunks) || !Number.isSafeInteger(totalChunks)
              || totalChunks < 1 || completedChunks < 0 || completedChunks > totalChunks) return;
            // Upload acknowledgements account for 80%; a returned recognition
            // result accounts for 90%. Only a saved ready transcript gets 100%.
            sourceProgress.set(job.jobId, { phase, percent: phase === 'saving' ? 90 : Math.floor(80 * completedChunks / totalChunks) });
            notify();
          },
          signal
        });
        if (signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('TRANSCRIPTION_CANCELLED');
        if (!Array.isArray(response?.chunks) || response.chunks.length === 0) throw codedError('TRANSCRIPTION_SOURCE_CHUNKS_EMPTY');
        sourceProgress.set(job.jobId, { phase: 'saving', percent: 90 });
        notify();
        await recordDiagnostic(current, source, traceId, {
          phase: 'source_result_received',
          transcriptionRequestId: response.requestId || providerRequestId,
          providerId: response.provider,
          providerInvoked: true,
          pollingState: response.cursor?.status || 'completed',
          windowCount: response.chunks.length,
          windowDurationsMs: response.chunks.map((chunk) => Number(chunk.endMs) - Number(chunk.startMs)),
          status: 'PASS'
        });
        return { job: current, response };
      } catch (error) {
        if (error?.code === 'TRANSCRIPTION_CANCELLED' || signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('TRANSCRIPTION_CANCELLED');
        const retryable = error?.code !== 'REAL_MEETING_ASR_PROVIDER_BLOCKED';
        const failed = await transitionAndPersist(current, {
          type: 'provider_failed',
          errorCode: error?.code || 'TRANSCRIPTION_PROVIDER_FAILED',
          retryable
        });
        await recordDiagnostic(failed, source, traceId, {
          phase: 'failed',
          transcriptionRequestId: providerRequestId || failed.requestId,
          providerErrorCode: error?.providerErrorCode,
          errorCode: error?.code || 'TRANSCRIPTION_PROVIDER_FAILED',
          jobState: failed.status,
          status: 'FAIL'
        });
        if (!retryable || failed.status === 'paused_retryable') return { job: failed, response: null };
        current = await transitionAndPersist(failed, { type: 'retry' });
        current = await transitionAndPersist(current, { type: 'prepare' });
        current = await transitionAndPersist(current, { type: 'begin_transcribing', requestId: randomId(cryptoImpl, 'transcription-source-request') });
      }
    }
  }

  async function failJob(job, error) {
    if (cancelledJobs.has(job.jobId)) return jobs.get(job.jobId) || job;
    if (error?.code === 'SOURCE_REVISION_MISMATCH') {
      return transitionAndPersist(job, { type: 'source_revision_changed' });
    }
    if (['queued', 'preparing', 'transcribing', 'stitching'].includes(job.status)) {
      return transitionAndPersist(job, { type: 'provider_failed', errorCode: error?.code || 'TRANSCRIPTION_FAILED_TERMINAL', retryable: false });
    }
    return job;
  }

  async function runJob(initialJob, source, { traceId = '' } = {}) {
    let job = initialJob;
    let providerId = speechGateway.describe?.().providerId || 'unknown';
    let model = speechGateway.describe?.().model || 'unknown';
    let effectiveDurationMs = source.durationMs;
    const controller = new AbortController();
    controllers.set(job.jobId, controller);
    try {
      if (job.status === 'queued') job = await transitionAndPersist(job, { type: 'prepare' });
      if (job.status === 'preparing') job = await transitionAndPersist(job, { type: 'begin_transcribing', requestId: randomId(cryptoImpl, 'transcription-request') });
      let finalChunkCount = job.chunkCount;
      if (job.status === 'transcribing') {
        const useContinuousSourcePipeline = isContinuousAudioSource(source);
        if (useContinuousSourcePipeline && speechGateway.describe?.().sourceAvailable !== true) {
          throw codedError('MEETING_TRANSCRIPTION_SOURCE_UNSUPPORTED');
        }
        await currentSource(source);
        let savedChunks = typeof transcriptStore.listChunkResults === 'function'
          ? await transcriptStore.listChunkResults(context, { jobId: job.jobId, meetingId: source.meetingId, sourceId: source.sourceId, transcriptId: job.transcriptId, transcriptRevision: job.transcriptRevision })
          : [];
        if (useContinuousSourcePipeline) {
          if (savedChunks.length || job.completedChunkSequences.length) {
            await transcriptStore.deleteTranscriptionChunkResults?.(context, { jobId: job.jobId });
            job = await transitionAndPersist(job, { type: 'reset_source_pipeline' });
            savedChunks = [];
          }
          const sourceResult = await processSource(job, source, controller.signal, traceId);
          job = sourceResult.job;
          if (job.status !== 'transcribing') return job;
          providerId = sourceResult.response.provider || providerId;
          model = sourceResult.response.model || model;
          effectiveDurationMs = sourceResult.response.effectiveDurationMs || source.durationMs;
          for (const chunk of sourceResult.response.chunks) {
            if (controller.signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('TRANSCRIPTION_CANCELLED');
            if (chunk.sequence !== job.nextChunkSequence) throw codedError('TRANSCRIPTION_CHUNK_OUT_OF_ORDER');
            await currentSource(source);
            await transcriptStore.saveChunkResult(context, {
              job,
              sequence: chunk.sequence,
              result: {
                provider: sourceResult.response.provider,
                model: sourceResult.response.model,
                effectiveDurationMs,
                startMs: chunk.startMs,
                endMs: chunk.endMs,
                sourceChunkRefs: chunk.sourceChunkRefs,
                segments: chunk.segments
              }
            });
            job = await transitionAndPersist(job, {
              type: 'chunk_completed',
              sequence: chunk.sequence,
              chunkCount: sourceResult.response.chunks.length,
              requestId: sourceResult.response.requestId,
              lease: sourceResult.response.lease,
              cursor: sourceResult.response.cursor
            });
            finalChunkCount = chunk.sequence + 1;
          }
        } else {
          const savedBySequence = new Map(savedChunks.map((entry) => [entry.sequence, entry]));
          while (savedBySequence.has(job.nextChunkSequence)) {
            const saved = savedBySequence.get(job.nextChunkSequence);
            job = await transitionAndPersist(job, {
              type: 'chunk_completed',
              sequence: saved.sequence,
              chunkCount: Math.max(job.chunkCount, saved.sequence + 1)
            });
            finalChunkCount = Math.max(finalChunkCount, saved.sequence + 1);
          }
          if (savedChunks.length !== job.completedChunkSequences.length) throw codedError('TRANSCRIPTION_CHUNK_PERSISTENCE_MISMATCH');
          const chunks = createAudioChunkStream(sourceStream(source), { ...chunkOptions, signal: controller.signal });
          for await (const chunk of chunks) {
            if (controller.signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('TRANSCRIPTION_CANCELLED');
            if (chunk.sequence < job.nextChunkSequence) {
              finalChunkCount = Math.max(finalChunkCount, chunk.sequence + 1);
              continue;
            }
            if (chunk.sequence !== job.nextChunkSequence) throw codedError('TRANSCRIPTION_CHUNK_OUT_OF_ORDER');
            await currentSource(source);
            const result = await processChunk(job, chunk, source, controller.signal, traceId);
            job = result.job;
            providerId = result.provider || providerId;
            model = result.model || model;
            finalChunkCount = Math.max(finalChunkCount, chunk.sequence + 1);
            if (job.status !== 'transcribing') return job;
          }
        }
        if (controller.signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('TRANSCRIPTION_CANCELLED');
        if (finalChunkCount < 1) throw codedError('TRANSCRIPTION_CHUNKS_EMPTY');
        if (job.nextChunkSequence !== finalChunkCount) throw codedError('TRANSCRIPTION_CHUNK_PERSISTENCE_MISMATCH');
        job = await transitionAndPersist(job, { type: 'begin_stitching', chunkCount: finalChunkCount });
      }
      if (job.status !== 'stitching') return job;
      await currentSource(source);
      const persisted = await transcriptStore.listChunkResults(context, { jobId: job.jobId, meetingId: source.meetingId, sourceId: source.sourceId, transcriptId: job.transcriptId, transcriptRevision: job.transcriptRevision });
      finalChunkCount = job.chunkCount;
      providerId = persisted.at(-1)?.result?.provider || providerId;
      model = persisted.at(-1)?.result?.model || model;
      const persistedEffectiveDurationMs = persisted
        .map(({ result }) => Number(result?.effectiveDurationMs))
        .find((value) => Number.isSafeInteger(value) && value > 0);
      effectiveDurationMs = persistedEffectiveDurationMs || effectiveDurationMs || source.durationMs;
      if (finalChunkCount < 1) throw codedError('TRANSCRIPTION_CHUNKS_EMPTY');
      let stitched;
      try {
        stitched = stitchTranscriptChunks({
          transcriptId: job.transcriptId,
          sourceRevision: source.revision,
          sourceDurationMs: effectiveDurationMs,
          expectedChunkCount: finalChunkCount,
          chunks: persisted.map(({ sequence, result }) => ({ sequence, ...result }))
        });
        await recordDiagnostic(job, source, traceId, {
          phase: 'stitching',
          stitching: 'PASS',
          status: 'PASS'
        });
      } catch (error) {
        await recordDiagnostic(job, source, traceId, {
          phase: 'stitching',
          stitching: 'FAIL',
          errorCode: error?.code || 'TRANSCRIPTION_STITCHING_FAILED',
          status: 'FAIL'
        });
        throw error;
      }
      const revision = createTranscriptRevision({
        ownerContext: context,
        transcriptId: job.transcriptId,
        meetingId: source.meetingId,
        sourceId: source.sourceId,
        sourceRevision: source.revision,
        transcriptRevision: 1,
        kind: 'raw_asr',
        segments: stitched.segments,
        createdAt: timestamp(now),
        createdBy: 'meeting_transcription'
      });
      const document = createTranscriptDocument({
        ownerContext: context,
        transcriptId: job.transcriptId,
        meetingId: source.meetingId,
        sourceId: source.sourceId,
        sourceRevision: source.revision,
        transcriptRevision: 1,
        language: 'zh-CN',
        provider: providerId,
        model,
        status: 'ready',
        sourceChecksum: source.checksum,
        createdAt: revision.createdAt,
        updatedAt: revision.createdAt
      });
      try {
        await transcriptStore.createRawTranscript(context, { source, document, revision });
        await recordDiagnostic(job, source, traceId, {
          phase: 'transcript_write',
          transcriptWrite: 'PASS',
          status: 'PASS'
        });
      } catch (error) {
        await recordDiagnostic(job, source, traceId, {
          phase: 'transcript_write',
          transcriptWrite: 'FAIL',
          errorCode: error?.code || 'TRANSCRIPT_WRITE_FAILED',
          status: 'FAIL'
        });
        throw error;
      }
      job = await transitionAndPersist(job, { type: 'ready', transcriptRevision: 1 });
      await recordDiagnostic(job, source, traceId, { phase: 'job_state', jobState: job.status, status: 'PASS' });
      return job;
    } catch (error) {
      if (error?.code === 'TRANSCRIPTION_CANCELLED' || controller.signal.aborted || cancelledJobs.has(job.jobId)) return jobs.get(job.jobId) || job;
      const failedJob = await failJob(job, error);
      await recordDiagnostic(failedJob, source, traceId, {
        phase: 'failed',
        providerErrorCode: error?.providerErrorCode,
        errorCode: error?.code || 'TRANSCRIPTION_FAILED',
        jobState: failedJob.status,
        status: 'FAIL'
      });
      return failedJob;
    } finally {
      controllers.delete(job.jobId);
    }
  }

  function schedule(job, source, { traceId = '' } = {}) {
    if (runs.has(job.jobId)) return runs.get(job.jobId);
    // Register the run lock before entering runJob. runJob can publish a
    // failed state during its first synchronous turn; without this deferred
    // start, a subscriber that manually resumes at that point can schedule a
    // second run and then have this older run overwrite it.
    const execution = Promise.resolve().then(() => runJob(job, source, { traceId }));
    const promise = execution.then((finalJob) => {
      jobs.set(finalJob.jobId, clone(finalJob));
      notify();
      return Object.freeze({ job: clone(finalJob) });
    }).catch(async (error) => {
      const current = jobs.get(job.jobId) || job;
      const finalJob = await failJob(current, error);
      jobs.set(finalJob.jobId, clone(finalJob));
      notify();
      return Object.freeze({ job: clone(finalJob), errorCode: finalJob.errorCode });
    }).finally(() => {
      runs.delete(job.jobId);
      controllers.delete(job.jobId);
    });
    runs.set(job.jobId, promise);
    return promise;
  }

  async function startTranscription({ sourceId } = {}) {
    const source = await resolveSource(sourceId);
    let job = await loadExistingJob(source);
    if (!job) {
      job = createTranscriptionJob({
        ownerId: context.ownerId,
        meetingId: source.meetingId,
        sourceId: source.sourceId,
        sourceRevision: source.revision,
        transcriptId: sourceTranscriptId(source),
        jobId: sourceJobId(source),
        now: timestamp(now)
      });
      await persistJob(job);
    }
    if (job.status === 'ready' || isActiveStatus(job.status)) {
      if (isActiveStatus(job.status)) schedule(job, source, { traceId: randomId(cryptoImpl, 'meeting-trace') });
      return Object.freeze({ job: clone(job), provider: speechGateway.describe?.() || null });
    }
    throw codedError(job.errorCode || 'TRANSCRIPTION_JOB_NOT_STARTABLE');
  }

  async function resumeTranscription({ sourceId } = {}) {
    const source = await resolveSource(sourceId);
    const initialJob = await loadExistingJob(source);
    if (!initialJob) throw codedError('TRANSCRIPTION_JOB_NOT_FOUND');
    // A failed job is published to observers just before schedule() releases
    // its run lock. Wait for that old run to finish before resetting and
    // scheduling the manual resume; otherwise schedule() can see the stale
    // resolved promise and silently skip the new run.
    await waitForRunCompletion(initialJob.jobId);
    const job = await loadExistingJob(source);
    if (!job) throw codedError('TRANSCRIPTION_JOB_NOT_FOUND');
    const resetSourcePipeline = isContinuousAudioSource(source) && speechGateway.describe?.().sourceAvailable === true;
    if (resetSourcePipeline && typeof transcriptStore.deleteTranscriptionChunkResults === 'function') {
      await transcriptStore.deleteTranscriptionChunkResults(context, { jobId: job.jobId });
    }
    const resumed = ['paused_retryable', 'failed_retryable', 'failed_terminal'].includes(job.status)
      ? await transitionAndPersist(job, { type: 'manual_resume', resetChunks: resetSourcePipeline })
      : job;
    const traceId = randomId(cryptoImpl, 'meeting-trace');
    try {
      await speechGateway.probeTransport?.({ traceId, meetingId: source.meetingId, sourceId: source.sourceId, jobId: resumed.jobId });
    } catch {
      // Transport probing is diagnostic-only and must not alter the retry contract.
    }
    if (speechGateway.supportsBinaryTransportProbe?.() === true) {
      const probe = await speechGateway.probeBinaryTransport({
        traceId,
        meetingId: source.meetingId,
        sourceId: source.sourceId,
        jobId: resumed.jobId,
        bytes: await readBinaryTransportProbeBytes(source)
      });
      if (probe?.success !== true || probe.clientBlobSize !== probe.serverReceivedBytes) {
        throw codedError('MEETING_BINARY_TRANSPORT_PROBE_FAILED');
      }
    }
    const completed = await schedule(resumed, source, { traceId });
    return Object.freeze({ job: clone(completed.job || resumed), provider: speechGateway.describe?.() || null });
  }

  async function getTranscriptView({ sourceId, meetingId, transcriptId } = {}) {
    const normalizedSourceId = String(sourceId ?? '').trim();
    const suppliedMeetingId = String(meetingId ?? '').trim();
    const suppliedTranscriptId = String(transcriptId ?? '').trim();
    let source = null;
    let sourceLookupError = null;
    let transcript = null;
    let transcriptLookupError = null;

    // A ready Transcript is independently readable after its source is deleted.
    // When the caller has the persisted transcript identity, load it first so a
    // missing source cannot terminate the refresh path before transcript-only
    // recovery is decided.
    if (suppliedMeetingId && suppliedTranscriptId) {
      try {
        transcript = await transcriptStore.getTranscript(context, {
          meetingId: suppliedMeetingId,
          transcriptId: suppliedTranscriptId
        });
      } catch (error) {
        if (error?.code !== 'TRANSCRIPT_NOT_FOUND') throw error;
        transcriptLookupError = error;
      }
    }

    if (normalizedSourceId) {
      try {
        source = await resolveSource(normalizedSourceId);
      } catch (error) {
        if (!isRecoverableLookupError(error)) throw error;
        sourceLookupError = error;
      }
    }
    if (!source && !transcript && transcriptLookupError) throw sourceLookupError || codedError('AUDIO_SOURCE_NOT_FOUND');
    if (!source && !transcript && !suppliedTranscriptId) throw sourceLookupError || codedError('AUDIO_SOURCE_NOT_FOUND');
    const normalizedMeetingId = required(source?.meetingId || transcript?.document?.meetingId || suppliedMeetingId, 'MEETING_ID_REQUIRED');
    const normalizedTranscriptId = required(suppliedTranscriptId || transcript?.document?.transcriptId || (source ? sourceTranscriptId(source) : ''), 'TRANSCRIPT_ID_REQUIRED');
    if (source && normalizedTranscriptId !== sourceTranscriptId(source)) throw codedError('TRANSCRIPT_SCOPE_MISMATCH');
    if (!transcript) {
      if (transcriptLookupError) throw transcriptLookupError;
      transcript = await transcriptStore.getTranscript(context, {
        meetingId: normalizedMeetingId,
        transcriptId: normalizedTranscriptId
      });
    }
    const expectedSourceId = source?.sourceId || normalizedSourceId;
    if (transcript.document.meetingId !== normalizedMeetingId || (expectedSourceId && transcript.document.sourceId !== expectedSourceId)) {
      throw codedError('TRANSCRIPT_SCOPE_MISMATCH');
    }
    if (!source && transcript.document.status !== 'ready') throw sourceLookupError || codedError('AUDIO_SOURCE_NOT_FOUND');
    return Object.freeze({
      transcript,
      source: source ? clone(source) : null,
      mode: source ? 'source' : 'transcript_only'
    });
  }

  async function cancelTranscription({ jobId, sourceId } = {}) {
    const normalizedJobId = String(jobId || '').trim();
    let job = normalizedJobId ? jobs.get(normalizedJobId) : null;
    if (!job && normalizedJobId && typeof transcriptStore.getJob === 'function') job = await transcriptStore.getJob(context, { jobId: normalizedJobId });
    if (!job && sourceId) {
      const source = await resolveSource(sourceId);
      job = await loadExistingJob(source);
    }
    if (!job) throw codedError('TRANSCRIPTION_JOB_NOT_FOUND');
    cancelledJobs.add(job.jobId);
    controllers.get(job.jobId)?.abort();
    await waitForPersistence(job.jobId);
    if (typeof transcriptStore.getJob === 'function') {
      try {
        job = await transcriptStore.getJob(context, { jobId: job.jobId });
        jobs.set(job.jobId, clone(job));
      } catch (error) {
        if (error?.code !== 'TRANSCRIPTION_JOB_NOT_FOUND') throw error;
      }
    }
    if (job.status !== 'cancelled') {
      const result = transitionTranscriptionJob(job, { type: 'cancel' }, { now: timestamp(now) });
      if (!result.accepted && !result.idempotent) throw codedError(result.errorCode || 'TRANSCRIPTION_CANCEL_REJECTED');
      job = result.state || job;
      jobs.set(job.jobId, clone(job));
      notify();
      await persistJob(job, { force: true });
    }
    jobs.set(job.jobId, clone(job));
    if (typeof transcriptStore.deleteTranscriptionArtifacts === 'function') await transcriptStore.deleteTranscriptionArtifacts(context, { jobId: job.jobId });
    notify();
    return Object.freeze({ job: clone(job) });
  }

  async function waitForJob(jobId) {
    const normalizedJobId = required(jobId, 'TRANSCRIPTION_JOB_ID_REQUIRED');
    if (runs.has(normalizedJobId)) return runs.get(normalizedJobId);
    if (jobs.has(normalizedJobId)) return Object.freeze({ job: clone(jobs.get(normalizedJobId)) });
    if (typeof transcriptStore.getJob === 'function') {
      const job = await transcriptStore.getJob(context, { jobId: normalizedJobId });
      jobs.set(job.jobId, clone(job));
      return Object.freeze({ job: clone(job) });
    }
    throw codedError('TRANSCRIPTION_JOB_NOT_FOUND');
  }

  async function getTranscript({ sourceId } = {}) {
    return (await getTranscriptView({ sourceId })).transcript;
  }

  async function saveCorrection({ sourceId, meetingId, transcriptId, actorId, edits } = {}) {
    const view = await getTranscriptView({ sourceId, meetingId, transcriptId });
    const current = view.transcript;
    const correction = createCorrectionRevision({ ownerContext: context, parent: current.currentRevision, actorId, edits, now: timestamp(now) });
    return transcriptStore.appendRevision(context, { revision: correction });
  }

  async function hasReadyTranscript(job) {
    try {
      const transcript = await transcriptStore.getTranscript(context, {
        meetingId: job.meetingId,
        transcriptId: job.transcriptId
      });
      return transcript.document.status === 'ready';
    } catch (error) {
      if (error?.code === 'TRANSCRIPT_NOT_FOUND') return false;
      throw error;
    }
  }

  async function initialize() {
    if (typeof speechGateway.probeCapability === 'function') {
      try {
        await speechGateway.probeCapability();
      } catch {
        // Capability probes fail closed in the Provider; stored Meeting data remains readable.
      }
    }
    transcriptOnlyJobIds.clear();
    if (typeof transcriptStore.listJobs === 'function') {
      const stored = await transcriptStore.listJobs(context);
      for (const job of stored) {
        jobs.set(job.jobId, clone(job));
        if (!isActiveStatus(job.status)) {
          if (job.status !== 'ready' && await hasReadyTranscript(job)) transcriptOnlyJobIds.add(job.jobId);
          continue;
        }
        if (isActiveStatus(job.status)) {
          let source;
          try {
            source = await resolveSource(job.sourceId);
          } catch (error) {
            if (!isRecoverableLookupError(error)) throw error;
            if (await hasReadyTranscript(job)) {
              transcriptOnlyJobIds.add(job.jobId);
              continue;
            }
            throw error;
          }
          if (source.revision !== job.sourceRevision) {
            await transitionAndPersist(job, { type: 'source_revision_changed' });
          } else {
            schedule(job, source, { traceId: randomId(cryptoImpl, 'meeting-trace') });
          }
        }
      }
    }
    initialized = true;
    notify();
    return getSnapshot();
  }

  return Object.freeze({
    initialize,
    startTranscription,
    resumeTranscription,
    cancelTranscription,
    waitForJob,
    getTranscriptView,
    getTranscript,
    saveCorrection,
    collectStateEvidence,
    recordDiagnostic: (event = {}) => speechGateway.recordDiagnostic?.(event),
    getSnapshot,
    describeProvider: () => speechGateway.describe?.() || Object.freeze({ available: false, status: 'unknown' }),
    subscribe(listener) {
      if (typeof listener !== 'function') throw codedError('TRANSCRIPTION_LISTENER_REQUIRED');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}

export { codedError };
