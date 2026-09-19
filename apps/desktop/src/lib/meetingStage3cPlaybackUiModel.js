const ERROR_COPY = Object.freeze({
  AUDIO_SOURCE_UNAVAILABLE: '当前录音暂不支持原音回放',
  PLAYBACK_SOURCE_BOUNDARY_UNVERIFIED: '当前录音暂不支持原音回放',
  PLAYBACK_UNSUPPORTED: '当前录音暂不支持原音回放',
  PLAYBACK_MIME_UNSUPPORTED: '当前录音暂不支持原音回放',
  PLAYBACK_INIT_SEGMENT_UNAVAILABLE: '当前录音暂不支持原音回放',
  PLAYBACK_BINDING_MISMATCH: '当前录音与转写版本不一致，已停止联动。'
});

export function formatStage3cPlaybackTime(valueMs = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(valueMs || 0) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export function clampStage3cPlaybackTime(valueMs, durationMs) {
  const duration = Math.max(0, Number(durationMs || 0));
  const value = Number(valueMs);
  const bounded = Math.max(0, Math.min(duration, Number.isFinite(value) ? value : 0));
  if (duration <= 0 || bounded < duration) return bounded;
  return Math.max(0, duration - Math.min(500, duration));
}

export function stage3cPlaybackErrorMessage(error) {
  const code = String(error?.code || error?.message || '');
  return ERROR_COPY[code] || '原音回放暂时不可用，转写内容仍可阅读。';
}

export function stage3cSpeakerLabel(segment) {
  const raw = String(segment?.effectiveSpeaker?.displayLabel || segment?.effectiveSpeaker?.label || segment?.effectiveSpeaker?.speakerId || segment?.speakerRef || '').trim();
  const anonymous = raw.match(/^speaker-(\d+)$/i);
  if (anonymous) return `说话人 ${Number(anonymous[1])}`;
  if (!raw || /^(unknown|anonymous|未标注)$/i.test(raw)) return '未标注发言人';
  return raw;
}

export function stage3cPlaybackWindowLimit(value) {
  return Math.max(1, Math.min(200, Number.isSafeInteger(value) ? value : 200));
}
