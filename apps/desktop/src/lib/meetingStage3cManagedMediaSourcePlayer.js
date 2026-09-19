function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw codedError('PLAYBACK_BYTES_INVALID');
}

function bufferedContains(buffered, targetSeconds, toleranceSeconds = 0.25) {
  if (!buffered || !Number.isFinite(buffered.length)) return false;
  for (let index = 0; index < buffered.length; index += 1) {
    try {
      const start = Number(buffered.start(index));
      const end = Number(buffered.end(index));
      if (Number.isFinite(start) && Number.isFinite(end) && targetSeconds >= start - toleranceSeconds && targetSeconds <= end + toleranceSeconds) {
        return true;
      }
    } catch {
      // A range may disappear while the previous window is being detached.
    }
  }
  return false;
}

function waitForEvent(target, names, timeoutMs) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      for (const name of names) target.removeEventListener(name, onEvent);
      if (timer) clearTimeout(timer);
    };
    cancel = () => {
      cleanup();
      reject(codedError('PLAYBACK_APPEND_CANCELLED'));
    };
    const onEvent = (event) => {
      cleanup();
      if (event.type === 'error' || event.type === 'abort') reject(codedError('PLAYBACK_APPEND_FAILED'));
      else resolve(event);
    };
    for (const name of names) target.addEventListener(name, onEvent, { once: false });
    timer = setTimeout(() => {
      cleanup();
      reject(codedError('PLAYBACK_OPERATION_TIMEOUT'));
    }, timeoutMs);
  });
  promise.cancel = cancel;
  return promise;
}

function constructorFor(capability, globalObject) {
  const Constructor = capability?.engine === 'managed-media-source' ? globalObject.ManagedMediaSource : globalObject.MediaSource;
  if (typeof Constructor !== 'function') throw codedError('PLAYBACK_UNSUPPORTED');
  return Constructor;
}

function playbackRejectionCode(cause) {
  if (cause?.name === 'NotAllowedError' || cause?.code === 'PLAYBACK_USER_GESTURE_REQUIRED') {
    return 'PLAYBACK_USER_GESTURE_REQUIRED';
  }
  if (cause?.name === 'AbortError' || cause?.code === 'PLAYBACK_PLAY_ABORTED') {
    return 'PLAYBACK_PLAY_ABORTED';
  }
  return 'PLAYBACK_PLAY_FAILED';
}

function seekToBufferedTarget({ audio, sourceBuffer, targetMs, timeoutMs }) {
  const targetSeconds = Number(targetMs) / 1_000;
  if (!Number.isFinite(targetSeconds) || targetSeconds < 0) throw codedError('PLAYBACK_SEEK_TARGET_INVALID');
  if (!bufferedContains(sourceBuffer?.buffered, targetSeconds) && !bufferedContains(audio?.buffered, targetSeconds)) {
    throw codedError('PLAYBACK_TARGET_NOT_BUFFERED');
  }

  return new Promise((resolve, reject) => {
    let timer = null;
    const toleranceSeconds = 0.25;
    const cleanup = () => {
      for (const name of ['seeked', 'timeupdate', 'canplay', 'error', 'abort']) audio.removeEventListener?.(name, onEvent);
      if (timer) clearTimeout(timer);
    };
    const settle = () => {
      const current = Number(audio.currentTime);
      if (!audio.seeking && Number.isFinite(current) && Math.abs(current - targetSeconds) <= toleranceSeconds) {
        cleanup();
        resolve();
        return true;
      }
      return false;
    };
    const onEvent = (event) => {
      if (event.type === 'error' || event.type === 'abort') {
        cleanup();
        reject(codedError('PLAYBACK_SEEK_FAILED', event));
        return;
      }
      settle();
    };
    for (const name of ['seeked', 'timeupdate', 'canplay', 'error', 'abort']) audio.addEventListener?.(name, onEvent, { once: false });
    timer = setTimeout(() => {
      cleanup();
      reject(codedError('PLAYBACK_OPERATION_TIMEOUT'));
    }, timeoutMs);
    try {
      audio.currentTime = targetSeconds;
      settle();
    } catch (cause) {
      cleanup();
      reject(codedError('PLAYBACK_SEEK_FAILED', cause));
    }
  });
}

export function createStage3cManagedMediaSourcePlayer({
  globalObject = globalThis,
  audioElementFactory,
  capability,
  URLImpl = globalObject.URL,
  operationTimeoutMs = 5_000
} = {}) {
  if (!capability?.supported) throw codedError(capability?.errorCode || 'PLAYBACK_UNSUPPORTED');
  const makeAudio = audioElementFactory || (() => globalObject.document?.createElement?.('audio'));
  const audio = makeAudio();
  if (!audio) throw codedError('PLAYBACK_AUDIO_ELEMENT_UNAVAILABLE');
  const Constructor = constructorFor(capability, globalObject);
  let session = null;
  let audioPlayCalls = 0;

  const snapshot = () => Object.freeze({
    activeResources: session ? 3 : 0,
    activeUrls: session ? 1 : 0,
    mediaChunkCount: session?.mediaChunkCount || 0,
    audioPlayCalls,
    requiresUserGesture: Boolean(session?.requiresUserGesture),
    finalActiveResources: session ? null : 0
  });

  async function dispose() {
    const current = session;
    session = null;
    if (!current) return;
    try { audio.pause?.(); } catch { /* cleanup continues */ }
    try { if (current.sourceBuffer?.updating) current.sourceBuffer.abort?.(); } catch { /* cleanup continues */ }
    try { current.mediaSource?.endOfStream?.(); } catch { /* cleanup continues */ }
    try { audio.removeAttribute?.('src'); audio.load?.(); } catch { /* cleanup continues */ }
    try { URLImpl?.revokeObjectURL?.(current.url); } catch { /* cleanup continues */ }
  }

  async function append(sourceBuffer, bytes) {
    const value = asBytes(bytes);
    if (!value.byteLength) return;
    let eventPromise;
    try {
      eventPromise = waitForEvent(sourceBuffer, ['updateend', 'error', 'abort'], operationTimeoutMs);
      sourceBuffer.appendBuffer(value);
    } catch (cause) {
      eventPromise?.cancel?.();
      eventPromise?.catch?.(() => {});
      throw codedError('PLAYBACK_APPEND_FAILED', cause);
    }
    await eventPromise;
  }

  async function loadWindow({ mimeType, initBytes = new Uint8Array(), mediaChunks, targetMs = 0, autoplay = false } = {}) {
    if (String(mimeType || '') !== capability.mimeType) throw codedError('PLAYBACK_MIME_UNSUPPORTED');
    if (!Array.isArray(mediaChunks) || mediaChunks.length < 1 || mediaChunks.length > 3) throw codedError('PLAYBACK_WINDOW_LIMIT_INVALID');
    await dispose();
    const mediaSource = new Constructor();
    const url = URLImpl?.createObjectURL?.(mediaSource);
    if (!url) throw codedError('PLAYBACK_OBJECT_URL_FAILED');
    const next = { mediaSource, url, sourceBuffer: null, mediaChunkCount: mediaChunks.length, requiresUserGesture: false };
    session = next;
    try {
      if ('disableRemotePlayback' in audio) audio.disableRemotePlayback = true;
      audio.src = url;
      audio.setAttribute?.('src', url);
      if (mediaSource.readyState !== 'open') await waitForEvent(mediaSource, ['sourceopen', 'error'], operationTimeoutMs);
      try { next.sourceBuffer = mediaSource.addSourceBuffer(mimeType); } catch (cause) { throw codedError('PLAYBACK_APPEND_FAILED', cause); }
      await append(next.sourceBuffer, initBytes);
      for (const chunk of mediaChunks) await append(next.sourceBuffer, chunk.bytes || chunk);
      await seekToBufferedTarget({ audio, sourceBuffer: next.sourceBuffer, targetMs, timeoutMs: operationTimeoutMs });
      let playFailure = null;
      if (autoplay) {
        audioPlayCalls += 1;
        try {
          await audio.play?.();
        } catch (cause) {
          playFailure = cause;
        }
      }
      if (playFailure) {
        const code = playbackRejectionCode(playFailure);
        if (code === 'PLAYBACK_USER_GESTURE_REQUIRED') {
          next.requiresUserGesture = true;
        } else {
          throw codedError(code, playFailure);
        }
      }
      return snapshot();
    } catch (error) {
      await dispose();
      throw error?.code ? error : codedError('PLAYBACK_APPEND_FAILED', error);
    }
  }

  async function play() {
    if (!session) throw codedError('PLAYBACK_NOT_OPEN');
    try {
      await audio.play?.();
      session.requiresUserGesture = false;
    } catch (cause) {
      throw codedError(playbackRejectionCode(cause), cause);
    }
  }

  async function pause() {
    if (!session) return;
    audio.pause?.();
  }

  return Object.freeze({
    audio,
    loadWindow,
    play,
    pause,
    dispose,
    getSnapshot: snapshot
  });
}
