import assert from 'node:assert/strict';
import test from 'node:test';

import { inferRecordedAudioFormat } from './browserMeetingStore.js';

test('maps recorded MediaRecorder MIME types to continuous-source formats', () => {
  assert.equal(inferRecordedAudioFormat('audio/webm;codecs=opus'), 'webm-opus');
  assert.equal(inferRecordedAudioFormat('audio/mp4;codecs=mp4a.40.2'), 'm4a');
  assert.equal(inferRecordedAudioFormat('audio/mp4'), 'm4a');
  assert.equal(inferRecordedAudioFormat('audio/wav'), 'recorded');
});
