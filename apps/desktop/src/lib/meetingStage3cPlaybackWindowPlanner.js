function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function finiteNonNegative(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0;
}

export function buildStage3cPlaybackTimeline({ source, segments } = {}) {
  if (!source || !Array.isArray(segments) || segments.length === 0) throw codedError('PLAYBACK_SOURCE_TIMELINE_EMPTY');
  const ordered = [...segments].sort((left, right) => Number(left.sequence) - Number(right.sequence));
  let durationMs = 0;
  let byteLength = 0;
  const entries = ordered.map((segment, index) => {
    if (segment.sequence !== index || !finiteNonNegative(segment.durationMs) || !finiteNonNegative(segment.byteLength)) {
      throw codedError('PLAYBACK_SOURCE_TIMELINE_INVALID');
    }
    const entry = Object.freeze({
      sequence: index,
      sourceChunkId: String(segment.segmentId || segment.chunkId || segment.sourceChunkId || ''),
      startMs: durationMs,
      endMs: durationMs + Number(segment.durationMs),
      durationMs: Number(segment.durationMs),
      byteLength: Number(segment.byteLength),
      checksum: String(segment.checksum || ''),
      mimeType: String(segment.mimeType || source.mimeType || '')
    });
    durationMs = entry.endMs;
    byteLength += entry.byteLength;
    if (!entry.sourceChunkId) throw codedError('PLAYBACK_SOURCE_TIMELINE_INVALID');
    return entry;
  });
  const expectedDuration = Number(source.committedDurationMs ?? source.durationMs);
  const expectedBytes = Number(source.committedByteLength ?? source.byteLength);
  if (!Number.isFinite(expectedDuration) || durationMs !== expectedDuration || !Number.isFinite(expectedBytes) || byteLength !== expectedBytes || Number(source.chunkCount) !== entries.length) {
    throw codedError('PLAYBACK_SOURCE_TIMELINE_MISMATCH');
  }
  return Object.freeze({
    sourceId: String(source.sourceId),
    revision: Number(source.revision),
    durationMs,
    byteLength,
    entries: Object.freeze(entries)
  });
}

export function findStage3cTimelinePosition(timeline, targetMs) {
  if (!timeline?.entries?.length) throw codedError('PLAYBACK_SOURCE_TIMELINE_EMPTY');
  const clamped = Math.max(0, Math.min(Number(timeline.durationMs), Number(targetMs) || 0));
  let low = 0;
  let high = timeline.entries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = timeline.entries[middle];
    if (clamped < entry.startMs) high = middle - 1;
    else if (clamped >= entry.endMs && middle < timeline.entries.length - 1) low = middle + 1;
    else return { sequence: entry.sequence, offsetMs: Math.max(0, clamped - entry.startMs) };
  }
  const last = timeline.entries[timeline.entries.length - 1];
  return { sequence: last.sequence, offsetMs: Math.max(0, last.durationMs) };
}

export function resolveStage3cPlaybackWindow(timeline, targetMs, { maxMediaChunks = 3 } = {}) {
  if (!Number.isSafeInteger(maxMediaChunks) || maxMediaChunks < 1 || maxMediaChunks > 3) throw codedError('PLAYBACK_WINDOW_LIMIT_INVALID');
  const position = findStage3cTimelinePosition(timeline, targetMs);
  const target = Math.max(0, Math.min(Number(timeline.durationMs), Number(targetMs) || 0));
  const entries = timeline.entries.slice(position.sequence, position.sequence + maxMediaChunks);
  if (!entries.length) throw codedError('PLAYBACK_SOURCE_TIMELINE_EMPTY');
  return Object.freeze({
    startMs: entries[0].startMs,
    endMs: entries[entries.length - 1].endMs,
    targetMs: target,
    mediaChunks: Object.freeze(entries)
  });
}
