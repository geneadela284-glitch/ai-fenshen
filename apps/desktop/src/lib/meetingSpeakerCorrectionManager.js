import {
  assertOwnerContext,
  validateTranscriptDocument,
  validateTranscriptSegment
} from '../../../../core/meeting/stage3a/transcriptContracts.js';
import {
  anonymousSpeakerLabel,
  validateDiarizationRevision
} from '../../../../core/meeting/stage3b/diarizationContracts.js';
import {
  createBaseSpeakerCorrectionSnapshot,
  validateSpeakerCorrectionRevision
} from '../../../../core/meeting/stage3b/speakerCorrectionContracts.js';
import { applySpeakerCorrection as applyCoreSpeakerCorrection } from '../../../../core/meeting/stage3b/speakerCorrectionOperations.js';

const CANONICAL_MEETING_SPACE = 'meeting-space';
const SNAPSHOT_HASH_DOMAIN = 'meeting-speaker-correction-diarization-snapshot-v1';
const TRANSCRIPT_SNAPSHOT_HASH_DOMAIN = 'meeting-speaker-correction-transcript-snapshot-v1';
const PROJECTION_READ_KEYS = Object.freeze(['meetingId', 'transcriptId', 'correctionRevision']);
const HISTORY_READ_KEYS = Object.freeze(['meetingId', 'transcriptId']);
const MUTATION_COMMON_KEYS = Object.freeze([
  'meetingId',
  'transcriptId',
  'expectedTranscriptRevision',
  'baseDiarizationRevisionId',
  'expectedCorrectionRevision',
  'mutationRequestId'
]);
const RENAME_KEYS = Object.freeze([...MUTATION_COMMON_KEYS, 'speakerId', 'displayLabel']);
const MERGE_KEYS = Object.freeze([...MUTATION_COMMON_KEYS, 'speakerIds', 'targetSpeakerId']);
const SPLIT_KEYS = Object.freeze([...MUTATION_COMMON_KEYS, 'speakerId', 'transcriptSegmentIds']);
const REASSIGN_KEYS = Object.freeze([...MUTATION_COMMON_KEYS, 'transcriptSegmentIds', 'targetSpeakerId']);
const DIARIZATION_KEYS = Object.freeze([
  'schemaVersion',
  'diarizationRevisionId',
  'ownerId',
  'meetingId',
  'transcriptId',
  'transcriptRevision',
  'source',
  'status',
  'speakerRefs',
  'segments',
  'createdAt',
  'updatedAt',
  'revision'
]);
const MAPPED_DIARIZATION_KEYS = Object.freeze([...DIARIZATION_KEYS, 'providerRoleMap']);
const DIARIZATION_DOCUMENT_KEYS = Object.freeze([
  'schemaVersion',
  'documentId',
  'ownerId',
  'meetingId',
  'transcriptId',
  'transcriptRevision',
  'currentDiarizationRevisionId',
  'currentRevision',
  'updatedAt'
]);
const DIARIZATION_SPEAKER_KEYS = Object.freeze([
  'schemaVersion',
  'speakerId',
  'ownerId',
  'meetingId',
  'label',
  'source',
  'createdAt',
  'updatedAt',
  'revision'
]);
const DIARIZATION_SEGMENT_KEYS = Object.freeze([
  'schemaVersion',
  'meetingId',
  'transcriptId',
  'transcriptRevision',
  'transcriptSegmentId',
  'startMs',
  'endMs',
  'speakerRef',
  'confidence',
  'source',
  'revision'
]);
const TRANSCRIPT_DOCUMENT_SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'transcriptId',
  'meetingId',
  'sourceId',
  'ownerId',
  'scope',
  'sourceRevision',
  'transcriptRevision',
  'status',
  'updatedAt',
  'sourceChecksum'
]);
const TRANSCRIPT_REVISION_SNAPSHOT_KEYS = Object.freeze([
  'schemaVersion',
  'transcriptId',
  'meetingId',
  'sourceId',
  'ownerId',
  'scope',
  'sourceRevision',
  'transcriptRevision',
  'kind',
  'createdAt',
  'createdBy'
]);
const TRANSCRIPT_SEGMENT_VIEW_KEYS = Object.freeze([
  'schemaVersion',
  'segmentId',
  'transcriptId',
  'transcriptRevision',
  'sequence',
  'startMs',
  'endMs',
  'text',
  'confidence',
  'speakerRef',
  'revision'
]);

function codedError(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function clone(value) {
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
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

function nonNegativeInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw codedError(code);
  return normalized;
}

function onlyKeys(value, keys) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

function exactKeys(value, keys) {
  return onlyKeys(value, keys) && Object.keys(value).length === keys.length;
}

function requestSnapshot(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw codedError('SPEAKER_CORRECTION_MANAGER_REQUEST_SHAPE_INVALID');
    }
    return deepFreeze(clone(value));
  } catch {
    throw codedError('SPEAKER_CORRECTION_MANAGER_REQUEST_SHAPE_INVALID');
  }
}

function selectOwn(value, keys) {
  return Object.fromEntries(keys
    .filter((key) => Object.hasOwn(value, key))
    .map((key) => [key, clone(value[key])]));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

async function sha256Hex(cryptoImpl, value) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  const digest = await cryptoImpl.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertDiarizationShape(revision) {
  const baseShape = exactKeys(revision, DIARIZATION_KEYS);
  const mappedShape = exactKeys(revision, MAPPED_DIARIZATION_KEYS);
  const speakerIds = new Set(Array.isArray(revision?.speakerRefs)
    ? revision.speakerRefs.map((speaker) => speaker?.speakerId)
    : []);
  const providerRoleEntries = mappedShape && revision.providerRoleMap
    && typeof revision.providerRoleMap === 'object' && !Array.isArray(revision.providerRoleMap)
    ? Object.entries(revision.providerRoleMap)
    : null;
  const providerRoleMapValid = !mappedShape || (providerRoleEntries
    && providerRoleEntries.every(([role, speakerId]) => /^[1-9][0-9]*$/.test(role) && speakerIds.has(speakerId))
    && new Set(providerRoleEntries.map(([, speakerId]) => speakerId)).size === providerRoleEntries.length);
  if ((!baseShape && !mappedShape)
      || !providerRoleMapValid
      || !Array.isArray(revision.speakerRefs)
      || !revision.speakerRefs.every((speaker) => exactKeys(speaker, DIARIZATION_SPEAKER_KEYS))
      || !Array.isArray(revision.segments)
      || !revision.segments.every((segment) => exactKeys(segment, DIARIZATION_SEGMENT_KEYS))) {
    throw codedError('SPEAKER_CORRECTION_DIARIZATION_SHAPE_INVALID');
  }
}

function assertTranscriptSnapshot(transcript, context, meetingId, transcriptId) {
  const document = transcript?.document;
  const documentCheck = validateTranscriptDocument(document, { ownerContext: context, expectedScope: 'meeting' });
  if (!documentCheck.valid) throw codedError(documentCheck.errors[0], documentCheck.errors);
  if (document.meetingId !== meetingId || document.transcriptId !== transcriptId) throw codedError('SPEAKER_CORRECTION_SOURCE_SCOPE_MISMATCH');
  if (document.status !== 'ready') throw codedError('SPEAKER_CORRECTION_TRANSCRIPT_NOT_READY');
  const revision = transcript?.currentRevision;
  if (!revision || revision.ownerId !== context.ownerId || revision.meetingId !== meetingId
      || revision.transcriptId !== transcriptId || revision.transcriptRevision !== document.transcriptRevision
      || revision.schemaVersion !== document.schemaVersion || revision.sourceId !== document.sourceId
      || revision.sourceRevision !== document.sourceRevision || revision.scope !== document.scope
      || !Array.isArray(revision.segments) || !revision.segments.length) {
    throw codedError('SPEAKER_CORRECTION_TRANSCRIPT_SCOPE_MISMATCH');
  }
  let previousEndMs = null;
  const segments = [];
  for (const [index, segment] of revision.segments.entries()) {
    const check = validateTranscriptSegment(segment, {
      transcriptId,
      revision: document.transcriptRevision,
      previousEndMs
    });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
    if (segment.sequence !== index || segment.revision !== document.transcriptRevision) {
      throw codedError('SPEAKER_CORRECTION_TRANSCRIPT_SCOPE_MISMATCH');
    }
    previousEndMs = segment.endMs;
    segments.push(selectOwn(segment, TRANSCRIPT_SEGMENT_VIEW_KEYS));
  }
  return deepFreeze({
    document: selectOwn(document, TRANSCRIPT_DOCUMENT_SNAPSHOT_KEYS),
    currentRevision: {
      ...selectOwn(revision, TRANSCRIPT_REVISION_SNAPSHOT_KEYS),
      segments
    }
  });
}

function assertDiarizationSnapshot(view, context, transcript) {
  const document = view?.document;
  const revision = view?.revision;
  if (!exactKeys(document, DIARIZATION_DOCUMENT_KEYS)
      || document.schemaVersion !== 1
      || document.ownerId !== context.ownerId
      || document.meetingId !== transcript.document.meetingId
      || document.transcriptId !== transcript.document.transcriptId
      || document.transcriptRevision !== transcript.document.transcriptRevision
      || document.currentDiarizationRevisionId !== revision?.diarizationRevisionId
      || document.currentRevision !== revision?.revision) {
    throw codedError('SPEAKER_CORRECTION_DIARIZATION_DOCUMENT_BINDING_INVALID');
  }
  assertDiarizationShape(revision);
  const correctionRevision = Object.fromEntries(DIARIZATION_KEYS.map((key) => [key, revision[key]]));
  const check = validateDiarizationRevision(correctionRevision, {
    ownerContext: context,
    meetingId: transcript.document.meetingId,
    transcriptId: transcript.document.transcriptId,
    transcriptRevision: transcript.document.transcriptRevision
  });
  if (!check.valid) throw codedError(check.errors[0], check.errors);
  if (correctionRevision.status !== 'ready') throw codedError('SPEAKER_CORRECTION_DIARIZATION_NOT_READY');
  const segments = transcript.currentRevision.segments;
  if (correctionRevision.segments.length !== segments.length) throw codedError('SPEAKER_CORRECTION_SOURCE_SEGMENT_MISMATCH');
  for (let index = 0; index < segments.length; index += 1) {
    const raw = segments[index];
    const diarized = correctionRevision.segments[index];
    if (diarized.transcriptSegmentId !== raw.segmentId || diarized.startMs !== raw.startMs || diarized.endMs !== raw.endMs) {
      throw codedError('SPEAKER_CORRECTION_SOURCE_SEGMENT_MISMATCH');
    }
  }
  return clone(correctionRevision);
}

function sameSourceSnapshot(left, right) {
  if (left.transcriptSnapshotHash !== right.transcriptSnapshotHash) return false;
  return [
    'ownerId',
    'meetingId',
    'transcriptId',
    'transcriptRevision',
    'baseDiarizationRevisionId',
    'baseDiarizationRevision',
    'baseDiarizationSnapshotHash'
  ].every((field) => left.baseRevision[field] === right.baseRevision[field]);
}

function projectView({ transcript, diarization, revision, ownerContext }) {
  if (revision.ownerId !== transcript.document.ownerId
      || revision.meetingId !== transcript.document.meetingId
      || revision.transcriptId !== transcript.document.transcriptId
      || revision.transcriptRevision !== transcript.document.transcriptRevision
      || revision.baseDiarizationRevisionId !== diarization.diarizationRevisionId
      || revision.baseDiarizationRevision !== diarization.revision) {
    throw codedError('SPEAKER_CORRECTION_PROJECTION_BINDING_INVALID');
  }
  const check = validateSpeakerCorrectionRevision(revision, {
    ownerContext
  });
  if (!check.valid) throw codedError(check.errors[0], check.errors);
  const assignments = new Map(revision.assignments.map((assignment) => [assignment.transcriptSegmentId, assignment.speakerRef]));
  if (assignments.size !== transcript.currentRevision.segments.length) throw codedError('SPEAKER_CORRECTION_PROJECTION_INTEGRITY_INVALID');
  const speakers = new Map(revision.speakerRefs.map((speaker) => [speaker.speakerId, speaker]));
  const segments = transcript.currentRevision.segments.map((rawSegment, index) => {
    if (!assignments.has(rawSegment.segmentId)) throw codedError('SPEAKER_CORRECTION_PROJECTION_INTEGRITY_INVALID');
    const speakerRef = assignments.get(rawSegment.segmentId);
    let effectiveSpeaker;
    if (speakerRef === 'unknown') {
      effectiveSpeaker = { speakerRef, displayLabel: anonymousSpeakerLabel(speakerRef), labelSource: 'unknown', state: 'unknown' };
    } else {
      const speaker = speakers.get(speakerRef);
      if (!speaker || speaker.state !== 'active') throw codedError('SPEAKER_CORRECTION_PROJECTION_INTEGRITY_INVALID');
      effectiveSpeaker = { speakerRef, displayLabel: speaker.displayLabel, labelSource: speaker.labelSource, state: speaker.state };
    }
    const rawDiarizationSegment = diarization.segments[index];
    return {
      rawSegment: clone(rawSegment),
      rawDiarization: {
        speakerRef: rawDiarizationSegment.speakerRef,
        confidence: rawDiarizationSegment.confidence,
        source: rawDiarizationSegment.source
      },
      effectiveSpeaker
    };
  });
  return deepFreeze({
    meetingId: revision.meetingId,
    transcriptId: revision.transcriptId,
    transcriptRevision: revision.transcriptRevision,
    baseDiarizationRevisionId: revision.baseDiarizationRevisionId,
    baseDiarizationRevision: revision.baseDiarizationRevision,
    baseDiarizationSnapshotHash: revision.baseDiarizationSnapshotHash,
    correctionRevisionId: revision.correctionRevisionId,
    correctionRevision: revision.correctionRevision,
    hasCorrections: revision.correctionRevision > 0,
    speakerRefs: clone(revision.speakerRefs),
    segments
  });
}

export function createMeetingSpeakerCorrectionManager({
  ownerContext: inputOwnerContext,
  transcriptStore,
  diarizationStore,
  speakerCorrectionStore,
  cryptoImpl = globalThis.crypto,
  now = () => new Date().toISOString(),
  createCorrectionRevisionId
} = {}) {
  const context = assertOwnerContext(inputOwnerContext);
  if (context.spaceId !== CANONICAL_MEETING_SPACE) throw codedError('SPEAKER_CORRECTION_CANONICAL_SPACE_REQUIRED');
  if (!cryptoImpl?.subtle) throw codedError('WEB_CRYPTO_UNAVAILABLE');
  if (typeof transcriptStore?.getTranscript !== 'function' || typeof diarizationStore?.getCurrentRevision !== 'function') {
    throw codedError('SPEAKER_CORRECTION_SOURCE_STORE_REQUIRED');
  }
  for (const method of ['listRevisions', 'appendRevision']) {
    if (typeof speakerCorrectionStore?.[method] !== 'function') throw codedError('SPEAKER_CORRECTION_STORE_REQUIRED');
  }
  const clock = typeof now === 'function' ? now : () => now;
  const revisionIdFactory = typeof createCorrectionRevisionId === 'function'
    ? createCorrectionRevisionId
    : () => `speaker-correction-${cryptoImpl.randomUUID()}`;

  async function loadBase(meetingId, transcriptId) {
    const transcript = assertTranscriptSnapshot(
      await transcriptStore.getTranscript(context, { meetingId, transcriptId }),
      context,
      meetingId,
      transcriptId
    );
    const diarization = assertDiarizationSnapshot(
      await diarizationStore.getCurrentRevision(context, {
        meetingId,
        transcriptId,
        transcriptRevision: transcript.document.transcriptRevision
      }),
      context,
      transcript
    );
    const [snapshotHash, transcriptSnapshotHash] = await Promise.all([
      sha256Hex(cryptoImpl, [SNAPSHOT_HASH_DOMAIN, diarization]),
      sha256Hex(cryptoImpl, [
        TRANSCRIPT_SNAPSHOT_HASH_DOMAIN,
        transcript.document,
        transcript.currentRevision
      ])
    ]);
    const baseRevision = createBaseSpeakerCorrectionSnapshot({
      ownerContext: context,
      diarizationRevision: diarization,
      baseDiarizationSnapshotHash: snapshotHash,
      now: diarization.createdAt
    });
    return { transcript, diarization, baseRevision, transcriptSnapshotHash };
  }

  async function loadCorrectionState(loaded) {
    const readInput = {
      ownerContext: context,
      meetingId: loaded.baseRevision.meetingId,
      transcriptId: loaded.baseRevision.transcriptId,
      expectedTranscriptRevision: loaded.baseRevision.transcriptRevision,
      baseDiarizationRevisionId: loaded.baseRevision.baseDiarizationRevisionId
    };
    let revisions;
    let retryingStoredChain = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        revisions = await speakerCorrectionStore.listRevisions(readInput);
        break;
      } catch (error) {
        if (error?.code === 'SPEAKER_CORRECTION_DOCUMENT_NOT_FOUND') {
          if (retryingStoredChain) throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID');
          return { revisions: [] };
        }
        if (error?.code === 'SPEAKER_CORRECTION_STORED_CHAIN_INVALID' && attempt === 0) {
          retryingStoredChain = true;
          continue;
        }
        throw error;
      }
    }
    if (!Array.isArray(revisions) || !revisions.length) throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID');
    const storedBase = revisions[0];
    for (const field of [
      'ownerId',
      'meetingId',
      'transcriptId',
      'transcriptRevision',
      'baseDiarizationRevisionId',
      'baseDiarizationRevision',
      'baseDiarizationSnapshotHash'
    ]) {
      if (storedBase[field] !== loaded.baseRevision[field]) {
        throw codedError('SPEAKER_CORRECTION_PROJECTION_BINDING_INVALID');
      }
    }
    let parent = loaded.baseRevision;
    for (const revision of revisions) {
      const check = validateSpeakerCorrectionRevision(revision, { ownerContext: context, parent });
      if (!check.valid) throw codedError('SPEAKER_CORRECTION_STORED_CHAIN_INVALID', check.errors);
      parent = revision;
    }
    return { revisions };
  }

  async function getSpeakerProjection(input = {}) {
    const request = requestSnapshot(input);
    if (!onlyKeys(request, PROJECTION_READ_KEYS)) throw codedError('SPEAKER_CORRECTION_MANAGER_REQUEST_SHAPE_INVALID');
    const meetingId = required(request.meetingId, 'SPEAKER_CORRECTION_MEETING_ID_REQUIRED');
    const transcriptId = required(request.transcriptId, 'SPEAKER_CORRECTION_TRANSCRIPT_ID_REQUIRED');
    const loaded = await loadBase(meetingId, transcriptId);
    const correctionState = await loadCorrectionState(loaded);
    const requestedRevision = request.correctionRevision === undefined
      ? correctionState.revisions.length
      : nonNegativeInteger(request.correctionRevision, 'SPEAKER_CORRECTION_REVISION_INVALID');
    if (requestedRevision > correctionState.revisions.length) throw codedError('SPEAKER_CORRECTION_REVISION_NOT_FOUND');
    const revision = requestedRevision === 0 ? loaded.baseRevision : correctionState.revisions[requestedRevision - 1];
    return projectView({ ...loaded, revision, ownerContext: context });
  }

  async function getCorrectionHistory(input = {}) {
    const request = requestSnapshot(input);
    if (!onlyKeys(request, HISTORY_READ_KEYS)) throw codedError('SPEAKER_CORRECTION_MANAGER_REQUEST_SHAPE_INVALID');
    const meetingId = required(request.meetingId, 'SPEAKER_CORRECTION_MEETING_ID_REQUIRED');
    const transcriptId = required(request.transcriptId, 'SPEAKER_CORRECTION_TRANSCRIPT_ID_REQUIRED');
    const loaded = await loadBase(meetingId, transcriptId);
    const correctionState = await loadCorrectionState(loaded);
    return deepFreeze({
      baseRevision: clone(loaded.baseRevision),
      correctionRevisions: clone(correctionState.revisions),
      currentCorrectionRevision: correctionState.revisions.length
    });
  }

  async function applyMutation(input, operation, keys) {
    const request = requestSnapshot(input);
    if (!exactKeys(request, keys)) throw codedError('SPEAKER_CORRECTION_MANAGER_REQUEST_SHAPE_INVALID');
    const meetingId = required(request.meetingId, 'SPEAKER_CORRECTION_MEETING_ID_REQUIRED');
    const transcriptId = required(request.transcriptId, 'SPEAKER_CORRECTION_TRANSCRIPT_ID_REQUIRED');
    const expectedTranscriptRevision = positiveInteger(request.expectedTranscriptRevision, 'SPEAKER_CORRECTION_EXPECTED_TRANSCRIPT_REVISION_INVALID');
    const expectedCorrectionRevision = nonNegativeInteger(request.expectedCorrectionRevision, 'SPEAKER_CORRECTION_EXPECTED_REVISION_INVALID');
    const baseDiarizationRevisionId = required(request.baseDiarizationRevisionId, 'SPEAKER_CORRECTION_BASE_DIARIZATION_REVISION_ID_REQUIRED');
    const mutationRequestId = required(request.mutationRequestId, 'SPEAKER_CORRECTION_MUTATION_REQUEST_ID_REQUIRED');
    const loaded = await loadBase(meetingId, transcriptId);
    if (loaded.baseRevision.transcriptRevision !== expectedTranscriptRevision
        || loaded.baseRevision.baseDiarizationRevisionId !== baseDiarizationRevisionId) {
      throw codedError('SPEAKER_CORRECTION_SOURCE_STALE');
    }
    const correctionState = await loadCorrectionState(loaded);
    if (expectedCorrectionRevision > correctionState.revisions.length) throw codedError('SPEAKER_CORRECTION_CAS_CONFLICT');
    const parent = expectedCorrectionRevision === 0
      ? loaded.baseRevision
      : correctionState.revisions[expectedCorrectionRevision - 1];
    const candidate = applyCoreSpeakerCorrection({
      ownerContext: context,
      currentRevision: parent,
      correctionRevisionId: required(revisionIdFactory(), 'SPEAKER_CORRECTION_REVISION_ID_INVALID'),
      mutationRequestId,
      operation,
      speakerId: request.speakerId,
      speakerIds: request.speakerIds,
      targetSpeakerId: request.targetSpeakerId,
      transcriptSegmentIds: request.transcriptSegmentIds,
      displayLabel: request.displayLabel,
      now: clock()
    });
    const beforeCommit = await loadBase(meetingId, transcriptId);
    if (!sameSourceSnapshot(loaded, beforeCommit)) throw codedError('SPEAKER_CORRECTION_SOURCE_STALE');
    const appendInput = {
      ownerContext: context,
      meetingId,
      transcriptId,
      expectedTranscriptRevision,
      baseDiarizationRevisionId,
      expectedCorrectionRevision,
      mutationRequestId,
      revision: candidate
    };
    if (expectedCorrectionRevision === 0) appendInput.parentRevision = loaded.baseRevision;
    const stored = await speakerCorrectionStore.appendRevision(appendInput);
    const committedDetails = {
      committed: true,
      replayed: stored.replayed,
      correctionRevisionId: stored.revision.correctionRevisionId,
      correctionRevision: stored.revision.correctionRevision
    };
    let afterCommit;
    try {
      afterCommit = await loadBase(meetingId, transcriptId);
    } catch (cause) {
      const error = codedError('SPEAKER_CORRECTION_SOURCE_CHANGED_AFTER_COMMIT', committedDetails);
      error.cause = cause;
      throw error;
    }
    if (!sameSourceSnapshot(loaded, afterCommit)) {
      throw codedError('SPEAKER_CORRECTION_SOURCE_CHANGED_AFTER_COMMIT', committedDetails);
    }
    return deepFreeze({
      replayed: stored.replayed,
      revision: clone(stored.revision),
      appliedRevisionProjection: projectView({ ...afterCommit, revision: stored.revision, ownerContext: context })
    });
  }

  async function renameSpeaker(input = {}) {
    return applyMutation(input, 'rename', RENAME_KEYS);
  }

  async function mergeSpeakers(input = {}) {
    return applyMutation(input, 'merge', MERGE_KEYS);
  }

  async function splitSpeaker(input = {}) {
    return applyMutation(input, 'split', SPLIT_KEYS);
  }

  async function reassignSegments(input = {}) {
    return applyMutation(input, 'reassign', REASSIGN_KEYS);
  }

  return Object.freeze({
    getSpeakerProjection,
    getCorrectionHistory,
    renameSpeaker,
    mergeSpeakers,
    splitSpeaker,
    reassignSegments,
  });
}

export { codedError };
