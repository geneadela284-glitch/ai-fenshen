const DEFAULT_SAMPLE_INTERVAL_MS = 125;
const MIN_SAMPLE_INTERVAL_MS = 100;
const DEFAULT_HISTORY_SIZE = 8;

function frozenSnapshot(available, level, bars) {
  return Object.freeze({
    available,
    level,
    bars: Object.freeze([...bars])
  });
}

function clamp(value) {
  return Math.min(1, Math.max(0, value));
}

function measuredRms(samples) {
  if (!samples.length) return 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const normalized = (sample - 128) / 128;
    sumSquares += normalized * normalized;
  }
  return clamp(Number(Math.sqrt(sumSquares / samples.length).toFixed(6)));
}

export function createMeetingStage3cMicrophoneMeter({
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
  setIntervalImpl = globalThis.setInterval,
  clearIntervalImpl = globalThis.clearInterval,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  historySize = DEFAULT_HISTORY_SIZE
} = {}) {
  if (typeof mediaDevices?.getUserMedia !== 'function') {
    throw new TypeError('mediaDevices.getUserMedia is required');
  }

  const intervalMs = Math.max(MIN_SAMPLE_INTERVAL_MS, Number(sampleIntervalMs) || DEFAULT_SAMPLE_INTERVAL_MS);
  const maximumHistory = Math.max(1, Math.floor(Number(historySize) || DEFAULT_HISTORY_SIZE));
  let context = null;
  let source = null;
  let analyser = null;
  let sampleTimer = null;
  let analysisGeneration = 0;
  let disposed = false;
  let snapshot = frozenSnapshot(false, 0, []);
  const listeners = new Set();

  function publish(next) {
    snapshot = next;
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // A display observer cannot affect microphone capture.
      }
    }
  }

  async function cleanup(generation, forcePublish = false) {
    if (sampleTimer !== null) {
      clearIntervalImpl(sampleTimer);
      sampleTimer = null;
    }
    try {
      source?.disconnect?.();
    } catch {
      // WebAudio cleanup is best-effort.
    }
    try {
      analyser?.disconnect?.();
    } catch {
      // WebAudio cleanup is best-effort.
    }
    const closingContext = context;
    source = null;
    analyser = null;
    context = null;
    try {
      await closingContext?.close?.();
    } catch {
      // A failed close must not affect Recorder ownership of the stream.
    }
    if (forcePublish || generation === analysisGeneration) {
      publish(frozenSnapshot(false, 0, []));
    }
  }

  async function stop() {
    const generation = ++analysisGeneration;
    await cleanup(generation);
  }

  function sample() {
    if (!analyser) return;
    const samples = new Uint8Array(Math.max(1, analyser.fftSize || 256));
    try {
      analyser.getByteTimeDomainData(samples);
    } catch {
      return;
    }
    const level = measuredRms(samples);
    const bars = [...snapshot.bars, level].slice(-maximumHistory);
    publish(frozenSnapshot(true, level, bars));
  }

  async function observe(stream, generation) {
    if (disposed || generation !== analysisGeneration) return;
    if (typeof AudioContextImpl !== 'function') {
      publish(frozenSnapshot(false, 0, []));
      return;
    }
    try {
      context = new AudioContextImpl();
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      publish(frozenSnapshot(true, 0, []));
      sampleTimer = setIntervalImpl(sample, intervalMs);
    } catch {
      await cleanup(generation);
    }
  }

  const decoratedMediaDevices = Object.freeze({
    async getUserMedia(constraints) {
      if (disposed) throw new TypeError('microphone meter is disposed');
      const generation = ++analysisGeneration;
      await cleanup(generation);
      let stream;
      try {
        stream = await mediaDevices.getUserMedia.call(mediaDevices, constraints);
      } catch (error) {
        if (generation === analysisGeneration) await cleanup(generation);
        throw error;
      }
      await observe(stream, generation);
      return stream;
    }
  });

  return Object.freeze({
    mediaDevices: decoratedMediaDevices,
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('meter listener is required');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop,
    async dispose() {
      if (disposed) return;
      disposed = true;
      const generation = ++analysisGeneration;
      listeners.clear();
      await cleanup(generation, true);
    }
  });
}
