import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EncryptedRecordStore } from './encryptedRecordStore.js';
import { createTestKeyProvider } from './testKeyProvider.js';

test('encrypted records survive reopen without exposing owner or plaintext content', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'meeting-phase0-records-'));
  const databasePath = path.join(root, 'meetings.sqlite');
  const provider = createTestKeyProvider();
  const dataKey = await provider.createDataKey({ ownerId: 'owner-a', spaceId: 'space-a' });
  const payload = { title: '极其敏感的会议正文', ownerId: 'owner-a', amount: 123456 };
  let store;
  try {
    store = await EncryptedRecordStore.open({ databasePath, ownerId: 'owner-a', spaceId: 'space-a', dataKey });
    await store.insert({ recordId: 'meeting-a', kind: 'meeting', sourceId: 'meeting-a', payload });
    const rawDatabase = readFileSync(databasePath).toString('utf8');
    assert.doesNotMatch(rawDatabase, /极其敏感的会议正文|owner-a/);
    await store.close();

    store = await EncryptedRecordStore.open({ databasePath, ownerId: 'owner-a', spaceId: 'space-a', dataKey });
    assert.deepEqual((await store.get('meeting-a')).payload, payload);
    await store.close();

    await assert.rejects(
      () => EncryptedRecordStore.open({ databasePath, ownerId: 'owner-b', spaceId: 'space-a', dataKey }),
      /OWNER_MISMATCH/
    );
    const wrongKey = await provider.createDataKey({ ownerId: 'owner-a', spaceId: 'space-other' });
    await assert.rejects(
      () => EncryptedRecordStore.open({ databasePath, ownerId: 'owner-a', spaceId: 'space-a', dataKey: wrongKey }),
      /KEY_MISMATCH/
    );
  } finally {
    await store?.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('record transactions roll back metadata changes as one unit', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'meeting-phase0-record-tx-'));
  const provider = createTestKeyProvider();
  const dataKey = await provider.createDataKey({ ownerId: 'owner-a', spaceId: 'space-a' });
  const store = await EncryptedRecordStore.open({ databasePath: path.join(root, 'records.sqlite'), ownerId: 'owner-a', spaceId: 'space-a', dataKey });
  try {
    await assert.rejects(() => store.transaction(({ insert }) => {
      insert({ recordId: 'one', kind: 'meeting', sourceId: 'one', payload: { value: 1 } });
      throw Object.assign(new Error('injected'), { code: 'INJECTED' });
    }), { code: 'INJECTED' });
    assert.equal(await store.get('one'), null);
  } finally {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
