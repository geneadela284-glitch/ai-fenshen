export const MEETING_RECORDING_CODEC_EXPERIMENT_KEY = 'meetingRecordingCodecExperiment';
export const AAC_MP4_EXPERIMENT = 'aac-mp4';
export const AAC_MP4_MIME_TYPES = Object.freeze([
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4'
]);

function browserSessionStorage() {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
}

function storageValue(storage) {
  return storage === undefined ? browserSessionStorage() : storage;
}

export function getMeetingRecordingCodecExperiment({ storage } = {}) {
  try {
    return storageValue(storage)?.getItem?.(MEETING_RECORDING_CODEC_EXPERIMENT_KEY) === AAC_MP4_EXPERIMENT
      ? AAC_MP4_EXPERIMENT
      : '';
  } catch {
    return '';
  }
}

export function setMeetingRecordingCodecExperiment({ storage } = {}, value = AAC_MP4_EXPERIMENT) {
  if (String(value || '').trim() !== AAC_MP4_EXPERIMENT) return false;
  try {
    const target = storageValue(storage);
    if (!target?.setItem) return false;
    target.setItem(MEETING_RECORDING_CODEC_EXPERIMENT_KEY, AAC_MP4_EXPERIMENT);
    return target.getItem?.(MEETING_RECORDING_CODEC_EXPERIMENT_KEY) === AAC_MP4_EXPERIMENT;
  } catch {
    return false;
  }
}

export function isAacMp4MimeType(mimeType = '') {
  const normalized = String(mimeType || '').trim().toLowerCase();
  return AAC_MP4_MIME_TYPES.some((candidate) => candidate.toLowerCase() === normalized);
}

export function describeRecordingMimeType(mimeType = '') {
  const normalized = String(mimeType || '').trim();
  const lower = normalized.toLowerCase();
  if (isAacMp4MimeType(normalized)) return Object.freeze({ mimeType: normalized, container: 'MP4', codec: 'AAC' });
  if (lower.startsWith('audio/webm')) return Object.freeze({ mimeType: normalized, container: 'WebM', codec: 'Opus' });
  if (lower.startsWith('audio/ogg') || lower.startsWith('application/ogg')) return Object.freeze({ mimeType: normalized, container: 'Ogg', codec: 'Opus' });
  if (lower.startsWith('audio/wav') || lower.startsWith('audio/wave')) return Object.freeze({ mimeType: normalized, container: 'WAV', codec: 'PCM' });
  return Object.freeze({ mimeType: normalized, container: 'unknown', codec: 'unknown' });
}
