const MEETING_SOURCE_DURATION_DRIFT_MIN_TOLERANCE_MS = 250;
const MEETING_SOURCE_DURATION_DRIFT_MAX_RATIO = 0.005;
const MEETING_AAC_MP4_POSITIVE_DRIFT_TOLERANCE_MS = 1_500;

function isAacMp4Source(source = {}) {
  const format = String(source.format || '').trim().toLowerCase();
  const mimeType = String(source.mimeType || '').trim().toLowerCase();
  return format === 'm4a'
    && (mimeType.includes('audio/mp4') || mimeType.includes('audio/m4a'))
    && (mimeType.includes('mp4a.40.2') || mimeType.includes('aac') || mimeType.includes('audio/mp4'));
}

function transcriptCoverageEnd(transcriptRevision) {
  if (!Array.isArray(transcriptRevision?.segments) || transcriptRevision.segments.length === 0) return null;
  let coverageEndMs = 0;
  for (const segment of transcriptRevision.segments) {
    const endMs = Number(segment?.endMs);
    if (!Number.isSafeInteger(endMs) || endMs <= 0) return null;
    coverageEndMs = Math.max(coverageEndMs, endMs);
  }
  return coverageEndMs;
}

/**
 * Projects a bounded decoder timeline drift for Stage4 validation only.
 * The persisted AudioSource and TranscriptRevision remain untouched.
 */
export function resolveMeetingAnalysisSource(source, transcriptRevision) {
  if (!source || typeof source !== 'object') return source;
  const declaredDurationMs = Number(source.durationMs);
  const coverageEndMs = transcriptCoverageEnd(transcriptRevision);
  if (!Number.isSafeInteger(declaredDurationMs) || declaredDurationMs <= 0
    || coverageEndMs === null || coverageEndMs <= declaredDurationMs) {
    return source;
  }

  const durationDifferenceMs = coverageEndMs - declaredDurationMs;
  const toleranceMs = isAacMp4Source(source)
    ? MEETING_AAC_MP4_POSITIVE_DRIFT_TOLERANCE_MS
    : Math.max(
      MEETING_SOURCE_DURATION_DRIFT_MIN_TOLERANCE_MS,
      coverageEndMs * MEETING_SOURCE_DURATION_DRIFT_MAX_RATIO
    );
  if (durationDifferenceMs > toleranceMs) return source;

  return Object.freeze({
    ...source,
    durationMs: coverageEndMs,
    ...(Number.isSafeInteger(Number(source.committedDurationMs))
      ? { committedDurationMs: Math.max(Number(source.committedDurationMs), coverageEndMs) }
      : {})
  });
}
