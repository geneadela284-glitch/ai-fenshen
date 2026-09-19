import { assertOwnerContext } from '../stage3a/transcriptContracts.js';
import {
  EVIDENCE_REF_STATUS_INVALID,
  EVIDENCE_REF_STATUS_STALE
} from './meetingEvidenceRefContracts.js';
import { resolveEvidenceRef } from './meetingEvidenceRefResolver.js';

export const GROUNDING_SUPPORTED = 'GROUNDING_SUPPORTED';
export const GROUNDING_UNRESOLVED = 'GROUNDING_UNRESOLVED';
export const GROUNDING_REJECTED = 'GROUNDING_REJECTED';
export const GROUNDING_STATUSES = Object.freeze([
  GROUNDING_SUPPORTED,
  GROUNDING_UNRESOLVED,
  GROUNDING_REJECTED
]);

const UNRESOLVED_FIELDS = new Set(['owner', 'ownerRef', 'dueDate', 'date', 'time', 'amount', 'quantity', 'speakerId', 'resolvedSpeakerName', 'decision', 'commitment', 'status']);

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

function normalizeField(field, raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw.value;
    if (String(value ?? '').trim().toLowerCase() === 'unresolved') {
      return {
        resolved: false,
        value: 'unresolved',
        reason: String(raw.unresolvedReason || 'UNRESOLVED').trim() || 'UNRESOLVED',
        field
      };
    }
    return { resolved: true, value, field };
  }
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { resolved: false, value: 'unresolved', reason: 'NOT_STATED', field };
  }
  if (String(raw).trim().toLowerCase() === 'unresolved') {
    return { resolved: false, value: 'unresolved', reason: 'UNRESOLVED', field };
  }
  return { resolved: true, value: raw, field };
}

function evidenceText(resolvedEvidence) {
  return resolvedEvidence
    .filter((item) => item.status === 'VALID')
    .map((item) => item.evidenceRef?.textSpan?.quote || '')
    .join('\n');
}

function candidateResult(candidate, status, extra = {}) {
  return {
    status,
    candidate: clone(candidate),
    ...extra
  };
}

function unresolved(candidate, unresolvedReasons, evidenceRefs = []) {
  return candidateResult(candidate, GROUNDING_UNRESOLVED, {
    evidenceRefs: clone(evidenceRefs),
    unresolvedReasons: clone(unresolvedReasons),
    rejectionReasons: []
  });
}

function rejected(candidate, rejectionReasons, evidenceRefs = []) {
  return candidateResult(candidate, GROUNDING_REJECTED, {
    evidenceRefs: clone(evidenceRefs),
    unresolvedReasons: [],
    rejectionReasons: clone(rejectionReasons)
  });
}

export function groundCandidate({
  ownerContext: inputOwnerContext,
  source,
  transcriptRevision,
  candidate,
  allowParaphrase = false,
  currentDiarizationRevision,
  currentSpeakerCorrectionRevision
} = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw codedError('GROUNDING_CANDIDATE_INVALID');
  }
  const content = String(candidate.content || '').trim();
  if (!content) return rejected(candidate, [{ code: 'CLAIM_CONTENT_REQUIRED' }]);
  const refs = Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : [];
  if (refs.length === 0) return unresolved(candidate, [{ code: 'EVIDENCE_REQUIRED', reason: 'NOT_STATED' }]);

  const resolved = [];
  const staleReasons = [];
  const rejectionReasons = [];
  const seen = new Set();
  for (const evidenceRef of refs) {
    const id = evidenceRef?.evidenceRefId;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    const result = resolveEvidenceRef({
      ownerContext,
      evidenceRef,
      source,
      currentTranscriptRevision: transcriptRevision,
      currentDiarizationRevision,
      currentSpeakerCorrectionRevision
    });
    if (result.status === EVIDENCE_REF_STATUS_INVALID) {
      rejectionReasons.push({ code: 'EVIDENCE_INVALID', reason: result.reason, evidenceRefId: id || null });
    } else if (result.status === EVIDENCE_REF_STATUS_STALE) {
      staleReasons.push({ code: 'REVISION_MISMATCH', reason: result.reason, evidenceRefId: id || null });
    } else {
      resolved.push(result);
    }
  }
  if (rejectionReasons.length) return rejected(candidate, rejectionReasons, resolved.map((item) => item.evidenceRef));
  if (staleReasons.length || resolved.length === 0) {
    return unresolved(candidate, staleReasons.length ? staleReasons : [{ code: 'EVIDENCE_REQUIRED', reason: 'NOT_STATED' }], resolved.map((item) => item.evidenceRef));
  }

  if (candidate.certainty === 'tentative' || candidate.status === 'unresolved') {
    return unresolved(candidate, [{ code: candidate.certainty === 'tentative' ? 'TENTATIVE_LANGUAGE' : 'UNRESOLVED_STATUS', reason: 'AMBIGUOUS' }], resolved.map((item) => item.evidenceRef));
  }

  const text = evidenceText(resolved);
  if (!text.includes(content) && allowParaphrase !== true) {
    return rejected(candidate, [{ code: 'CLAIM_NOT_SUPPORTED', claim: content }], resolved.map((item) => item.evidenceRef));
  }

  const unresolvedReasons = [];
  const fields = candidate.fields && typeof candidate.fields === 'object' && !Array.isArray(candidate.fields) ? candidate.fields : {};
  for (const [field, raw] of Object.entries(fields)) {
    const normalized = normalizeField(field, raw);
    if (!normalized.resolved) {
      unresolvedReasons.push({
        field,
        code: normalized.reason,
        value: 'unresolved'
      });
      continue;
    }
    if (UNRESOLVED_FIELDS.has(field) && !text.includes(String(normalized.value))) {
      return rejected(candidate, [{ code: 'FIELD_NOT_SUPPORTED', field, value: normalized.value }], resolved.map((item) => item.evidenceRef));
    }
  }
  if (unresolvedReasons.length) return unresolved(candidate, unresolvedReasons, resolved.map((item) => item.evidenceRef));

  return candidateResult(candidate, GROUNDING_SUPPORTED, {
    evidenceRefs: resolved.map((item) => item.evidenceRef),
    resolvedEvidence: resolved.map((item) => ({
      evidenceRefId: item.evidenceRef.evidenceRefId,
      transcriptLocator: item.transcriptLocator,
      playbackLocator: item.playbackLocator
    })),
    unresolvedReasons: [],
    rejectionReasons: []
  });
}

export function groundClaim(input = {}) {
  return groundCandidate(input);
}

export function validateGroundedClaim(input = {}) {
  return groundCandidate(input);
}

export { required };
