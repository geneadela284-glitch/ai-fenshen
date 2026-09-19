const MANAGER_METHODS = Object.freeze([
  'getSpeakerProjection',
  'getCorrectionHistory',
  'renameSpeaker',
  'mergeSpeakers',
  'splitSpeaker',
  'reassignSegments'
]);

const BASE_BINDING_FIELDS = Object.freeze([
  'meetingId',
  'transcriptId',
  'transcriptRevision',
  'baseDiarizationRevisionId',
  'baseDiarizationRevision',
  'baseDiarizationSnapshotHash'
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function intentKey(intent) {
  try {
    return JSON.stringify(canonical(structuredClone(intent)));
  } catch {
    throw codedError('SPEAKER_MANAGEMENT_UI_INTENT_INVALID');
  }
}

function requiredString(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function requiredIds(value) {
  if (!Array.isArray(value) || !value.length) throw codedError('SPEAKER_MANAGEMENT_UI_SELECTION_INVALID');
  const ids = value.map((id) => requiredString(id, 'SPEAKER_MANAGEMENT_UI_SELECTION_INVALID'));
  if (new Set(ids).size !== ids.length) throw codedError('SPEAKER_MANAGEMENT_UI_SELECTION_INVALID');
  return ids;
}

function activeSpeakers(projection) {
  if (!Array.isArray(projection?.speakerRefs)) throw codedError('SPEAKER_MANAGEMENT_UI_PROJECTION_INVALID');
  return projection.speakerRefs.filter((speaker) => speaker?.state === 'active');
}

function mapSnapshot(projection, history) {
  if (!projection || typeof projection !== 'object' || !Array.isArray(projection.segments)) {
    throw codedError('SPEAKER_MANAGEMENT_UI_PROJECTION_INVALID');
  }
  const speakers = activeSpeakers(projection);
  const speakerCounts = new Map(projection.segments.map((segment) => segment?.effectiveSpeaker?.speakerRef).map((id) => [id, 0]));
  for (const segment of projection.segments) {
    const speakerId = segment?.effectiveSpeaker?.speakerRef;
    if (speakerCounts.has(speakerId)) speakerCounts.set(speakerId, speakerCounts.get(speakerId) + 1);
  }
  const safeSpeakers = speakers.map((speaker) => ({
    id: requiredString(speaker.speakerId, 'SPEAKER_MANAGEMENT_UI_PROJECTION_INVALID'),
    label: requiredString(speaker.displayLabel, 'SPEAKER_MANAGEMENT_UI_PROJECTION_INVALID'),
    canRename: true,
    canMerge: true,
    canSplit: (speakerCounts.get(speaker.speakerId) || 0) > 1,
    canReceiveReassignment: true
  }));
  safeSpeakers.push({
    id: 'unknown',
    label: '未识别说话人',
    canRename: false,
    canMerge: false,
    canSplit: false,
    canReceiveReassignment: true
  });
  const safeSegments = projection.segments.map((segment) => {
    const raw = segment?.rawSegment;
    const effective = segment?.effectiveSpeaker;
    const speakerId = requiredString(effective?.speakerRef, 'SPEAKER_MANAGEMENT_UI_PROJECTION_INVALID');
    return {
      id: requiredString(raw?.segmentId, 'SPEAKER_MANAGEMENT_UI_PROJECTION_INVALID'),
      startMs: Number(raw?.startMs),
      endMs: Number(raw?.endMs),
      text: requiredString(raw?.text, 'SPEAKER_MANAGEMENT_UI_PROJECTION_INVALID'),
      speakerId,
      speakerLabel: speakerId === 'unknown'
        ? '未识别说话人'
        : requiredString(effective?.displayLabel, 'SPEAKER_MANAGEMENT_UI_PROJECTION_INVALID'),
      canSelectForSplit: speakerId !== 'unknown' && (speakerCounts.get(speakerId) || 0) > 1,
      canSelectForReassignment: true
    };
  });
  return deepFreeze({
    speakers: safeSpeakers,
    segments: safeSegments,
    history: mapHistory(history)
  });
}

function mapHistory(history) {
  if (!history || !Array.isArray(history.correctionRevisions)) {
    throw codedError('SPEAKER_MANAGEMENT_UI_HISTORY_INVALID');
  }
  return history.correctionRevisions.map((revision) => {
    const audit = revision?.audit;
    const change = audit?.changes?.[0];
    const occurredAt = requiredString(audit?.occurredAt, 'SPEAKER_MANAGEMENT_UI_HISTORY_INVALID');
    let summary;
    if (audit.operation === 'rename') {
      summary = `已将“${requiredString(change?.previousDisplayLabel, 'SPEAKER_MANAGEMENT_UI_HISTORY_INVALID')}”重命名为“${requiredString(change?.displayLabel, 'SPEAKER_MANAGEMENT_UI_HISTORY_INVALID')}”`;
    } else if (audit.operation === 'merge') {
      summary = `已合并 ${requiredIds(change?.sourceSpeakerIds).length + 1} 位说话人`;
    } else if (audit.operation === 'split') {
      summary = `已将 ${requiredIds(change?.transcriptSegmentIds).length} 段内容拆分为新的说话人`;
    } else if (audit.operation === 'reassign') {
      summary = `已重新分配 ${requiredIds(change?.transcriptSegmentIds).length} 段内容`;
    } else {
      throw codedError('SPEAKER_MANAGEMENT_UI_HISTORY_INVALID');
    }
    return { occurredAt, summary };
  });
}

function managerRequest(binding, mutationRequestId) {
  return {
    meetingId: binding.projection.meetingId,
    transcriptId: binding.projection.transcriptId,
    expectedTranscriptRevision: binding.projection.transcriptRevision,
    baseDiarizationRevisionId: binding.projection.baseDiarizationRevisionId,
    expectedCorrectionRevision: binding.projection.correctionRevision,
    mutationRequestId
  };
}

function operationRequest(binding, intent, mutationRequestId) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) {
    throw codedError('SPEAKER_MANAGEMENT_UI_INTENT_INVALID');
  }
  const base = managerRequest(binding, mutationRequestId);
  if (intent.type === 'rename') {
    return { method: 'renameSpeaker', input: { ...base, speakerId: requiredString(intent.speakerId, 'SPEAKER_MANAGEMENT_UI_SELECTION_INVALID'), displayLabel: requiredString(intent.displayLabel, 'SPEAKER_MANAGEMENT_UI_LABEL_INVALID') } };
  }
  if (intent.type === 'merge') {
    return { method: 'mergeSpeakers', input: { ...base, speakerIds: requiredIds(intent.speakerIds), targetSpeakerId: requiredString(intent.targetSpeakerId, 'SPEAKER_MANAGEMENT_UI_SELECTION_INVALID') } };
  }
  if (intent.type === 'split') {
    return { method: 'splitSpeaker', input: { ...base, speakerId: requiredString(intent.speakerId, 'SPEAKER_MANAGEMENT_UI_SELECTION_INVALID'), transcriptSegmentIds: requiredIds(intent.segmentIds) } };
  }
  if (intent.type === 'reassign') {
    return { method: 'reassignSegments', input: { ...base, transcriptSegmentIds: requiredIds(intent.segmentIds), targetSpeakerId: requiredString(intent.targetSpeakerId, 'SPEAKER_MANAGEMENT_UI_SELECTION_INVALID') } };
  }
  throw codedError('SPEAKER_MANAGEMENT_UI_INTENT_INVALID');
}

function safeMutationError(error) {
  if (error?.code === 'SPEAKER_CORRECTION_NO_CHANGE') {
    return deepFreeze({ error: { category: 'no_change', message: '当前选择没有产生新的修改，请调整后再试。', committed: false, requiresRefresh: false } });
  }
  if (error?.code === 'SPEAKER_CORRECTION_CAS_CONFLICT') {
    return deepFreeze({ error: { category: 'conflict', message: '这项说话人修改已过期，请刷新后重试。', committed: false, requiresRefresh: true } });
  }
  if (error?.code === 'SPEAKER_CORRECTION_SOURCE_STALE') {
    return deepFreeze({ error: { category: 'source_changed', message: '会议转写或说话人识别已更新，请刷新后重试。', committed: false, requiresRefresh: true } });
  }
  if (error?.code === 'SPEAKER_CORRECTION_SOURCE_CHANGED_AFTER_COMMIT') {
    return deepFreeze({ error: { category: 'changed_after_commit', message: '修改已保存，但会议内容已更新；请刷新查看最新结果。', committed: error?.details?.committed === true, requiresRefresh: true } });
  }
  return null;
}

function readIsCoherent(projection, history) {
  if (!projection || typeof projection !== 'object' || !history || typeof history !== 'object') return false;
  if (!history.baseRevision || typeof history.baseRevision !== 'object') return false;
  if (!Array.isArray(history.correctionRevisions)) return false;
  if (!BASE_BINDING_FIELDS.every((field) => projection[field] === history.baseRevision[field])) return false;
  if (!Number.isSafeInteger(projection.correctionRevision) || projection.correctionRevision < 0) return false;
  if (history.currentCorrectionRevision !== projection.correctionRevision) return false;
  if (projection.correctionRevision === 0) {
    return projection.correctionRevisionId === null && history.correctionRevisions.length === 0;
  }
  const head = history.correctionRevisions.at(-1);
  return head?.correctionRevision === projection.correctionRevision
    && head?.correctionRevisionId === projection.correctionRevisionId;
}

export function createMeetingSpeakerManagementUiFacade({ manager, speakerCorrection, cryptoImpl = globalThis.crypto } = {}) {
  const phase3Manager = manager || speakerCorrection;
  if (!phase3Manager || !MANAGER_METHODS.every((method) => typeof phase3Manager[method] === 'function')) {
    throw codedError('SPEAKER_MANAGEMENT_UI_MANAGER_REQUIRED');
  }
  if (typeof cryptoImpl?.randomUUID !== 'function') throw codedError('SPEAKER_MANAGEMENT_UI_ID_SOURCE_REQUIRED');
  const bindings = new WeakMap();

  async function readCoherent(request) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [projection, history] = await Promise.all([
        phase3Manager.getSpeakerProjection(request),
        phase3Manager.getCorrectionHistory(request)
      ]);
      if (readIsCoherent(projection, history)) return { projection, history };
    }
    throw codedError('SPEAKER_MANAGEMENT_UI_READ_COHERENCE_INVALID');
  }

  async function load({ meetingId, transcriptId } = {}) {
    const request = {
      meetingId: requiredString(meetingId, 'SPEAKER_MANAGEMENT_UI_MEETING_ID_REQUIRED'),
      transcriptId: requiredString(transcriptId, 'SPEAKER_MANAGEMENT_UI_TRANSCRIPT_ID_REQUIRED')
    };
    const { projection, history } = await readCoherent(request);
    const snapshot = mapSnapshot(projection, history);
    bindings.set(snapshot, { projection, requestIds: new Map() });
    return snapshot;
  }

  async function apply(snapshot, intent) {
    const binding = bindings.get(snapshot);
    if (!binding) throw codedError('SPEAKER_MANAGEMENT_UI_SNAPSHOT_REQUIRED');
    const key = intentKey(intent);
    let mutationRequestId = binding.requestIds.get(key);
    if (!mutationRequestId) {
      mutationRequestId = requiredString(cryptoImpl.randomUUID(), 'SPEAKER_MANAGEMENT_UI_ID_SOURCE_INVALID');
      binding.requestIds.set(key, mutationRequestId);
    }
    const operation = operationRequest(binding, intent, mutationRequestId);
    try {
      await phase3Manager[operation.method](operation.input);
    } catch (error) {
      const safeError = safeMutationError(error);
      if (safeError) return safeError;
      throw error;
    }
    return load({
      meetingId: binding.projection.meetingId,
      transcriptId: binding.projection.transcriptId
    });
  }

  return Object.freeze({ load, apply });
}
