function hasPlayableAudioSource(source) {
  return Boolean(
    source
    && source.origin !== 'unavailable'
    && String(source.meetingId || '').trim()
    && String(source.sourceId || '').trim()
  );
}

function hasTranscriptSegments(transcript) {
  return Array.isArray(transcript?.currentRevision?.segments)
    && transcript.currentRevision.segments.length > 0;
}

export function resolveStage3cPlaybackDependency({ source = null, transcript = null, playback = null } = {}) {
  const transcriptState = hasTranscriptSegments(transcript) ? 'available' : 'unavailable';
  if (!hasPlayableAudioSource(source)) {
    return Object.freeze({ mode: 'readable-only', reason: 'AUDIO_SOURCE_UNAVAILABLE', transcript: transcriptState });
  }
  if (typeof playback?.createSession !== 'function') {
    return Object.freeze({ mode: 'readable-only', reason: 'PLAYBACK_UNSUPPORTED', transcript: transcriptState });
  }
  return Object.freeze({ mode: 'playback-ready', transcript: transcriptState });
}

export { hasPlayableAudioSource, hasTranscriptSegments };
