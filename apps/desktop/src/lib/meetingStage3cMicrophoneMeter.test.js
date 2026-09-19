import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createMeetingStage3cMicrophoneMeter } from './meetingStage3cMicrophoneMeter.js';

class FakeAnalyser {
  constructor(samples) {
    this.samples = samples;
    this.fftSize = 8;
    this.disconnected = false;
  }

  getByteTimeDomainData(target) {
    for (let index = 0; index < target.length; index += 1) {
      target[index] = this.samples[index % this.samples.length];
    }
  }

  disconnect() {
    this.disconnected = true;
  }
}

class FakeSource {
  constructor() {
    this.connections = [];
    this.disconnected = false;
  }

  connect(target) {
    this.connections.push(target);
  }

  disconnect() {
    this.disconnected = true;
  }
}

function audioHarness(samples = new Uint8Array(8).fill(128)) {
  const contexts = [];
  class FakeAudioContext {
    constructor() {
      this.destination = { kind: 'audio-destination' };
      this.analyser = new FakeAnalyser(samples);
      this.source = new FakeSource();
      this.closed = false;
      contexts.push(this);
    }

    createMediaStreamSource(stream) {
      this.observedStream = stream;
      return this.source;
    }

    createAnalyser() {
      return this.analyser;
    }

    async close() {
      this.closed = true;
    }
  }
  return { AudioContextImpl: FakeAudioContext, contexts };
}

function timerHarness() {
  const callbacks = new Map();
  let nextId = 1;
  const delays = [];
  return {
    delays,
    setIntervalImpl(callback, delay) {
      const id = nextId++;
      callbacks.set(id, callback);
      delays.push(delay);
      return id;
    },
    clearIntervalImpl(id) {
      callbacks.delete(id);
    },
    tick() {
      for (const callback of [...callbacks.values()]) callback();
    },
    get activeCount() {
      return callbacks.size;
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('meter calls the underlying getUserMedia once, observes that stream, and returns its identity without routing audio to destination', async () => {
  const stream = { id: 'exact-recorder-stream' };
  let calls = 0;
  const mediaDevices = {
    async getUserMedia(constraints) {
      calls += 1;
      assert.deepEqual(constraints, { audio: true });
      return stream;
    }
  };
  const audio = audioHarness();
  const timers = timerHarness();
  const meter = createMeetingStage3cMicrophoneMeter({
    mediaDevices,
    AudioContextImpl: audio.AudioContextImpl,
    ...timers
  });

  const returned = await meter.mediaDevices.getUserMedia({ audio: true });

  assert.equal(calls, 1);
  assert.equal(returned, stream);
  assert.equal(audio.contexts[0].observedStream, stream);
  assert.deepEqual(audio.contexts[0].source.connections, [audio.contexts[0].analyser]);
  assert.equal(audio.contexts[0].source.connections.includes(audio.contexts[0].destination), false);
  assert.equal(timers.delays[0] >= 100, true);
  await meter.dispose();
});

test('meter computes deterministic bounded RMS and derives history only from measured samples', async () => {
  const audio = audioHarness(new Uint8Array(8).fill(128));
  const timers = timerHarness();
  const meter = createMeetingStage3cMicrophoneMeter({
    mediaDevices: { async getUserMedia() { return { id: 'stream' }; } },
    AudioContextImpl: audio.AudioContextImpl,
    historySize: 3,
    ...timers
  });
  await meter.mediaDevices.getUserMedia({ audio: true });

  timers.tick();
  assert.equal(meter.getSnapshot().level, 0);
  assert.deepEqual(meter.getSnapshot().bars, [0]);

  audio.contexts[0].analyser.samples = new Uint8Array([255, 1, 255, 1, 255, 1, 255, 1]);
  timers.tick();
  const measured = meter.getSnapshot();
  assert.equal(measured.level > 0, true);
  assert.equal(measured.level <= 1, true);
  assert.deepEqual(measured.bars, [0, measured.level]);

  audio.contexts[0].analyser.samples = new Uint8Array(8).fill(128);
  timers.tick();
  audio.contexts[0].analyser.samples = new Uint8Array(8).fill(255);
  timers.tick();
  const bounded = meter.getSnapshot();
  assert.deepEqual(bounded.bars, [measured.level, 0, bounded.level]);
  assert.equal(Object.isFrozen(bounded), true);
  assert.equal(Object.isFrozen(bounded.bars), true);
  await meter.dispose();
});

test('meter cleans all analysis resources on stop, restarts cleanly, and degrades without WebAudio', async () => {
  const audio = audioHarness();
  const timers = timerHarness();
  let streamOrdinal = 0;
  const meter = createMeetingStage3cMicrophoneMeter({
    mediaDevices: { async getUserMedia() { return { id: `stream-${++streamOrdinal}` }; } },
    AudioContextImpl: audio.AudioContextImpl,
    ...timers
  });
  await meter.mediaDevices.getUserMedia({ audio: true });
  const first = audio.contexts[0];
  await meter.stop();
  assert.equal(timers.activeCount, 0);
  assert.equal(first.source.disconnected, true);
  assert.equal(first.analyser.disconnected, true);
  assert.equal(first.closed, true);

  await meter.mediaDevices.getUserMedia({ audio: true });
  assert.equal(audio.contexts.length, 2);
  assert.equal(timers.activeCount, 1);
  await meter.dispose();
  assert.equal(audio.contexts[1].closed, true);

  const unavailable = createMeetingStage3cMicrophoneMeter({
    mediaDevices: { async getUserMedia() { return { id: 'still-recordable' }; } },
    AudioContextImpl: null,
    ...timerHarness()
  });
  assert.equal((await unavailable.mediaDevices.getUserMedia({ audio: true })).id, 'still-recordable');
  assert.deepEqual(unavailable.getSnapshot(), { available: false, level: 0, bars: [] });
});

test('meter cleans prior resources when getUserMedia or analysis startup fails', async () => {
  const audio = audioHarness();
  const timers = timerHarness();
  let calls = 0;
  const meter = createMeetingStage3cMicrophoneMeter({
    mediaDevices: {
      async getUserMedia() {
        calls += 1;
        if (calls === 2) throw new Error('permission denied');
        return { id: 'first' };
      }
    },
    AudioContextImpl: audio.AudioContextImpl,
    ...timers
  });
  await meter.mediaDevices.getUserMedia({ audio: true });
  const first = audio.contexts[0];
  await assert.rejects(meter.mediaDevices.getUserMedia({ audio: true }), /permission denied/);
  assert.equal(first.closed, true);
  assert.equal(timers.activeCount, 0);
  assert.deepEqual(meter.getSnapshot(), { available: false, level: 0, bars: [] });
});

test('dispose invalidates a pending acquisition so its late stream cannot resurrect analysis resources', async () => {
  const pending = deferred();
  const audio = audioHarness();
  const timers = timerHarness();
  let calls = 0;
  const meter = createMeetingStage3cMicrophoneMeter({
    mediaDevices: {
      async getUserMedia() {
        calls += 1;
        return pending.promise;
      }
    },
    AudioContextImpl: audio.AudioContextImpl,
    ...timers
  });

  const acquisition = meter.mediaDevices.getUserMedia({ audio: true });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);
  await meter.dispose();
  const stream = { id: 'late-after-dispose' };
  pending.resolve(stream);

  assert.equal(await acquisition, stream);
  assert.equal(audio.contexts.length, 0);
  assert.equal(timers.activeCount, 0);
  assert.deepEqual(meter.getSnapshot(), { available: false, level: 0, bars: [] });
});

test('only the newest concurrent acquisition may own analysis resources', async () => {
  const firstPending = deferred();
  const secondPending = deferred();
  const audio = audioHarness();
  const timers = timerHarness();
  let calls = 0;
  const meter = createMeetingStage3cMicrophoneMeter({
    mediaDevices: {
      async getUserMedia() {
        calls += 1;
        return calls === 1 ? firstPending.promise : secondPending.promise;
      }
    },
    AudioContextImpl: audio.AudioContextImpl,
    ...timers
  });

  const firstAcquisition = meter.mediaDevices.getUserMedia({ audio: true });
  await Promise.resolve();
  const secondAcquisition = meter.mediaDevices.getUserMedia({ audio: true });
  await Promise.resolve();
  const secondStream = { id: 'newest-stream' };
  secondPending.resolve(secondStream);
  assert.equal(await secondAcquisition, secondStream);
  assert.equal(audio.contexts.length, 1);
  assert.equal(audio.contexts[0].observedStream, secondStream);
  assert.equal(timers.activeCount, 1);

  const firstStream = { id: 'stale-stream' };
  firstPending.resolve(firstStream);
  assert.equal(await firstAcquisition, firstStream);
  assert.equal(audio.contexts.length, 1);
  assert.equal(audio.contexts[0].observedStream, secondStream);
  assert.equal(timers.activeCount, 1);
  await meter.dispose();
});
