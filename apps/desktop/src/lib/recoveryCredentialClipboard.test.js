import assert from 'node:assert/strict';
import test from 'node:test';

import { copyRecoveryCredential } from './recoveryCredentialClipboard.js';

test('copy helper writes the recovery credential without logging or returning it', async () => {
  let copied = '';
  const result = await copyRecoveryCredential({
    secret: 'synthetic-recovery-secret',
    clipboard: { writeText: async (value) => { copied = value; } }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(copied, 'synthetic-recovery-secret');
  assert.equal(Object.hasOwn(result, 'secret'), false);
});

test('copy helper returns a visible fallback code when Safari clipboard access fails', async () => {
  const unavailable = await copyRecoveryCredential({ secret: 'synthetic-recovery-secret', clipboard: null });
  assert.deepEqual(unavailable, { ok: false, errorCode: 'CLIPBOARD_UNAVAILABLE' });
  const rejected = await copyRecoveryCredential({
    secret: 'synthetic-recovery-secret',
    clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } }
  });
  assert.deepEqual(rejected, { ok: false, errorCode: 'CLIPBOARD_WRITE_FAILED' });
});

