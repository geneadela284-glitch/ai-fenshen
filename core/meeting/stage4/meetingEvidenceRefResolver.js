import {
  validateEvidenceRef,
  evidenceTextHash,
  EVIDENCE_REF_STATUS_INVALID,
  EVIDENCE_REF_STATUS_STALE,
  EVIDENCE_REF_STATUS_VALID
} from './meetingEvidenceRefContracts.js';
import { assertCommittedAudioSource, assertOwnerContext, validateTranscriptSegment } from '../stage3a/transcriptContracts.js';

function codedError(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function assertOwnerBinding(ownerContext, evidenceRef) {
  if (!evidenceRef || typeof evidenceRef !== 'object') throw codedError('EVIDENCE_REF_INVALID');
  if (evidenceRef.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  if (evidenceRef.scope !== 'meeting') throw codedError('EVIDENCE_SCOPE_MISMATCH');
}

function locator(evidenceRef) {
  return {
    meetingId: evidenceRef.meetingId,
    sourceId: evidenceRef.sourceId,
    sourceRevision: evidenceRef.sourceRevision,
    transcriptId: evidenceRef.transcriptId,
    transcriptRevision: evidenceRef.transcriptRevision,
    segmentId: evidenceRef.segmentId,
    startMs: evidenceRef.startMs,
    endMs: evidenceRef.endMs,
    textSpan: clone(evidenceRef.textSpan)
  };
}

function playbackLocator(evidenceRef) {
  return {
    meetingId: evidenceRef.meetingId,
    sourceId: evidenceRef.sourceId,
    sourceRevision: evidenceRef.sourceRevision,
    startMs: evidenceRef.startMs,
    endMs: evidenceRef.endMs
  };
}

function result(status, reason, evidenceRef, extra = {}) {
  return {
    status,
    reason,
    evidenceRef: clone(evidenceRef),
    ...extra
  };
}

function currentSegment(currentTranscriptRevision, evidenceRef) {
  return currentTranscriptRevision?.segments?.find((segment) => segment.segmentId === evidenceRef.segmentId) || null;
}

function assertCurrentTranscriptShape(ownerContext, currentTranscriptRevision, evidenceRef) {
  if (!currentTranscriptRevision || typeof currentTranscriptRevision !== 'object') {
    throw codedError('CURRENT_TRANSCRIPT_REVISION_REQUIRED');
  }
  if (currentTranscriptRevision.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
  if (currentTranscriptRevision.scope !== 'meeting') throw codedError('TRANSCRIPT_SCOPE_MISMATCH');
  if (currentTranscriptRevision.meetingId !== evidenceRef.meetingId) throw codedError('MEETING_SCOPE_MISMATCH');
  if (currentTranscriptRevision.sourceId !== evidenceRef.sourceId) throw codedError('SOURCE_SCOPE_MISMATCH');
  if (currentTranscriptRevision.transcriptId !== evidenceRef.transcriptId) throw codedError('TRANSCRIPT_ID_MISMATCH');
  if (!Array.isArray(currentTranscriptRevision.segments)) throw codedError('TRANSCRIPT_SEGMENTS_REQUIRED');
  for (const [index, segment] of currentTranscriptRevision.segments.entries()) {
    const check = validateTranscriptSegment(segment, {
      transcriptId: currentTranscriptRevision.transcriptId,
      revision: currentTranscriptRevision.transcriptRevision,
      previousEndMs: index === 0 ? null : currentTranscriptRevision.segments[index - 1].endMs
    });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
  }
}

function staleResult(reason, evidenceRef) {
  return result(EVIDENCE_REF_STATUS_STALE, reason, evidenceRef, {
    transcriptLocator: locator(evidenceRef),
    playbackLocator: playbackLocator(evidenceRef)
  });
}

export function resolveEvidenceRef({
  ownerContext: inputOwnerContext,
  evidenceRef,
  source,
  currentTranscriptRevision,
  currentDiarizationRevision,
  currentSpeakerCorrectionRevision
} = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  assertOwnerBinding(ownerContext, evidenceRef);

  if (source) {
    const committed = assertCommittedAudioSource({ ownerContext, source, expectedScope: 'meeting' });
    if (committed.ownerId !== ownerContext.ownerId) throw codedError('OWNER_SCOPE_MISMATCH');
    if (committed.meetingId !== evidenceRef.meetingId) throw codedError('MEETING_SCOPE_MISMATCH');
    if (committed.sourceId !== evidenceRef.sourceId) throw codedError('SOURCE_SCOPE_MISMATCH');
    if (Number(committed.revision) !== Number(evidenceRef.sourceRevision)) {
      return staleResult('SOURCE_REVISION_MISMATCH', evidenceRef);
    }
    if (!Number.isSafeInteger(Number(committed.durationMs)) || evidenceRef.endMs > Number(committed.durationMs)) {
      return result(EVIDENCE_REF_STATUS_INVALID, 'AUDIO_DURATION_MISMATCH', evidenceRef);
    }
  } else {
    return result(EVIDENCE_REF_STATUS_INVALID, 'SOURCE_REQUIRED', evidenceRef);
  }

  assertCurrentTranscriptShape(ownerContext, currentTranscriptRevision, evidenceRef);
  const segment = currentSegment(currentTranscriptRevision, evidenceRef);
  if (!segment) return result(EVIDENCE_REF_STATUS_INVALID, 'SEGMENT_DELETED', evidenceRef);

  if (Number(currentTranscriptRevision.transcriptRevision) !== Number(evidenceRef.transcriptRevision)) {
    const sameText = typeof segment.text === 'string' && evidenceTextHash(segment.text) === evidenceRef.textHash;
    return staleResult(sameText ? 'TRANSCRIPT_REVISION_NOT_CURRENT' : 'TRANSCRIPT_TEXT_CHANGED', evidenceRef);
  }

  const check = validateEvidenceRef(evidenceRef, {
    ownerContext,
    source,
    transcriptRevision: currentTranscriptRevision,
    diarizationRevision: currentDiarizationRevision,
    speakerCorrectionRevision: currentSpeakerCorrectionRevision
  });
  if (!check.valid) {
    return result(EVIDENCE_REF_STATUS_INVALID, check.errors[0], evidenceRef, { errors: check.errors });
  }

  if (evidenceRef.diarizationRevisionId) {
    if (!currentDiarizationRevision ||
        currentDiarizationRevision.diarizationRevisionId !== evidenceRef.diarizationRevisionId ||
        Number(currentDiarizationRevision.revision) !== Number(evidenceRef.diarizationRevision)) {
      return staleResult('DIARIZATION_REVISION_MISMATCH', evidenceRef);
    }
  }
  if (evidenceRef.speakerCorrectionRevisionId) {
    if (!currentSpeakerCorrectionRevision ||
        currentSpeakerCorrectionRevision.correctionRevisionId !== evidenceRef.speakerCorrectionRevisionId ||
        Number(currentSpeakerCorrectionRevision.correctionRevision) !== Number(evidenceRef.speakerCorrectionRevision)) {
      return staleResult('SPEAKER_CORRECTION_REVISION_MISMATCH', evidenceRef);
    }
  }

  return {
    status: EVIDENCE_REF_STATUS_VALID,
    reason: null,
    evidenceRef: clone(evidenceRef),
    transcriptSegment: {
      segmentId: segment.segmentId,
      transcriptId: segment.transcriptId,
      transcriptRevision: segment.transcriptRevision,
      startMs: segment.startMs,
      endMs: segment.endMs,
      text: segment.text
    },
    transcriptLocator: locator(evidenceRef),
    playbackLocator: playbackLocator(evidenceRef)
  };
}

export function resolveMeetingEvidenceRef(input = {}) {
  return resolveEvidenceRef(input);
}

export function createEvidenceRefResolver(options = {}) {
  return Object.freeze({
    resolve(input = {}) {
      return resolveEvidenceRef({ ...options, ...input });
    }
  });
}
