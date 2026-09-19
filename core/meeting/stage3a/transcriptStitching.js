import {
  createTranscriptSegment,
  validateTranscriptSegment
} from './transcriptContracts.js';

function codedError(code, details = undefined) {
  const error = new Error(code);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function normalizedText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function words(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}

function removeTextOverlap(previous, current) {
  const previousWords = words(previous);
  const currentWords = words(current);
  if (previousWords.length > 1 && currentWords.length > 1) {
    const max = Math.min(previousWords.length, currentWords.length);
    for (let count = max; count >= 2; count -= 1) {
      if (previousWords.slice(-count).join(' ') === currentWords.slice(0, count).join(' ')) {
        return currentWords.slice(count).join(' ');
      }
    }
  }
  const previousText = String(previous || '').trim();
  const currentText = String(current || '').trim();
  const characterMax = Math.min(previousText.length, currentText.length);
  for (let count = characterMax; count >= 2; count -= 1) {
    if (previousText.slice(-count) === currentText.slice(0, count)) return currentText.slice(count);
  }
  return current;
}

function absoluteBounds(chunk, segment) {
  const start = segment.absoluteStartMs === undefined
    ? Number(chunk.startMs) + Number(segment.startMs)
    : Number(segment.absoluteStartMs);
  const end = segment.absoluteEndMs === undefined
    ? Number(chunk.startMs) + Number(segment.endMs)
    : Number(segment.absoluteEndMs);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw codedError('TRANSCRIPT_TIMESTAMP_INVALID');
  return { startMs: start, endMs: end };
}

function checkChunk(chunk, sequence, sourceDurationMs) {
  if (!chunk || Number(chunk.sequence) !== sequence) throw codedError('TRANSCRIPT_CHUNK_MISSING');
  if (!Number.isSafeInteger(Number(chunk.startMs)) || !Number.isSafeInteger(Number(chunk.endMs)) || Number(chunk.endMs) <= Number(chunk.startMs)) throw codedError('TRANSCRIPT_CHUNK_TIME_INVALID');
  if (Number(chunk.startMs) < 0 || Number(chunk.endMs) > sourceDurationMs) throw codedError('TRANSCRIPT_CHUNK_OUT_OF_BOUNDS');
  if (!Array.isArray(chunk.segments)) throw codedError('TRANSCRIPT_CHUNK_RESULT_INVALID');
}

export function stitchTranscriptChunks({ transcriptId, sourceRevision, sourceDurationMs, expectedChunkCount, chunks } = {}) {
  const duration = Number(sourceDurationMs);
  if (!Number.isSafeInteger(duration) || duration <= 0) throw codedError('TRANSCRIPT_SOURCE_DURATION_INVALID');
  if (!Array.isArray(chunks)) throw codedError('TRANSCRIPT_CHUNKS_REQUIRED');
  const ordered = [...chunks].sort((left, right) => Number(left?.sequence) - Number(right?.sequence));
  if (expectedChunkCount !== undefined) {
    const expected = Number(expectedChunkCount);
    if (!Number.isSafeInteger(expected) || expected < 1 || ordered.length !== expected) throw codedError('TRANSCRIPT_CHUNK_MISSING');
    for (let sequence = 0; sequence < expected; sequence += 1) checkChunk(ordered[sequence], sequence, duration);
  } else {
    ordered.forEach((chunk, index) => checkChunk(chunk, index, duration));
  }

  const stitched = [];
  let lastEndMs = 0;
  for (const chunk of ordered) {
    for (const rawSegment of chunk.segments) {
      const text = String(rawSegment?.text ?? '').trim();
      if (!text) continue;
      const bounds = absoluteBounds(chunk, rawSegment);
      if (bounds.startMs < 0 || bounds.endMs > duration || bounds.endMs <= bounds.startMs) throw codedError('TRANSCRIPT_SEGMENT_TIME_INVALID');
      const refs = [...new Set([
        ...(Array.isArray(chunk.sourceChunkRefs) ? chunk.sourceChunkRefs : []),
        ...(Array.isArray(rawSegment.sourceChunkRefs) ? rawSegment.sourceChunkRefs : [])
      ].map((value) => String(value || '').trim()).filter(Boolean))];
      if (!refs.length) throw codedError('TRANSCRIPT_SOURCE_CHUNK_REF_REQUIRED');
      const confidence = rawSegment.confidence === undefined || rawSegment.confidence === null ? null : Number(rawSegment.confidence);
      if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) throw codedError('TRANSCRIPT_CONFIDENCE_INVALID');
      const candidate = { ...bounds, text, confidence, sourceChunkRefs: refs };
      const previous = stitched.at(-1);
      if (previous) {
        const sameText = normalizedText(previous.text) === normalizedText(candidate.text);
        if (sameText && candidate.startMs < previous.endMs) continue;
        if (candidate.startMs < previous.endMs) {
          const reduced = removeTextOverlap(previous.text, candidate.text).trim();
          if (!reduced || normalizedText(reduced) === normalizedText(previous.text)) continue;
          candidate.text = reduced;
          candidate.startMs = previous.endMs;
          if (candidate.endMs <= candidate.startMs) continue;
        }
      }
      if (candidate.startMs < lastEndMs) throw codedError('TRANSCRIPT_SEGMENT_TIME_NOT_MONOTONIC');
      stitched.push(candidate);
      lastEndMs = candidate.endMs;
    }
  }

  const segments = stitched.map((value, sequence) => createTranscriptSegment({
    transcriptId,
    transcriptRevision: 1,
    revision: 1,
    segmentId: undefined,
    sequence,
    startMs: value.startMs,
    endMs: value.endMs,
    text: value.text,
    confidence: value.confidence,
    speakerRef: null,
    sourceChunkRefs: value.sourceChunkRefs
  }));
  for (let index = 0; index < segments.length; index += 1) {
    const check = validateTranscriptSegment(segments[index], { transcriptId, revision: 1, previousEndMs: index ? segments[index - 1].endMs : 0 });
    if (!check.valid) throw codedError(check.errors[0], check.errors);
  }
  return Object.freeze({
    transcriptId,
    sourceRevision: Number(sourceRevision),
    segments,
    coverageEndMs: segments.at(-1)?.endMs || 0,
    segmentCount: segments.length
  });
}

export { codedError };
