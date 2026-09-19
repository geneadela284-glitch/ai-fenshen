export const CONTINUOUS_FRAGMENT_STREAM_V1 = 'continuous-fragment-stream-v1';
export const INDEPENDENT_MP4_SEGMENTS_V1 = 'independent-mp4-segments-v1';
export const ROTATING_INDEPENDENT_MP4_MODE = 'rotating-independent-mp4';
export const IOS_AAC_CAPTURE_UNIT_MS = 12_000;
export const MAX_SEALED_UNCOMMITTED_UNITS = 3;
export const MAX_JOURNAL_WRITE_ATTEMPTS = 2;

const RECORDED_LAYOUTS = new Set([
  CONTINUOUS_FRAGMENT_STREAM_V1,
  INDEPENDENT_MP4_SEGMENTS_V1
]);

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function resolveRecordedContainerLayout(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return CONTINUOUS_FRAGMENT_STREAM_V1;
  if (!RECORDED_LAYOUTS.has(normalized)) throw codedError('AUDIO_CONTAINER_LAYOUT_UNSUPPORTED');
  return normalized;
}
