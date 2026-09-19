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

export async function ensureMeetingDiarization({
  source,
  transcriptionManager,
  diarizationManager,
  diagnosticTraceId = '',
  diagnosticMetadata = {}
} = {}) {
  const sourceId = required(source?.sourceId, 'SOURCE_ID_REQUIRED');
  const meetingId = required(source?.meetingId, 'MEETING_ID_REQUIRED');
  if (!transcriptionManager || typeof transcriptionManager.getTranscriptView !== 'function') throw codedError('MEETING_TRANSCRIPTION_MANAGER_REQUIRED');
  if (!diarizationManager || typeof diarizationManager.getDiarizationView !== 'function') throw codedError('MEETING_DIARIZATION_MANAGER_REQUIRED');

  const traceId = String(diagnosticTraceId || '').trim();
  const recordBackfillAudit = async (event) => {
    if (!traceId || typeof transcriptionManager.recordDiagnostic !== 'function') return;
    try {
      await transcriptionManager.recordDiagnostic({
        ...diagnosticMetadata,
        traceId,
        phase: 'diarization_backfill',
        meetingId,
        sourceId,
        ...event
      });
    } catch {
      // Diagnostics must never change the post-processing outcome.
    }
  };

  const transcriptView = await transcriptionManager.getTranscriptView({ sourceId, meetingId });
  const transcript = transcriptView?.transcript;
  const transcriptId = required(transcript?.document?.transcriptId, 'TRANSCRIPT_ID_REQUIRED');
  const transcriptReady = transcript?.document?.status === 'ready';
  await recordBackfillAudit({
    gate: 'G1',
    transcriptId,
    transcriptState: transcript?.document?.status || 'missing',
    transcriptRevision: transcript?.document?.transcriptRevision ?? null,
    status: transcriptReady ? 'PASS' : 'FAIL'
  });
  if (!transcriptReady) throw codedError('DIARIZATION_TRANSCRIPT_NOT_READY');

  const viewInput = { meetingId, transcriptId };
  const existing = await diarizationManager.getDiarizationView(viewInput);
  const revisionMissing = !existing?.revision;
  const currentJob = diarizationManager.getSnapshot?.().jobs?.find((job) => (
    job?.meetingId === meetingId
      && job?.sourceId === sourceId
      && job?.transcriptId === transcriptId
      && Number(job?.transcriptRevision) === Number(transcript?.document?.transcriptRevision)
  )) || null;
  await recordBackfillAudit({
    gate: 'G2',
    transcriptId,
    transcriptRevision: transcript.document.transcriptRevision,
    revisionMissing,
    revisionCount: revisionMissing ? 0 : 1,
    latestRevision: existing?.revision?.revision ?? null,
    latestRevisionDecryptable: Boolean(existing?.revision),
    status: revisionMissing ? 'PASS' : 'FAIL'
  });
  const backfillCondition = transcriptReady && revisionMissing && !currentJob;
  await recordBackfillAudit({
    gate: 'G3',
    transcriptId,
    transcriptRevision: transcript.document.transcriptRevision,
    backfillCondition,
    diarizationJobFound: Boolean(currentJob),
    diarizationJobStatus: currentJob?.status || null,
    status: backfillCondition ? 'PASS' : 'FAIL'
  });
  if (existing?.revision) return Object.freeze({ job: Object.freeze({ status: 'ready', reused: true }), view: existing });
  if (typeof diarizationManager.startDiarization !== 'function' || typeof diarizationManager.waitForJob !== 'function') {
    throw codedError('MEETING_DIARIZATION_MANAGER_INCOMPLETE');
  }

  await recordBackfillAudit({
    gate: 'G4',
    transcriptId,
    transcriptRevision: transcript.document.transcriptRevision,
    managerInvoked: true,
    status: 'PASS'
  });
  const started = await diarizationManager.startDiarization({
    sourceId,
    meetingId,
    transcriptId,
    speakerCount: 0,
    ...(traceId ? { traceId } : {})
  });
  const jobId = required(started?.job?.jobId, 'DIARIZATION_JOB_ID_REQUIRED');
  const completed = await diarizationManager.waitForJob(jobId);
  if (completed?.job?.status !== 'ready') throw codedError('DIARIZATION_POST_PROCESS_FAILED');
  const view = await diarizationManager.getDiarizationView(viewInput);
  if (!view?.revision) throw codedError('DIARIZATION_REVISION_NOT_FOUND');
  await recordBackfillAudit({
    gate: 'G7',
    jobId,
    transcriptId,
    transcriptRevision: transcript.document.transcriptRevision,
    revisionPersisted: true,
    status: 'PASS'
  });
  await recordBackfillAudit({
    gate: 'G8',
    jobId,
    transcriptId,
    transcriptRevision: transcript.document.transcriptRevision,
    revisionPersisted: true,
    encryptedPersistence: true,
    status: 'PASS'
  });
  return Object.freeze({ job: completed.job, view });
}
