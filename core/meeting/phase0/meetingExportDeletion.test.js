import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTestKeyProvider } from '../../localDataSpace/testKeyProvider.js';
import { createSignedTestOwnerContext, ownerHash, verifyOwnerContext } from '../../localDataSpace/ownerContext.js';
import { MeetingFoundationStore } from './meetingFoundationStore.js';

const SECRET = 'meeting-phase0-export-test-secret-which-is-32-bytes';
const RECOVERY_KEY = 'meeting-user-recovery-key-which-is-strong';

function context(ownerId) {
  return verifyOwnerContext(
    createSignedTestOwnerContext({ ownerId, secret: SECRET }),
    { secret: SECRET }
  );
}

async function open(root, ownerId, keyProvider) {
  return MeetingFoundationStore.open({ rootDirectory: root, ownerContext: context(ownerId), keyProvider });
}

function root() {
  return mkdtempSync(path.join(os.tmpdir(), 'meeting-phase0-archive-'));
}

test('encrypted export, wrong-owner rejection, corruption rollback and idempotent restore', async () => {
  const sourceRoot = root();
  const restoreRoot = root();
  const exportRoot = root();
  const keyProvider = createTestKeyProvider();
  let source;
  try {
    source = await open(sourceRoot, 'owner-a', keyProvider);
    await source.createMeeting({ meetingId: 'meeting-a', title: '不会泄露的导出会议' });
    await source.putAudioSegment({ meetingId: 'meeting-a', segmentId: 'segment-a-0', segmentIndex: 0, durationMs: 1000, bytes: Buffer.from('export-audio') });
    await source.appendTranscriptRevision({ meetingId: 'meeting-a', transcriptRevisionId: 'raw-a', content: { text: '导出原文' } });
    const exportPath = path.join(exportRoot, `owner-${ownerHash('owner-a')}`, 'meeting-space.enc');
    const exported = await source.exportEncrypted({ destinationPath: exportPath, recoveryKey: RECOVERY_KEY });
    assert.equal(exported.encrypted, true);
    const exportedText = readFileSync(exportPath, 'utf8');
    assert.match(exportedText, /user-recovery-key/);
    assert.doesNotMatch(exportedText, /不会泄露的导出会议|导出原文|owner-a/);
    await assert.rejects(
      () => MeetingFoundationStore.restoreEncrypted({ archivePath: exportPath, destinationRoot: root(), ownerContext: context('owner-a'), keyProvider, recoveryKey: 'wrong-recovery-key-which-is-long-enough' }),
      /AUTHENTICATION_FAILED/
    );
    await assert.rejects(
      () => MeetingFoundationStore.restoreEncrypted({ archivePath: exportPath, destinationRoot: root(), ownerContext: context('owner-b'), keyProvider, recoveryKey: RECOVERY_KEY }),
      /OWNER_MISMATCH/
    );

    const restored = await MeetingFoundationStore.restoreEncrypted({ archivePath: exportPath, destinationRoot: restoreRoot, ownerContext: context('owner-a'), keyProvider, recoveryKey: RECOVERY_KEY });
    assert.equal((await restored.listMeetings()).length, 1);
    assert.equal((await restored.getTranscriptRevision('raw-a')).content.text, '导出原文');
    await restored.close();
    const repeated = await MeetingFoundationStore.restoreEncrypted({ archivePath: exportPath, destinationRoot: restoreRoot, ownerContext: context('owner-a'), keyProvider, recoveryKey: RECOVERY_KEY });
    assert.equal(repeated.restoreIdempotent, true);
    await repeated.close();

    const corruptedRoot = root();
    const corruptedPath = path.join(exportRoot, `owner-${ownerHash('owner-a')}`, 'corrupted.enc');
    const outer = JSON.parse(readFileSync(exportPath, 'utf8'));
    outer.body.ciphertext = `${outer.body.ciphertext.slice(0, -2)}aa`;
    const corruptedBytes = `${JSON.stringify(outer)}\n`;
    writeFileSync(corruptedPath, corruptedBytes, { mode: 0o600 });
    await assert.rejects(
      () => MeetingFoundationStore.restoreEncrypted({ archivePath: corruptedPath, destinationRoot: corruptedRoot, ownerContext: context('owner-a'), keyProvider, recoveryKey: RECOVERY_KEY }),
      /AUTHENTICATION_FAILED/
    );
    assert.equal(existsSync(path.join(corruptedRoot, `owner-${ownerHash('owner-a')}`)), false);
    rmSync(corruptedRoot, { recursive: true, force: true });
  } finally {
    await source?.close();
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(restoreRoot, { recursive: true, force: true });
    rmSync(exportRoot, { recursive: true, force: true });
  }
});

test('meeting deletion clears managed residue and owner deletion does not affect another owner', async () => {
  const rootDirectory = root();
  const keyProvider = createTestKeyProvider();
  let storeA;
  let storeB;
  try {
    storeA = await open(rootDirectory, 'owner-a', keyProvider);
    storeB = await open(rootDirectory, 'owner-b', keyProvider);
    await storeA.createMeeting({ meetingId: 'meeting-a', title: '待删除会议' });
    await storeA.putAudioSegment({ meetingId: 'meeting-a', segmentId: 'segment-a-0', segmentIndex: 0, durationMs: 1000, bytes: Buffer.from('delete-audio') });
    await storeA.appendTranscriptRevision({ meetingId: 'meeting-a', transcriptRevisionId: 'raw-a', content: { text: 'delete-transcript' } });
    await storeB.createMeeting({ meetingId: 'meeting-b', title: '保留会议' });
    await storeB.putAudioSegment({ meetingId: 'meeting-b', segmentId: 'segment-b-0', segmentIndex: 0, durationMs: 1000, bytes: Buffer.from('keep-audio') });

    await storeA.deleteMeeting('meeting-a');
    assert.equal(await storeA.getMeeting('meeting-a'), null);
    assert.equal((await storeA.listAudioSegments('meeting-a')).length, 0);
    assert.equal(await storeA.getTranscriptRevision('raw-a'), null);
    assert.doesNotMatch(readManagedFiles(storeA.spacePath), /待删除会议|delete-audio|delete-transcript|meeting-a/);
    assert.equal((await storeB.listMeetings())[0].meetingId, 'meeting-b');
    assert.equal((await storeB.listAudioSegments('meeting-b'))[0].segmentId, 'segment-b-0');

    await storeA.close();
    await MeetingFoundationStore.deleteOwner({ rootDirectory, ownerContext: context('owner-a'), keyProvider });
    assert.equal(existsSync(storeA.spacePath), false);
    assert.equal((await storeB.listMeetings()).length, 1);
    await storeB.close();
    await assert.rejects(() => keyProvider.getDataKey({ ownerId: 'owner-a', spaceId: storeA.manifest.spaceId }), /KEY_NOT_FOUND/);
  } finally {
    await storeA?.close();
    await storeB?.close();
    rmSync(rootDirectory, { recursive: true, force: true });
  }
});

test('production entry does not export the test key provider', async () => {
  const productionExports = await import('../../localDataSpace/index.js');
  assert.equal('TestKeyProvider' in productionExports, false);
  assert.equal('createTestKeyProvider' in productionExports, false);
});

function readManagedFiles(rootDirectory) {
  const chunks = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      if (entry.isFile()) chunks.push(readFileSync(target).toString('utf8'));
    }
  };
  visit(rootDirectory);
  return chunks.join('\n');
}
