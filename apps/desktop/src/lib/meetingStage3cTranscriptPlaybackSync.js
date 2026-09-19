function codedError(code, details = null) {
  const error = new Error(code);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function finiteNonNegative(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

function integerOrNull(value) {
  return Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function normalizedRevision(input) {
  if (!input || typeof input !== 'object') return null;
  const revision = input.currentRevision || input.revision || input;
  if (!revision || typeof revision !== 'object') return null;
  return {
    ...input,
    ...revision,
    segments: revision.segments
  };
}

function normalizedSourceBinding(input) {
  const source = input?.source || input?.audioSource || input;
  if (!source || typeof source !== 'object') return null;
  return {
    ...source,
    meetingId: source.meetingId ?? input?.meetingId,
    sourceId: source.sourceId ?? input?.sourceId,
    revision: source.revision ?? source.sourceRevision ?? input?.sourceRevision,
    durationMs: source.durationMs ?? source.committedDurationMs ?? input?.durationMs,
    checksum: source.checksum ?? source.sourceChecksum ?? input?.sourceChecksum
  };
}

function normalizedExpectedBinding(input) {
  const source = normalizedSourceBinding(input);
  return {
    meetingId: source?.meetingId ?? input?.meetingId,
    sourceId: source?.sourceId ?? input?.sourceId,
    sourceRevision: source?.revision ?? input?.sourceRevision ?? input?.revision,
    durationMs: source?.durationMs ?? input?.durationMs,
    sourceChecksum: source?.checksum ?? input?.sourceChecksum,
    transcriptId: input?.transcriptId,
    transcriptRevision: input?.transcriptRevision
  };
}

function assertStringEqual(expected, actual, code) {
  if (expected !== undefined && expected !== null && String(expected) !== String(actual)) throw codedError(code);
}

function assertNumberEqual(expected, actual, code) {
  if (expected !== undefined && expected !== null && Number(expected) !== Number(actual)) throw codedError(code);
}

function hasCompleteSpeakerCorrectionBinding(projection) {
  return Boolean(
    projection
    && typeof projection === 'object'
    && String(projection.meetingId || '').trim()
    && String(projection.sourceId || '').trim()
    && Number.isSafeInteger(Number(projection.sourceRevision ?? projection.sourceRevisionNumber))
    && String(projection.transcriptId || '').trim()
    && Number.isSafeInteger(Number(projection.transcriptRevision))
  );
}

export function classifyStage3cSpeakerCorrectionBinding(projection, expected = {}) {
  if (!projection || typeof projection !== 'object') return 'missing';
  if (!hasCompleteSpeakerCorrectionBinding(projection)) return 'incomplete';
  const sourceRevision = projection.sourceRevision ?? projection.sourceRevisionNumber;
  const matches = String(expected.meetingId || '') === String(projection.meetingId || '')
    && String(expected.sourceId || '') === String(projection.sourceId || '')
    && Number(expected.sourceRevision) === Number(sourceRevision)
    && String(expected.transcriptId || '') === String(projection.transcriptId || '')
    && Number(expected.transcriptRevision) === Number(projection.transcriptRevision);
  return matches ? 'valid' : 'mismatch';
}

function assertRevisionBinding({ expected, transcript, diarizationRevision, speakerCorrectionRevision }) {
  assertStringEqual(expected.meetingId, transcript.meetingId, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  assertStringEqual(expected.sourceId, transcript.sourceId, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  assertNumberEqual(expected.sourceRevision, transcript.sourceRevision, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  assertStringEqual(expected.transcriptId, transcript.transcriptId, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  assertNumberEqual(expected.transcriptRevision, transcript.transcriptRevision, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  if (expected.sourceChecksum !== undefined && expected.sourceChecksum !== null && transcript.sourceChecksum !== undefined) {
    assertStringEqual(expected.sourceChecksum, transcript.sourceChecksum, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  }
  const checkRelated = (related) => {
    if (!related || typeof related !== 'object') return;
    assertStringEqual(expected.meetingId, related.meetingId, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
    assertStringEqual(expected.sourceId, related.sourceId, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
    assertNumberEqual(expected.sourceRevision, related.sourceRevision ?? related.sourceRevisionNumber, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
    if (related.transcriptId !== undefined) assertStringEqual(expected.transcriptId, related.transcriptId, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
    if (related.transcriptRevision !== undefined) assertNumberEqual(expected.transcriptRevision, related.transcriptRevision, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  };
  checkRelated(diarizationRevision);
  if (hasCompleteSpeakerCorrectionBinding(speakerCorrectionRevision)) checkRelated(speakerCorrectionRevision);
}

function assertRequiredBinding(expected, transcript) {
  if (!String(expected.meetingId || '').trim() || !String(expected.sourceId || '').trim() || !Number.isSafeInteger(Number(expected.sourceRevision)) || !String(expected.transcriptId || '').trim() || !Number.isSafeInteger(Number(expected.transcriptRevision))) {
    throw codedError('TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  }
  if (!String(transcript.meetingId || '').trim() || !String(transcript.sourceId || '').trim() || !Number.isSafeInteger(Number(transcript.sourceRevision)) || !String(transcript.transcriptId || '').trim() || !Number.isSafeInteger(Number(transcript.transcriptRevision))) {
    throw codedError('TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  }
}

function buildTimeline(transcript, expected) {
  if (!Array.isArray(transcript.segments) || transcript.segments.length === 0) {
    throw codedError('TRANSCRIPT_PLAYBACK_TIMELINE_INVALID');
  }
  const ordered = transcript.segments.map((segment) => clone(segment));
  let previousEndMs = 0;
  const timeline = ordered.map((segment, index) => {
    const startMs = Number(segment?.startMs);
    const endMs = Number(segment?.endMs);
    if (!segment || String(segment.segmentId || '').trim() === '' || segment.sequence !== index || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs || startMs < previousEndMs) {
      throw codedError('TRANSCRIPT_PLAYBACK_TIMELINE_INVALID');
    }
    previousEndMs = endMs;
    return deepFreeze({ ...segment, segmentId: String(segment.segmentId), startMs, endMs, sequence: index });
  });
  if (finiteNonNegative(expected.durationMs) && previousEndMs > Number(expected.durationMs)) {
    throw codedError('TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  }
  return Object.freeze(timeline);
}

function findSegmentIndex(timeline, currentTimeMs) {
  let low = 0;
  let high = timeline.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const segment = timeline[middle];
    if (currentTimeMs < segment.startMs) high = middle - 1;
    else if (currentTimeMs >= segment.endMs) low = middle + 1;
    else return middle;
  }
  return -1;
}

function projectionFor(speakerProjection, segment) {
  if (!speakerProjection) return null;
  if (typeof speakerProjection === 'function') return clone(speakerProjection(segment)) || null;
  if (speakerProjection instanceof Map) return clone(speakerProjection.get(segment.segmentId) || null);
  if (typeof speakerProjection === 'object') {
    if (Array.isArray(speakerProjection.segments)) {
      const item = speakerProjection.segments.find((entry) => String(entry?.segmentId || entry?.rawSegment?.segmentId || '') === segment.segmentId);
      return clone(item?.effectiveSpeaker || item || null);
    }
    const map = speakerProjection.bySegmentId || speakerProjection.effectiveSpeakerBySegmentId || speakerProjection;
    if (map && typeof map === 'object') return clone(map[segment.segmentId] || null);
  }
  return null;
}

function segmentPresentation(segment, speakerProjection) {
  return deepFreeze({
    ...clone(segment),
    effectiveSpeaker: projectionFor(speakerProjection, segment)
  });
}

function assertPlaybackSnapshot(expected, playbackManager) {
  const snapshot = playbackManager?.getSnapshot?.();
  if (!snapshot || snapshot.opened === false) return;
  assertStringEqual(expected.meetingId, snapshot.meetingId, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  assertStringEqual(expected.sourceId, snapshot.sourceId, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  assertNumberEqual(expected.sourceRevision, snapshot.revision, 'TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
}

export function createStage3cTranscriptPlaybackSync({
  binding,
  transcript,
  diarizationRevision = null,
  speakerCorrectionRevision = null,
  speakerProjection = null,
  playbackManager,
  scrollToSegment = () => {},
  maxDomSegments = 200
} = {}) {
  if (!playbackManager || typeof playbackManager.seekTo !== 'function') throw codedError('TRANSCRIPT_PLAYBACK_DEPENDENCY_UNAVAILABLE');
  if (!Number.isSafeInteger(maxDomSegments) || maxDomSegments < 1 || maxDomSegments > 200) throw codedError('TRANSCRIPT_PLAYBACK_WINDOW_INVALID');
  const expected = normalizedExpectedBinding(binding);
  const currentRevision = normalizedRevision(transcript);
  if (!expected || !currentRevision) throw codedError('TRANSCRIPT_PLAYBACK_BINDING_MISMATCH');
  assertRequiredBinding(expected, currentRevision);
  assertRevisionBinding({ expected, transcript: currentRevision, diarizationRevision, speakerCorrectionRevision });
  const timeline = buildTimeline(currentRevision, expected);
  let disposed = false;
  let activeIndex = -1;
  let currentTimeMs = null;
  let autoFollowEnabled = true;
  let userScrolled = false;
  const visibleSegmentIds = new Set();

  function ensureLive() {
    if (disposed) throw codedError('TRANSCRIPT_PLAYBACK_SYNC_DISPOSED');
    assertPlaybackSnapshot(expected, playbackManager);
  }

  function activeSegment() {
    return activeIndex < 0 ? null : timeline[activeIndex];
  }

  function showReturnToCurrent() {
    const active = activeSegment();
    return Boolean(active && !autoFollowEnabled && !visibleSegmentIds.has(active.segmentId));
  }

  function snapshot() {
    const active = activeSegment();
    return deepFreeze({
      activeSegment: active ? segmentPresentation(active, speakerProjection) : null,
      activeSegmentId: active?.segmentId || null,
      currentTimeMs,
      binding: {
        meetingId: expected.meetingId,
        sourceId: expected.sourceId,
        sourceRevision: Number(expected.sourceRevision),
        transcriptId: expected.transcriptId,
        transcriptRevision: Number(expected.transcriptRevision)
      },
      autoFollowEnabled,
      userScrolled,
      showReturnToCurrent: showReturnToCurrent(),
      autoFollowTargetSegmentId: active && autoFollowEnabled && !visibleSegmentIds.has(active.segmentId) ? active.segmentId : null,
      timelineLength: timeline.length,
      virtualized: true,
      maxDomSegments
    });
  }

  function getSegmentPresentation(segmentId) {
    ensureLive();
    const segment = timeline.find((item) => item.segmentId === String(segmentId));
    if (!segment) throw codedError('TRANSCRIPT_SEGMENT_NOT_FOUND');
    return segmentPresentation(segment, speakerProjection);
  }

  async function clickSegment(segmentId, { autoplay = true } = {}) {
    ensureLive();
    const segment = timeline.find((item) => item.segmentId === String(segmentId));
    if (!segment) throw codedError('TRANSCRIPT_SEGMENT_NOT_FOUND');
    const seekResult = await playbackManager.seekTo(segment.startMs, { autoplay });
    activeIndex = timeline.indexOf(segment);
    currentTimeMs = segment.startMs;
    return Object.freeze({ segment: segmentPresentation(segment, speakerProjection), seekResult, snapshot: snapshot() });
  }

  function updateCurrentTime(timeMs) {
    ensureLive();
    if (!Number.isFinite(Number(timeMs)) || Number(timeMs) < 0) throw codedError('TRANSCRIPT_PLAYBACK_TIME_INVALID');
    currentTimeMs = Number(timeMs);
    activeIndex = findSegmentIndex(timeline, currentTimeMs);
    const state = snapshot();
    return deepFreeze(state);
  }

  function onUserScroll() {
    ensureLive();
    userScrolled = true;
    autoFollowEnabled = false;
    return snapshot();
  }

  function setSegmentVisibility(segmentId, visible) {
    ensureLive();
    const id = String(segmentId);
    if (visible) visibleSegmentIds.add(id);
    else visibleSegmentIds.delete(id);
    return snapshot();
  }

  function returnToCurrent() {
    ensureLive();
    const active = activeSegment();
    if (!active) return snapshot();
    scrollToSegment(active.segmentId);
    visibleSegmentIds.add(active.segmentId);
    autoFollowEnabled = true;
    userScrolled = false;
    return snapshot();
  }

  function getVirtualizedWindow({ centerIndex = activeIndex < 0 ? 0 : activeIndex, viewportSize = 40, overscan = 20 } = {}) {
    ensureLive();
    const requested = Math.max(1, Math.floor(Number(viewportSize) || 1) + 2 * Math.max(0, Math.floor(Number(overscan) || 0)));
    const size = Math.min(maxDomSegments, requested, timeline.length);
    const center = Math.max(0, Math.min(timeline.length - 1, Math.floor(Number(centerIndex) || 0)));
    const startIndex = Math.max(0, Math.min(center - Math.floor(size / 2), timeline.length - size));
    const endIndex = startIndex + size;
    return deepFreeze({
      startIndex,
      endIndex,
      domCount: endIndex - startIndex,
      segments: timeline.slice(startIndex, endIndex).map((segment) => segmentPresentation(segment, speakerProjection))
    });
  }

  function dispose() {
    disposed = true;
    visibleSegmentIds.clear();
  }

  return Object.freeze({
    clickSegment,
    updateCurrentTime,
    onUserScroll,
    setSegmentVisibility,
    returnToCurrent,
    getSegmentPresentation,
    getVirtualizedWindow,
    getSnapshot: snapshot,
    dispose
  });
}
