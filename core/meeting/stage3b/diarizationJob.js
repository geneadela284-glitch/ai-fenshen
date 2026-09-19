export const DIARIZATION_JOB_SCHEMA_VERSION = 1;
export const DIARIZATION_JOB_STATUSES = Object.freeze([
  'queued', 'preparing', 'diarizing', 'stitching', 'ready', 'failed', 'blocked', 'cancelled'
]);

const TRANSITIONS = Object.freeze({
  queued: ['preparing', 'blocked', 'cancelled'],
  preparing: ['diarizing', 'failed', 'blocked', 'cancelled'],
  diarizing: ['stitching', 'failed', 'blocked', 'cancelled'],
  stitching: ['ready', 'failed', 'blocked', 'cancelled'],
  failed: ['preparing', 'blocked', 'cancelled'],
  ready: [],
  blocked: [],
  cancelled: []
});

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

function positiveInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw codedError(code);
  return normalized;
}

function speakerCount(value) {
  const normalized = Number(value ?? 0);
  if (!(normalized === 0 || [2, 3, 4].includes(normalized))) throw codedError('DIARIZATION_SPEAKER_COUNT_INVALID');
  return normalized;
}

function timestamp(value, code) {
  const normalized = new Date(value || new Date()).toISOString();
  if (Number.isNaN(Date.parse(normalized))) throw codedError(code);
  return normalized;
}

export function createDiarizationJob({
  jobId,
  ownerId,
  meetingId,
  sourceId,
  transcriptId,
  transcriptRevision,
  speakerCount: inputSpeakerCount = 0,
  createdAt,
  updatedAt,
  revision = 1
} = {}) {
  const created = timestamp(createdAt, 'DIARIZATION_JOB_CREATED_AT_INVALID');
  return Object.freeze({
    schemaVersion: DIARIZATION_JOB_SCHEMA_VERSION,
    jobId: required(jobId, 'DIARIZATION_JOB_ID_REQUIRED'),
    ownerId: required(ownerId, 'OWNER_REQUIRED'),
    meetingId: required(meetingId, 'DIARIZATION_MEETING_ID_REQUIRED'),
    sourceId: required(sourceId, 'DIARIZATION_SOURCE_ID_REQUIRED'),
    transcriptId: required(transcriptId, 'DIARIZATION_TRANSCRIPT_ID_REQUIRED'),
    transcriptRevision: positiveInteger(transcriptRevision, 'DIARIZATION_TRANSCRIPT_REVISION_INVALID'),
    mode: 'diarization',
    speakerCount: speakerCount(inputSpeakerCount),
    status: 'queued',
    createdAt: created,
    updatedAt: timestamp(updatedAt || created, 'DIARIZATION_JOB_UPDATED_AT_INVALID'),
    revision: positiveInteger(revision, 'DIARIZATION_JOB_REVISION_INVALID'),
    attempts: 0,
    errorCode: null
  });
}

export function transitionDiarizationJob(job, nextStatus, { at, errorCode = null } = {}) {
  if (!job || typeof job !== 'object' || !DIARIZATION_JOB_STATUSES.includes(job.status)) throw codedError('DIARIZATION_JOB_INVALID');
  const next = required(nextStatus, 'DIARIZATION_JOB_STATUS_REQUIRED');
  if (!DIARIZATION_JOB_STATUSES.includes(next) || !TRANSITIONS[job.status]?.includes(next)) throw codedError('DIARIZATION_JOB_TRANSITION_INVALID');
  return Object.freeze({
    ...job,
    status: next,
    updatedAt: timestamp(at, 'DIARIZATION_JOB_UPDATED_AT_INVALID'),
    revision: positiveInteger(job.revision, 'DIARIZATION_JOB_REVISION_INVALID') + 1,
    errorCode: errorCode ? String(errorCode) : (next === 'failed' || next === 'blocked' ? job.errorCode : null)
  });
}

export function canTransitionDiarizationJob(fromStatus, toStatus) {
  return Boolean(TRANSITIONS[fromStatus]?.includes(toStatus));
}
