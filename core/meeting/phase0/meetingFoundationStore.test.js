import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTestKeyProvider } from '../../localDataSpace/testKeyProvider.js';
import { createSignedTestOwnerContext, verifyOwnerContext } from '../../localDataSpace/ownerContext.js';
import { MeetingFoundationStore } from './meetingFoundationStore.js';

const SECRET = 'meeting-phase0-foundation-test-secret-which-is-32-bytes';

function ownerContext(ownerId) {
  return verifyOwnerContext(
    createSignedTestOwnerContext({ ownerId, secret: SECRET }),
    { secret: SECRET }
  );
}

async function openStore(root, ownerId, keyProvider, options = {}) {
  return MeetingFoundationStore.open({
    rootDirectory: root,
    ownerContext: ownerContext(ownerId),
    keyProvider,
    ...options
  });
}

function freshRoot() {
  return mkdtempSync(path.join(os.tmpdir(), 'meeting-phase0-foundation-'));
}

test('three owners remain isolated and client ownerId cannot override trusted context', async () => {
  const root = freshRoot();
  const keyProvider = createTestKeyProvider();
  const stores = [];
  try {
    const storeA = await openStore(root, 'owner-a', keyProvider);
    const storeB = await openStore(root, 'owner-b', keyProvider);
    const storeC = await openStore(root, 'owner-c', keyProvider);
    stores.push(storeA, storeB, storeC);
    const meeting = await storeA.createMeeting({ meetingId: 'meeting-a', ownerId: 'forged-owner', title: 'A的私密会议' });

    assert.equal(meeting.ownerId, 'owner-a');
    assert.equal((await storeA.listMeetings()).length, 1);
    assert.equal(await storeB.getMeeting('meeting-a'), null);
    assert.equal(await storeC.getMeeting('meeting-a'), null);
    await assert.rejects(() => storeB.deleteMeeting('meeting-a'), /MEETING_NOT_FOUND/);
    await assert.rejects(() => storeC.appendTranscriptRevision({
      meetingId: 'meeting-a', transcriptRevisionId: 'forged', content: { text: 'cross-owner' }
    }), /MEETING_NOT_FOUND/);
  } finally {
    for (const store of stores.reverse()) await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('segments are bounded, encrypted, ordered and idempotent', async () => {
  const root = freshRoot();
  const keyProvider = createTestKeyProvider();
  const store = await openStore(root, 'owner-a', keyProvider);
  try {
    await store.createMeeting({ meetingId: 'meeting-a', title: '不会出现在明文里的会议' });
    const first = await store.putAudioSegment({
      meetingId: 'meeting-a', segmentId: 'segment-a-0', segmentIndex: 0,
      durationMs: 1000, bytes: Buffer.from('synthetic-audio-0'), format: 'audio/wav'
    });
    const duplicate = await store.putAudioSegment({
      meetingId: 'meeting-a', segmentId: 'segment-a-0', segmentIndex: 0,
      durationMs: 1000, bytes: Buffer.from('synthetic-audio-0'), format: 'audio/wav'
    });
    assert.equal(first.segment.segmentId, 'segment-a-0');
    assert.equal(duplicate.idempotent, true);
    await assert.rejects(() => store.putAudioSegment({
      meetingId: 'meeting-a', segmentId: 'segment-a-2', segmentIndex: 2,
      durationMs: 1000, bytes: Buffer.from('synthetic-audio-2')
    }), /SEGMENT_ORDER_INVALID/);
    const second = await store.putAudioSegment({
      meetingId: 'meeting-a', segmentId: 'segment-a-1', segmentIndex: 1,
      durationMs: 1000, bytes: Buffer.from('synthetic-audio-1')
    });
    assert.equal(second.segment.segmentIndex, 1);
    assert.deepEqual((await store.listAudioSegments('meeting-a')).map(({ segmentIndex }) => segmentIndex), [0, 1]);

    const firstEnvelope = store.readStoredSegmentEnvelope(first.segment.segmentId);
    const secondEnvelope = store.readStoredSegmentEnvelope(second.segment.segmentId);
    assert.notEqual(firstEnvelope.nonce, secondEnvelope.nonce);
    assert.throws(() => store.readAudioSegmentBytes(first.segment.segmentId, { ownerId: 'owner-b' }), /OWNER_MISMATCH/);
    assert.doesNotMatch(readAllFiles(store.spacePath), /不会出现在明文里的会议|synthetic-audio-0|owner-a/);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('transcript revisions append without overwriting raw source', async () => {
  const root = freshRoot();
  const keyProvider = createTestKeyProvider();
  const store = await openStore(root, 'owner-a', keyProvider);
  try {
    await store.createMeeting({ meetingId: 'meeting-a' });
    const raw = await store.appendTranscriptRevision({
      meetingId: 'meeting-a', transcriptRevisionId: 'transcript-raw', source: 'raw_asr',
      status: 'raw_ready', content: { segments: [{ startMs: 0, endMs: 1000, text: '原始文字' }] }
    });
    const corrected = await store.appendTranscriptRevision({
      meetingId: 'meeting-a', transcriptRevisionId: 'transcript-corrected', parentRevisionId: raw.transcriptRevisionId,
      source: 'user_correction', status: 'needs_review', content: { segments: [{ startMs: 0, endMs: 1000, text: '校对文字' }] }
    });
    assert.equal((await store.getTranscriptRevision(raw.transcriptRevisionId)).content.segments[0].text, '原始文字');
    assert.equal(corrected.parentRevisionId, raw.transcriptRevisionId);
    await assert.rejects(() => store.appendTranscriptRevision({
      meetingId: 'meeting-a', transcriptRevisionId: 'transcript-corrected', parentRevisionId: raw.transcriptRevisionId,
      source: 'user_correction', status: 'needs_review', content: { segments: [] }
    }), /TRANSCRIPT_REVISION_EXISTS/);
    await assert.rejects(() => store.appendTranscriptRevision({
      meetingId: 'meeting-a', transcriptRevisionId: 'transcript-skipped', parentRevisionId: 'transcript-raw',
      source: 'manual', status: 'editing', content: { segments: [] }
    }), /TRANSCRIPT_PARENT_NOT_LATEST/);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('pre-commit interruptions leave no segment while post-commit interruption preserves it', async () => {
  const root = freshRoot();
  const keyProvider = createTestKeyProvider();
  let store = await openStore(root, 'owner-a', keyProvider, {
    faultInjector: (point) => {
      if (point === 'after-stage' || point === 'after-blob-commit') throw Object.assign(new Error('crash'), { code: 'INJECTED_CRASH' });
    }
  });
  try {
    await store.createMeeting({ meetingId: 'meeting-a' });
    await assert.rejects(() => store.putAudioSegment({
      meetingId: 'meeting-a', segmentId: 'segment-stage', segmentIndex: 0,
      durationMs: 1000, bytes: Buffer.from('stage')
    }), { code: 'INJECTED_CRASH' });
    assert.equal((await store.listAudioSegments('meeting-a')).length, 0);
    await store.close();
    store = await openStore(root, 'owner-a', keyProvider);
    assert.equal((await store.listAudioSegments('meeting-a')).length, 0);
    await store.close();

    store = await openStore(root, 'owner-a', keyProvider, {
      faultInjector: (point) => {
        if (point === 'after-manifest-commit') throw Object.assign(new Error('post-commit crash'), { code: 'INJECTED_POST_COMMIT' });
      }
    });
    await assert.rejects(() => store.putAudioSegment({
      meetingId: 'meeting-a', segmentId: 'segment-committed', segmentIndex: 0,
      durationMs: 1000, bytes: Buffer.from('committed')
    }), { code: 'INJECTED_POST_COMMIT' });
    await store.close();
    store = await openStore(root, 'owner-a', keyProvider);
    assert.deepEqual((await store.listAudioSegments('meeting-a')).map(({ segmentId }) => segmentId), ['segment-committed']);
  } finally {
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('manifest and segment mismatch fails closed on reopen', async () => {
  const root = freshRoot();
  const keyProvider = createTestKeyProvider();
  const store = await openStore(root, 'owner-a', keyProvider);
  try {
    await store.createMeeting({ meetingId: 'meeting-a' });
    store.faultInjector = (point, context) => {
      if (point === 'before-manifest-commit') context.nextManifest.expectedSegmentIndex = 2;
    };
    await store.putAudioSegment({ meetingId: 'meeting-a', segmentId: 'segment-a-0', segmentIndex: 0, durationMs: 1000, bytes: Buffer.from('audio') });
    await store.close();
    await assert.rejects(() => openStore(root, 'owner-a', keyProvider), /MANIFEST_SEGMENT_MISMATCH/);
  } finally {
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('many bounded segments never become one unbounded meeting payload', async () => {
  const root = freshRoot();
  const keyProvider = createTestKeyProvider();
  const store = await openStore(root, 'owner-a', keyProvider);
  try {
    await store.createMeeting({ meetingId: 'meeting-large' });
    await assert.rejects(() => store.putAudioSegment({
      meetingId: 'meeting-large', segmentId: 'oversized', segmentIndex: 0,
      durationMs: 1000, bytes: Buffer.alloc(8 * 1024 * 1024 + 1)
    }), /SEGMENT_SIZE_INVALID/);
    for (let index = 0; index < 24; index += 1) {
      await store.putAudioSegment({
        meetingId: 'meeting-large', segmentId: `segment-${index}`, segmentIndex: index,
        durationMs: 1000, bytes: Buffer.from(`bounded-segment-${index}`)
      });
    }
    const manifest = await store.getAudioManifest('meeting-large');
    assert.equal(manifest.expectedSegmentIndex, 24);
    assert.equal(manifest.totalBytes < 24 * 1024, true);
    assert.equal((await store.listAudioSegments('meeting-large')).length, 24);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function readAllFiles(root) {
  const output = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) output.push(readFileSync(target).toString('utf8'));
    }
  };
  visit(root);
  return output.join('\n');
}
