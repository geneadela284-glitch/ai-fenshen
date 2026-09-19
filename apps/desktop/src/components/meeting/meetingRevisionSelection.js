function numericRevision(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isNewerCandidate(candidate, existing, revisionField) {
  if (!existing) return true;
  const candidateRevision = numericRevision(candidate?.[revisionField]);
  const existingRevision = numericRevision(existing?.[revisionField]);
  if (candidateRevision !== existingRevision) {
    return (candidateRevision ?? -1) > (existingRevision ?? -1);
  }
  return String(candidate?.updatedAt || '') > String(existing?.updatedAt || '');
}

function latestBySource(items, revisionField) {
  const selected = new Map();
  for (const item of items) {
    const current = selected.get(item.sourceId);
    if (isNewerCandidate(item, current, revisionField)) selected.set(item.sourceId, item);
  }
  return [...selected.values()];
}

export function selectCurrentTranscriptionJobs({ jobs = [], meetingId, activeSources = [], transcriptOnlyJobIds = [] } = {}) {
  const transcriptOnlyIds = new Set(transcriptOnlyJobIds);
  const currentSourceRevisions = new Map((activeSources || []).map((source) => [source.sourceId, numericRevision(source.revision)]));
  const eligible = (jobs || [])
    .filter((job) => job?.meetingId === meetingId && (job.status === 'ready' || transcriptOnlyIds.has(job.jobId)))
    .filter((job) => {
      const currentRevision = currentSourceRevisions.get(job.sourceId);
      if (currentRevision == null) return true;
      return numericRevision(job.sourceRevision) === currentRevision;
    });
  return latestBySource(eligible, 'sourceRevision');
}

export function selectCurrentDiarizationJobs({ jobs = [], meetingId, currentTranscripts = {} } = {}) {
  const currentTranscriptIds = new Map(
    Object.entries(currentTranscripts || {}).map(([sourceId, view]) => [sourceId, view?.transcript?.document?.transcriptId])
  );
  const eligible = (jobs || [])
    .filter((job) => job?.meetingId === meetingId && job.status === 'ready')
    .filter((job) => {
      const currentTranscriptId = currentTranscriptIds.get(job.sourceId);
      return !currentTranscriptId || job.transcriptId === currentTranscriptId;
    });
  return latestBySource(eligible, 'transcriptRevision');
}
