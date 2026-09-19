import { assertCommittedAudioSource, assertOwnerContext } from '../../../../core/meeting/stage3a/transcriptContracts.js';
import { mapDiarizationToTranscript } from '../../../../core/meeting/stage3b/diarizationMapping.js';
import { createDiarizationJob, transitionDiarizationJob } from '../../../../core/meeting/stage3b/diarizationJob.js';

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
  if (Number.isNaN(Date.parse(normalized))) throw codedError('DIARIZATION_TIMESTAMP_INVALID');
  return normalized;
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

async function hashIdentifier(cryptoImpl, value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || !cryptoImpl?.subtle?.digest) return null;
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(normalized));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, '0')).join('').slice(0, 16);
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

function sourceDiarizationJobId(source, transcriptRevision) {
  return `diarization-${encodeURIComponent(source.sourceId)}-${source.revision}-${transcriptRevision}`;
}

function activeStatus(status) {
  return ['queued', 'preparing', 'diarizing', 'stitching'].includes(status);
}

function speakerCount(value) {
  const normalized = Number(value ?? 0);
  if (!(normalized === 0 || [2, 3, 4].includes(normalized))) throw codedError('DIARIZATION_SPEAKER_COUNT_INVALID');
  return normalized;
}

function recoverableLookup(error) {
  return ['AUDIO_SOURCE_NOT_FOUND', 'AUDIO_SOURCE_NOT_AVAILABLE', 'MEETING_NOT_FOUND'].includes(error?.code);
}

export function createMeetingDiarizationManager({
  ownerContext: inputOwnerContext,
  audioStore,
  transcriptStore,
  diarizationStore,
  speechGateway,
  cryptoImpl = globalThis.crypto,
  now = () => new Date().toISOString()
} = {}) {
  const context = assertOwnerContext(inputOwnerContext);
  if (!audioStore || typeof audioStore.getAudioSource !== 'function' || typeof audioStore.streamAudioSourceDetailed !== 'function') throw codedError('MEETING_AUDIO_STORE_REQUIRED');
  if (!transcriptStore || typeof transcriptStore.getTranscript !== 'function') throw codedError('MEETING_TRANSCRIPT_STORE_REQUIRED');
  if (!diarizationStore || typeof diarizationStore.saveRevision !== 'function' || typeof diarizationStore.saveJob !== 'function') throw codedError('MEETING_DIARIZATION_STORE_REQUIRED');
  if (!speechGateway || typeof speechGateway.transcribeSource !== 'function') throw codedError('MEETING_SPEECH_GATEWAY_REQUIRED');

  const jobs = new Map();
  const runs = new Map();
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
        // Observer failures must not interrupt encrypted diarization state.
      }
    }
  }

  function getSnapshot() {
    const values = [...jobs.values()].sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    return Object.freeze({
      initialized,
      provider: speechGateway.describe?.() || Object.freeze({ available: false, status: 'unknown', diarizationAvailable: false }),
      jobs: Object.freeze(values.map(clone)),
      activeJob: clone(values.find((job) => activeStatus(job.status)) || null)
    });
  }

  async function resolveSource(sourceId, meetingId = '') {
    const normalizedSourceId = required(sourceId, 'SOURCE_ID_REQUIRED');
    if (meetingId) {
      return assertCommittedAudioSource({ ownerContext: context, source: await audioStore.getAudioSource(context, meetingId, normalizedSourceId) });
    }
    if (typeof audioStore.findAudioSource === 'function') {
      const found = await audioStore.findAudioSource(context, normalizedSourceId);
      if (found) return assertCommittedAudioSource({ ownerContext: context, source: found });
    }
    if (typeof audioStore.listMeetings !== 'function') throw codedError('MEETING_SOURCE_LOOKUP_REQUIRED');
    for (const meeting of await audioStore.listMeetings(context)) {
      const candidateMeetingId = String(meeting?.meetingId || '').trim();
      if (!candidateMeetingId) continue;
      try {
        const found = await audioStore.getAudioSource(context, candidateMeetingId, normalizedSourceId);
        if (found) return assertCommittedAudioSource({ ownerContext: context, source: found });
      } catch (error) {
        if (!recoverableLookup(error)) throw error;
      }
    }
    throw codedError('AUDIO_SOURCE_NOT_FOUND');
  }

  async function loadTranscript(source, transcriptId) {
    const normalizedTranscriptId = required(transcriptId || sourceTranscriptId(source), 'TRANSCRIPT_ID_REQUIRED');
    const transcript = await transcriptStore.getTranscript(context, {
      meetingId: source.meetingId,
      transcriptId: normalizedTranscriptId
    });
    const actualTranscriptId = required(transcript?.document?.transcriptId, 'DIARIZATION_TRANSCRIPT_ID_REQUIRED');
    if (actualTranscriptId !== normalizedTranscriptId) throw codedError('DIARIZATION_TRANSCRIPT_SCOPE_MISMATCH');
    if (transcript?.document?.ownerId && transcript.document.ownerId !== context.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
    if (transcript?.document?.meetingId !== source.meetingId || transcript?.document?.sourceId !== source.sourceId || transcript?.document?.sourceRevision !== source.revision) throw codedError('DIARIZATION_TRANSCRIPT_SCOPE_MISMATCH');
    if (transcript?.document?.status !== 'ready') throw codedError('DIARIZATION_TRANSCRIPT_NOT_READY');
    if (!transcript?.currentRevision || !Array.isArray(transcript.currentRevision.segments) || !transcript.currentRevision.segments.length) throw codedError('DIARIZATION_TRANSCRIPT_SEGMENTS_REQUIRED');
    return { transcriptId: actualTranscriptId, transcript };
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

  function flattenProviderSegments(response) {
    if (!Array.isArray(response?.chunks) || !response.chunks.length) throw codedError('DIARIZATION_PROVIDER_CHUNKS_EMPTY');
    const chunks = [...response.chunks].sort((left, right) => Number(left.sequence) - Number(right.sequence));
    const providerSegments = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (Number(chunk.sequence) !== index) throw codedError('DIARIZATION_PROVIDER_CHUNK_OUT_OF_ORDER');
      const chunkStartMs = Number(chunk.startMs);
      const chunkEndMs = Number(chunk.endMs);
      if (!Number.isSafeInteger(chunkStartMs) || !Number.isSafeInteger(chunkEndMs) || chunkEndMs <= chunkStartMs) throw codedError('DIARIZATION_PROVIDER_CHUNK_TIMELINE_INVALID');
      for (const segment of Array.isArray(chunk.segments) ? chunk.segments : []) {
        const startMs = chunkStartMs + Number(segment.startMs);
        const endMs = chunkStartMs + Number(segment.endMs);
        if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs || endMs > chunkEndMs) throw codedError('DIARIZATION_PROVIDER_TIMESTAMP_INVALID');
        providerSegments.push({
          startMs,
          endMs,
          providerRole: segment.providerRole ?? null,
          confidence: segment.confidence ?? null
        });
      }
    }
    if (!providerSegments.length) throw codedError('DIARIZATION_PROVIDER_SEGMENTS_EMPTY');
    return providerSegments;
  }

  async function nextDiarizationRevision(transcriptId, meetingId) {
    if (typeof diarizationStore.getCurrentRevision !== 'function') return 1;
    try {
      const current = await diarizationStore.getCurrentRevision(context, { meetingId, transcriptId });
      return Number(current.revision.revision) + 1;
    } catch (error) {
      if (error?.code === 'DIARIZATION_NOT_FOUND') return 1;
      throw error;
    }
  }

  async function persistJob(job) {
    const result = await diarizationStore.saveJob(context, job);
    jobs.set(job.jobId, clone(result.job || job));
    notify();
    return jobs.get(job.jobId);
  }

  async function transition(job, nextStatus, errorCode = null) {
    const next = transitionDiarizationJob(job, nextStatus, { at: timestamp(now), errorCode });
    return persistJob(next);
  }

  async function recordDiarizationSummary({
    traceId,
    job,
    source,
    transcript,
    transcriptId,
    transcriptRevision,
    providerSegments,
    response,
    mappedRevision,
    requestedSpeakerCount
  }) {
    if (typeof speechGateway.recordDiagnostic !== 'function') return;
    const transcriptSegments = Array.isArray(transcript?.currentRevision?.segments)
      ? transcript.currentRevision.segments
      : [];
    const firstTranscriptSegment = transcriptSegments[0] || null;
    const lastTranscriptSegment = transcriptSegments.at(-1) || null;
    const providerRoles = [...new Set(providerSegments
      .map((segment) => Number(segment.providerRole))
      .filter((role) => Number.isSafeInteger(role) && role > 0))].sort((left, right) => left - right);
    const decodedDurationMs = Number(response?.effectiveDurationMs);
    const normalizedDecodedDurationMs = Number.isSafeInteger(decodedDurationMs) && decodedDurationMs >= 0 ? decodedDurationMs : null;
    const lastTranscriptEndMs = Number(lastTranscriptSegment?.endMs);
    const normalizedLastTranscriptEndMs = Number.isSafeInteger(lastTranscriptEndMs) ? lastTranscriptEndMs : null;
    const durationDeltaMs = normalizedDecodedDurationMs !== null && normalizedLastTranscriptEndMs !== null
      ? normalizedDecodedDurationMs - normalizedLastTranscriptEndMs
      : null;
    try {
      await speechGateway.recordDiagnostic({
        traceId,
        phase: 'diarization_result_summary',
        meetingId: source.meetingId,
        sourceId: source.sourceId,
        jobId: job.jobId,
        transcriptIdHash: await hashIdentifier(cryptoImpl, transcriptId),
        roleType: 1,
        roleNum: requestedSpeakerCount,
        providerSegmentCount: providerSegments.length,
        providerRoles,
        providerRoleCount: providerRoles.length,
        firstStBg: providerSegments[0]?.startMs ?? null,
        lastStEd: providerSegments.at(-1)?.endMs ?? null,
        diarizationRevisionIdHash: await hashIdentifier(cryptoImpl, mappedRevision.diarizationRevisionId),
        diarizationRevision: mappedRevision.revision,
        transcriptRevision,
        transcriptFirstStartMs: firstTranscriptSegment?.startMs ?? null,
        transcriptLastStartMs: lastTranscriptSegment?.startMs ?? null,
        transcriptLastEndMs: normalizedLastTranscriptEndMs,
        decodedDurationMs: normalizedDecodedDurationMs,
        durationDeltaMs,
        providerInvoked: true,
        revisionPersisted: true,
        encryptedPersistence: true,
        status: 'PASS'
      });
    } catch {
      // Diagnostics are best effort and must never change encrypted diarization state.
    }
  }

  async function finishFailure(job, error) {
    const code = error?.code || 'DIARIZATION_FAILED';
    const target = code === 'STAGE3B_REAL_DIARIZATION_PROVIDER_BLOCKED' ? 'blocked' : 'failed';
    if (!job || !activeStatus(job.status)) return job;
    return transition(job, target, code);
  }

  async function runJob(initialJob, source, transcript, { speakerCount: requestedSpeakerCount, traceId: inputTraceId = '' } = {}) {
    let job = initialJob;
    const controller = new AbortController();
    controllers.set(job.jobId, controller);
    try {
      if (job.status === 'queued') job = await transition(job, 'preparing');
      if (job.status === 'preparing') job = await transition(job, 'diarizing');
      if (controller.signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('DIARIZATION_CANCELLED');
      const description = speechGateway.describe?.() || {};
      if (description.diarizationAvailable !== true) throw codedError('STAGE3B_REAL_DIARIZATION_PROVIDER_BLOCKED');
      const traceId = String(inputTraceId || '').trim() || randomId(cryptoImpl, 'diarization-trace');
      const response = await speechGateway.transcribeSource({
        ownerId: context.ownerId,
        meetingId: source.meetingId,
        sourceId: source.sourceId,
        sourceRevision: source.revision,
        requestId: randomId(cryptoImpl, 'diarization-request'),
        traceId,
        attempt: Math.max(1, Number(job.attempts || 0) + 1),
        mode: 'diarization',
        speakerCount: requestedSpeakerCount,
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
        signal: controller.signal
      });
      if (controller.signal.aborted || cancelledJobs.has(job.jobId)) throw codedError('DIARIZATION_CANCELLED');
      job = await transition(job, 'stitching');
      const transcriptId = transcript.document?.transcriptId || transcript.currentRevision?.transcriptId;
      const diarizationRevision = await nextDiarizationRevision(transcriptId, source.meetingId);
      const providerSegments = flattenProviderSegments(response);
      const mapped = mapDiarizationToTranscript({
        ownerContext: context,
        transcriptRevision: transcript.currentRevision,
        providerSegments,
        diarizationRevision,
        source: 'provider_role_separation',
        now: timestamp(now)
      });
      const saved = await diarizationStore.saveRevision(context, mapped);
      await recordDiarizationSummary({
        traceId,
        job,
        source,
        transcript,
        transcriptId,
        transcriptRevision: transcript.document.transcriptRevision,
        providerSegments,
        response,
        mappedRevision: saved?.revision || mapped,
        requestedSpeakerCount
      });
      job = await transition(job, 'ready');
      return job;
    } catch (error) {
      if (error?.code === 'DIARIZATION_CANCELLED' || controller.signal.aborted || cancelledJobs.has(job.jobId)) return jobs.get(job.jobId) || job;
      return finishFailure(job, error);
    } finally {
      controllers.delete(job.jobId);
    }
  }

  function schedule(job, source, transcript, options) {
    if (runs.has(job.jobId)) return runs.get(job.jobId);
    const promise = Promise.resolve().then(() => runJob(job, source, transcript, options)).then((finalJob) => {
      jobs.set(finalJob.jobId, clone(finalJob));
      notify();
      return Object.freeze({ job: clone(finalJob) });
    }).catch(async (error) => {
      const current = jobs.get(job.jobId) || job;
      const finalJob = await finishFailure(current, error);
      jobs.set(finalJob.jobId, clone(finalJob));
      notify();
      return Object.freeze({ job: clone(finalJob), errorCode: finalJob.errorCode });
    }).finally(() => {
      runs.delete(job.jobId);
    });
    runs.set(job.jobId, promise);
    return promise;
  }

  async function findExistingJob(jobId) {
    if (jobs.has(jobId)) return jobs.get(jobId);
    if (typeof diarizationStore.getJob !== 'function') return null;
    try {
      const job = await diarizationStore.getJob(context, jobId);
      jobs.set(job.jobId, clone(job));
      return job;
    } catch (error) {
      if (error?.code === 'DIARIZATION_JOB_NOT_FOUND') return null;
      throw error;
    }
  }

  async function startDiarization({ sourceId, meetingId = '', transcriptId = '', speakerCount: inputSpeakerCount = 0, traceId = '' } = {}) {
    const normalizedSpeakerCount = speakerCount(inputSpeakerCount);
    const source = await resolveSource(sourceId, meetingId);
    const transcriptView = await loadTranscript(source, transcriptId);
    const jobId = sourceDiarizationJobId(source, transcriptView.transcript.document.transcriptRevision);
    let job = await findExistingJob(jobId);
    if (!job) {
      job = createDiarizationJob({
        jobId,
        ownerId: context.ownerId,
        meetingId: source.meetingId,
        sourceId: source.sourceId,
        transcriptId: transcriptView.transcriptId,
        transcriptRevision: transcriptView.transcript.document.transcriptRevision,
        speakerCount: normalizedSpeakerCount,
        createdAt: timestamp(now),
        updatedAt: timestamp(now)
      });
      await persistJob(job);
    } else {
      if (job.sourceId !== source.sourceId || job.transcriptId !== transcriptView.transcriptId || job.transcriptRevision !== transcriptView.transcript.document.transcriptRevision) throw codedError('DIARIZATION_JOB_SCOPE_MISMATCH');
      if (Number(job.speakerCount) !== normalizedSpeakerCount && activeStatus(job.status)) throw codedError('DIARIZATION_JOB_SPEAKER_COUNT_CONFLICT');
    }
    if (job.status === 'ready' || job.status === 'blocked' || job.status === 'failed' || job.status === 'cancelled') return Object.freeze({ job: clone(job), provider: speechGateway.describe?.() || null });
    schedule(job, source, transcriptView.transcript, { speakerCount: normalizedSpeakerCount, traceId });
    return Object.freeze({ job: clone(job), provider: speechGateway.describe?.() || null });
  }

  async function getDiarizationView({ meetingId, transcriptId } = {}) {
    const normalizedMeetingId = required(meetingId, 'DIARIZATION_MEETING_ID_REQUIRED');
    const normalizedTranscriptId = required(transcriptId, 'DIARIZATION_TRANSCRIPT_ID_REQUIRED');
    const transcript = await transcriptStore.getTranscript(context, { meetingId: normalizedMeetingId, transcriptId: normalizedTranscriptId });
    let revision = null;
    try {
      revision = (await diarizationStore.getCurrentRevision(context, { meetingId: normalizedMeetingId, transcriptId: normalizedTranscriptId, transcriptRevision: transcript.document.transcriptRevision })).revision;
    } catch (error) {
      if (error?.code !== 'DIARIZATION_NOT_FOUND') throw error;
    }
    return Object.freeze({ transcript, revision: revision ? clone(revision) : null });
  }

  async function cancelDiarization({ jobId } = {}) {
    const normalizedJobId = required(jobId, 'DIARIZATION_JOB_ID_REQUIRED');
    let job = await findExistingJob(normalizedJobId);
    if (!job) throw codedError('DIARIZATION_JOB_NOT_FOUND');
    cancelledJobs.add(job.jobId);
    controllers.get(job.jobId)?.abort();
    if (activeStatus(job.status)) job = await transition(job, 'cancelled', 'DIARIZATION_CANCELLED');
    return Object.freeze({ job: clone(job) });
  }

  async function waitForJob(jobId) {
    const normalizedJobId = required(jobId, 'DIARIZATION_JOB_ID_REQUIRED');
    if (runs.has(normalizedJobId)) return runs.get(normalizedJobId);
    const job = await findExistingJob(normalizedJobId);
    if (!job) throw codedError('DIARIZATION_JOB_NOT_FOUND');
    return Object.freeze({ job: clone(job) });
  }

  async function initialize() {
    jobs.clear();
    if (typeof diarizationStore.listJobs === 'function') {
      for (const job of await diarizationStore.listJobs(context)) {
        jobs.set(job.jobId, clone(job));
        if (!activeStatus(job.status)) continue;
        try {
          const source = await resolveSource(job.sourceId, job.meetingId);
          const transcriptView = await loadTranscript(source, job.transcriptId);
          schedule(job, source, transcriptView.transcript, { speakerCount: job.speakerCount });
        } catch (error) {
          if (!recoverableLookup(error)) throw error;
        }
      }
    }
    initialized = true;
    notify();
    return getSnapshot();
  }

  return Object.freeze({
    initialize,
    startDiarization,
    cancelDiarization,
    waitForJob,
    getDiarizationView,
    getSnapshot,
    describeProvider: () => speechGateway.describe?.() || Object.freeze({ available: false, diarizationAvailable: false, status: 'unknown' }),
    subscribe(listener) {
      if (typeof listener !== 'function') throw codedError('DIARIZATION_LISTENER_REQUIRED');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}

export { codedError };
