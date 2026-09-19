import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMemoryCheckpointTraceStorage,
  createMeetingRecordingCheckpointTraceClient,
  safeEvent
} from './meetingRecordingCheckpointTrace.js';

test('trace sanitization drops binary and arbitrary nested objects while retaining bounded scalar lifecycle fields', () => {
  const safe = safeEvent({
    event: 'capture_unit_sealed',
    captureOrdinal: 25,
    chunkToken: 'token-private',
    bytes: new Uint8Array([1, 2, 3]),
    ciphertext: new Uint8Array([4, 5]),
    nested: { audioBytes: [1, 2, 3], secret: 'not-allowed' },
    scalarList: [1, 'two', true]
  });

  assert.deepEqual(safe, {
    event: 'capture_unit_sealed',
    captureOrdinal: 25,
    chunkToken: 'token-private',
    scalarList: [1, 'two', true]
  });
});

test('checkpoint trace is persisted before upload and never stores audio bytes', async () => {
  const storage = createMemoryCheckpointTraceStorage();
  let calls = 0;
  const client = createMeetingRecordingCheckpointTraceClient({
    storage,
    cryptoImpl: { randomUUID: () => 'trace-one' },
    now: () => '2026-08-14T10:00:00.000Z',
    fetchImpl: async (_url, options) => {
      calls += 1;
      const body = JSON.parse(options.body);
      assert.equal(body.phase, 'recording_checkpoint');
      assert.equal('blob' in body, false);
      assert.equal('audioBytes' in body, false);
      return { ok: true, async json() { return { ok: true }; } };
    }
  });
  const result = await client.record({
    event: 'checkpoint_succeeded',
    meetingId: 'meeting-a',
    sourceId: 'recorded-meeting-a',
    recordingAttemptId: 'attempt-a',
    blob: new Uint8Array([1, 2, 3]),
    persistedBytes: 3
  });
  assert.equal(result.ok, true);
  assert.equal(calls, 1);
  assert.equal(storage.rows.size, 1);
  assert.equal([...storage.rows.values()][0].status, 'acknowledged');
});

test('upload failure leaves a pending trace and flush retries it idempotently', async () => {
  const storage = createMemoryCheckpointTraceStorage();
  let online = false;
  const client = createMeetingRecordingCheckpointTraceClient({
    storage,
    cryptoImpl: { randomUUID: () => 'trace-two' },
    fetchImpl: async () => {
      if (!online) throw new Error('offline');
      return { ok: true, async json() { return { ok: true }; } };
    }
  });
  const first = await client.record({ event: 'checkpoint_failed', errorCode: 'CHECKPOINT_TIMEOUT' });
  assert.equal(first.ok, false);
  assert.equal(first.pending, true);
  assert.equal([...storage.rows.values()][0].status, 'pending');
  online = true;
  assert.equal(await client.flushPending(), 1);
  assert.equal([...storage.rows.values()][0].status, 'acknowledged');
});
