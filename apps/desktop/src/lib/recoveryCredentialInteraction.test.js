import assert from 'node:assert/strict';
import test from 'node:test';

import {
  beginRecoveryGeneration,
  completeRecoveryGeneration,
  failRecoveryGeneration,
  recoveryGenerationButtonLabel
} from './recoveryCredentialInteraction.js';

test('recovery generation exposes an immediate generating state and rejects duplicate starts', () => {
  const idle = { status: 'idle', errorCode: '' };
  const started = beginRecoveryGeneration(idle);
  assert.equal(started.accepted, true);
  assert.deepEqual(started.state, { status: 'generating', errorCode: '' });
  assert.equal(beginRecoveryGeneration(started.state).accepted, false);
  assert.equal(beginRecoveryGeneration({ status: 'generated', errorCode: '' }).accepted, false);
  assert.equal(recoveryGenerationButtonLabel(started.state.status), '正在生成…');
});

test('recovery generation reaches generated or failed with a visible error code', () => {
  const generated = completeRecoveryGeneration({ status: 'generating', errorCode: '' });
  assert.deepEqual(generated, { status: 'generated', errorCode: '' });
  const failed = failRecoveryGeneration({ status: 'generating', errorCode: '' }, 'RECOVERY_WRAPPING_FAILED');
  assert.deepEqual(failed, { status: 'failed', errorCode: 'RECOVERY_WRAPPING_FAILED' });
  assert.equal(recoveryGenerationButtonLabel(failed.status), '重新生成恢复凭据');
});

