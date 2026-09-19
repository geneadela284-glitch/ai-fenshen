import { assertOwnerContext } from '../stage3a/transcriptContracts.js';
import {
  createDiarizationRevision,
  createDiarizationSegment,
  createSpeakerRef
} from './diarizationContracts.js';

const MIN_COVERAGE_RATIO = 0.8;
const MIN_WINNER_RATIO = 0.75;

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

function integer(value, code, { positive = false } = {}) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < (positive ? 1 : 0)) throw codedError(code);
  return normalized;
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function normalizeRole(value) {
  if (value === undefined || value === null || value === '' || value === 'unknown') return null;
  return integer(value, 'DIARIZATION_PROVIDER_ROLE_INVALID', { positive: true });
}

function normalizeProviderSegments(providerSegments) {
  if (!Array.isArray(providerSegments) || !providerSegments.length) throw codedError('DIARIZATION_PROVIDER_SEGMENTS_REQUIRED');
  let previousEndMs = 0;
  return providerSegments.map((value) => {
    const startMs = integer(value?.startMs, 'DIARIZATION_PROVIDER_START_INVALID');
    const endMs = integer(value?.endMs, 'DIARIZATION_PROVIDER_END_INVALID');
    if (endMs <= startMs || startMs < previousEndMs) throw codedError('DIARIZATION_PROVIDER_TIMELINE_INVALID');
    previousEndMs = endMs;
    const role = normalizeRole(value?.providerRole ?? value?.role ?? value?.speakerRole);
    const rawConfidence = value?.confidence;
    const confidence = rawConfidence === null || rawConfidence === undefined ? null : Number(rawConfidence);
    if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw codedError('DIARIZATION_CONFIDENCE_INVALID');
    return { startMs, endMs, role, confidence };
  });
}

function normalizeTranscript(transcriptRevision, ownerContext) {
  if (!transcriptRevision || typeof transcriptRevision !== 'object') throw codedError('DIARIZATION_TRANSCRIPT_REQUIRED');
  if (transcriptRevision.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  const transcriptId = required(transcriptRevision.transcriptId, 'DIARIZATION_TRANSCRIPT_ID_REQUIRED');
  const meetingId = required(transcriptRevision.meetingId, 'DIARIZATION_MEETING_ID_REQUIRED');
  const revision = integer(transcriptRevision.transcriptRevision, 'DIARIZATION_TRANSCRIPT_REVISION_INVALID', { positive: true });
  if (!Array.isArray(transcriptRevision.segments) || !transcriptRevision.segments.length) throw codedError('DIARIZATION_TRANSCRIPT_SEGMENTS_REQUIRED');
  let previousEndMs = 0;
  const segments = transcriptRevision.segments.map((segment, sequence) => {
    if (segment?.transcriptId !== transcriptId || Number(segment?.transcriptRevision) !== revision) throw codedError('DIARIZATION_TRANSCRIPT_SCOPE_MISMATCH');
    if (Number(segment?.sequence) !== sequence) throw codedError('DIARIZATION_TRANSCRIPT_SEQUENCE_INVALID');
    const startMs = integer(segment?.startMs, 'DIARIZATION_TRANSCRIPT_START_INVALID');
    const endMs = integer(segment?.endMs, 'DIARIZATION_TRANSCRIPT_END_INVALID');
    if (endMs <= startMs || startMs < previousEndMs) throw codedError('DIARIZATION_TRANSCRIPT_TIMELINE_INVALID');
    previousEndMs = endMs;
    return {
      transcriptSegmentId: required(segment.segmentId, 'DIARIZATION_TRANSCRIPT_SEGMENT_ID_REQUIRED'),
      startMs,
      endMs
    };
  });
  return { transcriptId, meetingId, transcriptRevision: revision, segments };
}

function overlap(left, right) {
  return Math.max(0, Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs));
}

function confidenceForRole(providerSegments, role, target) {
  const values = providerSegments
    .map((segment) => ({ segment, duration: overlap(segment, target) }))
    .filter(({ segment, duration }) => segment.role === role && duration > 0 && segment.confidence !== null);
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value.duration, 0);
  return values.reduce((sum, value) => sum + value.segment.confidence * value.duration, 0) / total;
}

function roleAssignment(providerSegments, transcriptSegment) {
  const coverage = new Map();
  for (const providerSegment of providerSegments) {
    if (providerSegment.role === null) continue;
    const duration = overlap(providerSegment, transcriptSegment);
    if (duration > 0) coverage.set(providerSegment.role, (coverage.get(providerSegment.role) || 0) + duration);
  }
  const ranked = [...coverage.entries()].sort((left, right) => right[1] - left[1]);
  if (!ranked.length) return { role: null, confidence: null };
  const duration = transcriptSegment.endMs - transcriptSegment.startMs;
  const covered = ranked.reduce((sum, [, value]) => sum + value, 0);
  const winner = ranked[0][1];
  const runnerUp = ranked[1]?.[1] || 0;
  if (covered / duration < MIN_COVERAGE_RATIO || winner / covered < MIN_WINNER_RATIO || winner === runnerUp) {
    return { role: null, confidence: null };
  }
  return {
    role: ranked[0][0],
    confidence: confidenceForRole(providerSegments, ranked[0][0], transcriptSegment)
  };
}

export function mapDiarizationToTranscript({
  ownerContext: inputOwnerContext,
  transcriptRevision,
  providerSegments,
  diarizationRevision = 1,
  diarizationRevisionId,
  source = 'provider_role_separation',
  now
} = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  const transcript = normalizeTranscript(transcriptRevision, ownerContext);
  const normalizedProviderSegments = normalizeProviderSegments(providerSegments);
  const roleToSpeaker = new Map();
  for (const providerSegment of normalizedProviderSegments) {
    if (providerSegment.role === null || roleToSpeaker.has(providerSegment.role)) continue;
    roleToSpeaker.set(providerSegment.role, `speaker-${roleToSpeaker.size + 1}`);
  }
  const speakerRefs = [...roleToSpeaker.entries()].map(([role, speakerId]) => createSpeakerRef({
    ownerContext,
    meetingId: transcript.meetingId,
    speakerId,
    source,
    createdAt: now,
    updatedAt: now,
    revision: diarizationRevision
  }));
  const segments = transcript.segments.map((transcriptSegment) => {
    const assignment = roleAssignment(normalizedProviderSegments, transcriptSegment);
    const speakerRef = assignment.role === null ? 'unknown' : roleToSpeaker.get(assignment.role);
    return createDiarizationSegment({
      meetingId: transcript.meetingId,
      transcriptId: transcript.transcriptId,
      transcriptRevision: transcript.transcriptRevision,
      transcriptSegmentId: transcriptSegment.transcriptSegmentId,
      startMs: transcriptSegment.startMs,
      endMs: transcriptSegment.endMs,
      speakerRef,
      confidence: assignment.confidence,
      source: speakerRef === 'unknown' ? 'unknown' : source,
      revision: diarizationRevision
    });
  });
  const revision = createDiarizationRevision({
    ownerContext,
    diarizationRevisionId: diarizationRevisionId || `diarization-${transcript.transcriptId}-${transcript.transcriptRevision}-${diarizationRevision}`,
    meetingId: transcript.meetingId,
    transcriptId: transcript.transcriptId,
    transcriptRevision: transcript.transcriptRevision,
    source,
    status: 'ready',
    speakerRefs,
    segments,
    createdAt: now,
    updatedAt: now,
    revision: diarizationRevision
  });
  return Object.freeze({
    ...clone(revision),
    providerRoleMap: Object.freeze(Object.fromEntries([...roleToSpeaker.entries()].map(([role, speakerId]) => [String(role), speakerId])))
  });
}

export const DIARIZATION_MAPPING_RULES = Object.freeze({
  minCoverageRatio: MIN_COVERAGE_RATIO,
  minWinnerRatio: MIN_WINNER_RATIO
});
