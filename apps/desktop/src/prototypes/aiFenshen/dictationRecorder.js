export const DICTATION_AUDIO_FORMAT = 'audio/wav';
export const DICTATION_SAMPLE_RATE = 16_000;
export const DICTATION_CHANNELS = 1;
export const DICTATION_BITS_PER_SAMPLE = 16;
export const DICTATION_MAX_DURATION_MS = 30_000;
export const DICTATION_MAX_BYTES = 8 * 1024 * 1024;

function recorderError(code, message = code) {
  return Object.assign(new Error(message), { code, name: 'DictationRecorderError' });
}

export function downsampleMonoFloat32(input, inputSampleRate, outputSampleRate = DICTATION_SAMPLE_RATE) {
  const source = input instanceof Float32Array ? input : Float32Array.from(input || []);
  const inputRate = Number(inputSampleRate);
  const outputRate = Number(outputSampleRate);
  if (!source.length || !Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate <= 0 || outputRate <= 0) {
    throw recorderError('AUDIO_INVALID');
  }
  if (inputRate === outputRate) return new Float32Array(source);
  if (inputRate < outputRate) throw recorderError('AUDIO_INVALID');
  const ratio = inputRate / outputRate;
  const outputLength = Math.max(1, Math.floor(source.length / ratio));
  const output = new Float32Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.min(source.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let total = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) total += source[sourceIndex];
    output[index] = total / Math.max(1, end - start);
  }
  return output;
}

export function encodePcm16Wav(samples, sampleRate = DICTATION_SAMPLE_RATE) {
  const source = samples instanceof Float32Array ? samples : Float32Array.from(samples || []);
  if (!source.length || sampleRate !== DICTATION_SAMPLE_RATE) throw recorderError('AUDIO_INVALID');
  const bytesPerSample = DICTATION_BITS_PER_SAMPLE / 8;
  const dataLength = source.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeAscii = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, DICTATION_CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, DICTATION_BITS_PER_SAMPLE, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);
  for (let index = 0; index < source.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, Number(source[index]) || 0));
    const encoded = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    view.setInt16(44 + (index * bytesPerSample), Math.round(encoded), true);
  }
  return buffer;
}

function defaultAudioContextClass() {
  return globalThis.AudioContext || globalThis.webkitAudioContext || null;
}

function closeStream(stream) {
  stream?.getTracks?.().forEach((track) => {
    try { track.stop(); } catch { /* The browser may already have released the track. */ }
  });
}

export function createDictationRecorder({
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextClass = defaultAudioContextClass(),
  maxDurationMs = DICTATION_MAX_DURATION_MS,
  maxBytes = DICTATION_MAX_BYTES,
  onAudioReady = () => {},
  onStateChange = () => {},
  onError = () => {},
  onProgress = () => {}
} = {}) {
  let state = 'idle';
  let stream = null;
  let context = null;
  let source = null;
  let processor = null;
  let sink = null;
  let durationTimer = null;
  let progressTimer = null;
  let recordingStartedAt = 0;
  let recordedSampleCount = 0;
  let starting = false;
  let cancelled = false;
  let samples = [];

  const setState = (next) => {
    state = next;
    onStateChange(next);
  };

  const clearTimer = () => {
    if (durationTimer) clearTimeout(durationTimer);
    if (progressTimer) clearInterval(progressTimer);
    durationTimer = null;
    progressTimer = null;
    recordingStartedAt = 0;
  };

  const releaseAudio = () => {
    clearTimer();
    try { processor?.disconnect?.(); } catch { /* already disconnected */ }
    try { source?.disconnect?.(); } catch { /* already disconnected */ }
    try { sink?.disconnect?.(); } catch { /* already disconnected */ }
    closeStream(stream);
    void context?.close?.().catch?.(() => {});
    processor = null;
    source = null;
    sink = null;
    stream = null;
    context = null;
    recordedSampleCount = 0;
  };

  const fail = (code, message = code) => {
    releaseAudio();
    samples = [];
    setState(code);
    onError(recorderError(code, message));
  };

  const stop = () => {
    if (state === 'requesting_permission') {
      cancelled = true;
      releaseAudio();
      setState('cancelled');
      return false;
    }
    if (state !== 'recording') return false;
    const recorded = samples;
    const inputSampleRate = context?.sampleRate || DICTATION_SAMPLE_RATE;
    samples = [];
    releaseAudio();
    if (!recorded.length) {
      fail('audio_invalid', '没有采集到有效音频。');
      return false;
    }
    try {
      const nativeSamples = new Float32Array(recorded.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of recorded) {
        nativeSamples.set(chunk, offset);
        offset += chunk.length;
      }
      const resampled = downsampleMonoFloat32(nativeSamples, inputSampleRate);
      const wavBuffer = encodePcm16Wav(resampled);
      const blob = new Blob([wavBuffer], { type: DICTATION_AUDIO_FORMAT });
      const durationMs = Math.round((resampled.length / DICTATION_SAMPLE_RATE) * 1_000);
      if (!blob.size || blob.size > maxBytes || !durationMs) {
        fail('audio_invalid', '录音格式无效，请重新录制。');
        return false;
      }
      setState('processing');
      onAudioReady({
        blob,
        durationMs,
        format: DICTATION_AUDIO_FORMAT,
        sampleRate: DICTATION_SAMPLE_RATE,
        channels: DICTATION_CHANNELS,
        bitsPerSample: DICTATION_BITS_PER_SAMPLE
      });
      return true;
    } catch (error) {
      fail('audio_invalid', error?.message || '录音格式无效，请重新录制。');
      return false;
    }
  };

  const start = async () => {
    if (starting || state === 'recording' || state === 'processing') return false;
    if (!mediaDevices?.getUserMedia || !AudioContextClass) {
      fail('recording_failed', '当前设备不支持语音录入。');
      return false;
    }
    starting = true;
    cancelled = false;
    samples = [];
    setState('requesting_permission');
    try {
      stream = await mediaDevices.getUserMedia({
        audio: {
          channelCount: DICTATION_CHANNELS,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      if (cancelled) {
        releaseAudio();
        setState('cancelled');
        return false;
      }
      context = new AudioContextClass();
      await context.resume?.();
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor?.(4096, 1, 1);
      if (!processor) throw recorderError('recording_failed', '当前设备不支持语音录入。');
      processor.onaudioprocess = (event) => {
        if (state !== 'recording') return;
        const channel = event.inputBuffer?.getChannelData?.(0);
        if (!channel?.length) return;
        const copy = new Float32Array(channel);
        samples.push(copy);
        recordedSampleCount += copy.length;
        let sumSquares = 0;
        for (const sample of copy) sumSquares += sample * sample;
        const level = Math.min(1, Math.sqrt(sumSquares / copy.length) * 3.2);
        onProgress({
          durationMs: Math.min(maxDurationMs, Math.round((recordedSampleCount / (context?.sampleRate || DICTATION_SAMPLE_RATE)) * 1_000)),
          level
        });
      };
      if (context.createGain) {
        sink = context.createGain();
        sink.gain.value = 0;
        source.connect(processor);
        processor.connect(sink);
        sink.connect(context.destination);
      } else {
        source.connect(processor);
        processor.connect(context.destination);
      }
      setState('recording');
      recordingStartedAt = Date.now();
      onProgress({ durationMs: 0, level: 0 });
      progressTimer = setInterval(() => {
        onProgress({
          durationMs: Math.min(maxDurationMs, Date.now() - recordingStartedAt),
          level: 0
        });
      }, 100);
      durationTimer = setTimeout(stop, maxDurationMs);
      return true;
    } catch (error) {
      releaseAudio();
      const denied = ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name);
      setState(denied ? 'permission_denied' : 'recording_failed');
      onError(recorderError(
        denied ? 'permission_denied' : 'recording_failed',
        denied ? '请允许麦克风权限后重试。' : '录音启动失败，请重试。'
      ));
      return false;
    } finally {
      starting = false;
    }
  };

  const cancel = () => {
    cancelled = true;
    samples = [];
    releaseAudio();
    setState('cancelled');
    return true;
  };

  return Object.freeze({
    start,
    stop,
    cancel,
    get active() {
      return starting || state === 'recording' || state === 'requesting_permission';
    },
    get state() { return state; }
  });
}
