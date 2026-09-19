// Read-only technical evidence. Never inspect device IDs, labels or samples,
// change track state, or use a diagnostic failure to control the recorder.
export const MEETING_INPUT_DIAGNOSTIC_MARKER = 'meeting-input-diagnostic-20260907-s3';

function audioTracks(stream) {
  if (typeof stream?.getAudioTracks === 'function') return stream.getAudioTracks();
  return (stream?.getTracks?.() || []).filter(track => track.kind === 'audio');
}

export function snapshotMeetingRecorderInput(stream, documentImpl = globalThis.document) {
  let visibilityState = 'unknown';
  try {
    if (['visible', 'hidden', 'prerender'].includes(documentImpl?.visibilityState)) {
      visibilityState = documentImpl.visibilityState;
    }
  } catch { /* Unavailable browser metadata remains unknown. */ }
  try {
    const tracks = audioTracks(stream);
    return Object.freeze({
      visibilityState,
      inputStateKnown: typeof stream?.active === 'boolean' && tracks.every(track => (
        ['live', 'ended'].includes(track.readyState)
        && typeof track.enabled === 'boolean' && typeof track.muted === 'boolean'
      )),
      ...(typeof stream?.active === 'boolean' ? { inputStreamActive: stream.active } : {}),
      audioTrackCount: tracks.length,
      audioLiveTrackCount: tracks.filter(track => track.readyState === 'live').length,
      audioEnabledTrackCount: tracks.filter(track => track.enabled === true).length,
      audioMutedTrackCount: tracks.filter(track => track.muted === true).length
    });
  } catch {
    return Object.freeze({ visibilityState, inputStateKnown: false });
  }
}

export function observeMeetingRecorderInput(stream, onEvent, documentImpl = globalThis.document) {
  const removers = [];
  function listen(target, type, event) {
    try {
      if (typeof target?.addEventListener !== 'function' || typeof target?.removeEventListener !== 'function') return;
      const listener = () => {
        try { onEvent(event); } catch { /* Observers cannot interrupt capture. */ }
      };
      target.addEventListener(type, listener);
      removers.push(() => target.removeEventListener(type, listener));
    } catch { /* Unsupported diagnostic events do not block recording. */ }
  }
  try {
    for (const track of audioTracks(stream)) {
      listen(track, 'mute', 'capture_input_muted');
      listen(track, 'unmute', 'capture_input_unmuted');
      listen(track, 'ended', 'capture_input_ended');
    }
  } catch { /* Snapshot records unknown state if input is inaccessible. */ }
  listen(documentImpl, 'visibilitychange', 'capture_input_visibility_changed');
  return () => {
    for (const remove of removers.splice(0)) {
      try { remove(); } catch { /* Best-effort diagnostic listener cleanup. */ }
    }
  };
}
