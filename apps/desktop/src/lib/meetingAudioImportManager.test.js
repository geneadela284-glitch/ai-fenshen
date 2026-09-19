import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';

import {
  createMemoryMeetingBackend,
  createMeetingPhase1Store
} from './browserMeetingStore.js';
import { createMeetingAudioImportManager } from './meetingAudioImportManager.js';

const cryptoImpl = webcrypto;

function context(ownerId = 'owner-a') {
  return Object.freeze({ trusted: true, ownerId, sessionId: `session-${ownerId}`, spaceId: 'meeting-space' });
}

async function provider() {
  const key = await cryptoImpl.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { async withOwnerKey(_context, callback) { return callback(key); } };
}

function u32le(value) {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function u16le(value) {
  return Uint8Array.from([value & 0xff, (value >>> 8) & 0xff]);
}

function concat(...parts) {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function wavFile(dataLength = 4096, { slow = false } = {}) {
  const data = Uint8Array.from({ length: dataLength }, (_, index) => index % 251);
  const header = concat(
    new TextEncoder().encode('RIFF'), u32le(36 + data.length), new TextEncoder().encode('WAVE'),
    new TextEncoder().encode('fmt '), u32le(16), u16le(1), u16le(1), u32le(8000), u32le(16000), u16le(2), u16le(16),
    new TextEncoder().encode('data'), u32le(data.length)
  );
  const blob = new Blob([header, data], { type: 'audio/wav' });
  Object.defineProperty(blob, 'name', { value: 'synthetic.wav' });
  if (!slow) return blob;
  return {
    size: blob.size,
    name: blob.name,
    type: blob.type,
    lastModified: 123,
    slice: blob.slice.bind(blob),
    stream() {
      const reader = blob.stream().getReader();
      return new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 3));
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel(reason) {
          return reader.cancel(reason);
        }
      });
    }
  };
}

async function setup() {
  const backend = createMemoryMeetingBackend();
  const store = createMeetingPhase1Store({ cryptoImpl, keyProvider: await provider(), backend });
  const owner = context();
  await store.createMeeting(owner, { meetingId: 'meeting-a', title: '导入编排器测试' });
  const manager = createMeetingAudioImportManager({ ownerContext: owner, store, cryptoImpl, chunkSize: 4096 });
  return { backend, store, owner, manager };
}

test('import manager streams a file, reports progress, commits and supports duplicate importId idempotency', async () => {
  const { manager } = await setup();
  const progress = [];
  const file = wavFile(4096);
  const first = await manager.importFile({ meetingId: 'meeting-a', file, importId: 'import-a', onProgress: (value) => progress.push(value) });
  assert.equal(first.source.importState, 'committed');
  assert.equal(first.source.origin, 'imported');
  assert.equal(progress.at(-1).percent, 100);
  const duplicate = await manager.importFile({ meetingId: 'meeting-a', file, importId: 'import-a' });
  assert.equal(duplicate.idempotent, true);
  assert.equal(manager.getSnapshot().importState, 'committed');
});

test('invalid audio is explicitly rejected before an AudioSource is created', async () => {
  const { manager, store } = await setup();
  const file = new Blob([new TextEncoder().encode('not an audio file')], { type: 'audio/wav' });
  Object.defineProperty(file, 'name', { value: 'not-audio.wav' });
  await assert.rejects(
    manager.importFile({ meetingId: 'meeting-a', file, importId: 'import-rejected' }),
    (error) => error.code === 'AUDIO_HEADER_INVALID'
  );
  assert.equal(manager.getSnapshot().importState, 'rejected');
  assert.equal((await store.getMeeting(context(), 'meeting-a')).audioSources.length, 0);
});

test('cancel aborts a slow import, cleans half-built assets, and reselecting the same file safely retries', async () => {
  const { backend, store, manager } = await setup();
  const file = wavFile(128 * 1024, { slow: true });
  const running = manager.importFile({ meetingId: 'meeting-a', file, importId: 'import-cancel' });
  while (!['importing', 'validating'].includes(manager.getSnapshot().importState)) await new Promise((resolve) => setTimeout(resolve, 1));
  await manager.cancelImport();
  await assert.rejects(running, (error) => error.code === 'IMPORT_CANCELLED');
  assert.equal((await store.getMeeting(context(), 'meeting-a')).audioSources.length, 0);
  assert.equal(backend.dump().audioAssets.length, 0);
  const retried = await manager.importFile({ meetingId: 'meeting-a', file });
  assert.equal(retried.source.importState, 'committed');
});

test('cancelled importId can be reselected with the same source identity and safely retries', async () => {
  const { backend, store, manager } = await setup();
  const file = wavFile(128 * 1024, { slow: true });
  const running = manager.importFile({ meetingId: 'meeting-a', file, importId: 'import-cancel-same', sourceId: 'source-cancel-same' });
  while (!['importing', 'validating'].includes(manager.getSnapshot().importState)) await new Promise((resolve) => setTimeout(resolve, 1));
  await manager.cancelImport();
  await assert.rejects(running, (error) => error.code === 'IMPORT_CANCELLED');
  assert.equal(backend.dump().audioAssets.length, 0);
  const retried = await manager.importFile({ meetingId: 'meeting-a', file, importId: 'import-cancel-same', sourceId: 'source-cancel-same' });
  assert.equal(retried.source.importState, 'committed');
  assert.equal((await store.getMeeting(context(), 'meeting-a')).audioSources.length, 1);
});

test('refresh exposes an importing source as requiring the same file to be reselected', async () => {
  const { store, owner, manager } = await setup();
  await store.beginAudioImport(owner, {
    meetingId: 'meeting-a',
    importId: 'import-refresh',
    sourceId: 'source-refresh',
    originalFileName: 'synthetic.wav',
    mimeType: 'audio/wav',
    format: 'wav',
    byteLength: 4140,
    durationMs: 258,
    fileIdentity: '4140:123:synthetic.wav:audio/wav'
  });
  await manager.initialize('meeting-a');
  assert.equal(manager.getSnapshot().requiresReselect, true);
  assert.match(manager.getSnapshot().message, /重新选择同一文件/);
});

test('import manager has no model, ASR or memory side effects and deletes an imported source', async () => {
  const { manager, store } = await setup();
  const calls = [];
  const guarded = new Proxy(manager, {
    get(target, property) {
      if (/asr|transcript|memory|model|provider/i.test(String(property))) calls.push(property);
      return target[property];
    }
  });
  const result = await guarded.importFile({ meetingId: 'meeting-a', file: wavFile(1024) });
  await guarded.deleteSource('meeting-a', result.source.sourceId);
  assert.deepEqual(calls, []);
  assert.equal((await store.getMeeting(context(), 'meeting-a')).audioSources.length, 0);
});
