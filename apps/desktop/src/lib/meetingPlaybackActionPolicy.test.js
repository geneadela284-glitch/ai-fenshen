import assert from 'node:assert/strict';
import test from 'node:test';
import { isTerminalPlaybackActionError } from './meetingPlaybackActionPolicy.js';

test('transient playback action failures remain recoverable after a session is open', () => {
  for (const code of [
    'PLAYBACK_TARGET_NOT_BUFFERED',
    'PLAYBACK_SEEK_FAILED',
    'PLAYBACK_APPEND_FAILED',
    'PLAYBACK_OPERATION_TIMEOUT',
    'PLAYBACK_PLAY_FAILED',
    'PLAYBACK_PLAY_ABORTED'
  ]) {
    assert.equal(isTerminalPlaybackActionError({ code }), false, code);
  }
});

test('binding, capability, and disposed-session failures remain fail-closed', () => {
  for (const code of [
    'PLAYBACK_BINDING_MISMATCH',
    'PLAYBACK_SOURCE_BOUNDARY_UNVERIFIED',
    'PLAYBACK_UNSUPPORTED',
    'PLAYBACK_MIME_UNSUPPORTED',
    'PLAYBACK_MANAGER_DISPOSED',
    'PLAYBACK_NOT_OPEN'
  ]) {
    assert.equal(isTerminalPlaybackActionError({ code }), true, code);
  }
});
