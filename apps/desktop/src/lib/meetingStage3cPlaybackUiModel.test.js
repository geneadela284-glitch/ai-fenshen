import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampStage3cPlaybackTime,
  formatStage3cPlaybackTime,
  stage3cPlaybackErrorMessage,
  stage3cSpeakerLabel
} from './meetingStage3cPlaybackUiModel.js';

test('playback time display and seek values remain bounded', () => {
  assert.equal(formatStage3cPlaybackTime(0), '00:00');
  assert.equal(formatStage3cPlaybackTime(65_000), '01:05');
  assert.equal(formatStage3cPlaybackTime(3_661_000), '01:01:01');
  assert.equal(clampStage3cPlaybackTime(-1, 90_000), 0);
  assert.equal(clampStage3cPlaybackTime(120_000, 90_000), 89_500);
  assert.equal(clampStage3cPlaybackTime(90_000, 90_000), 89_500);
  assert.equal(clampStage3cPlaybackTime(30_000, 90_000), 30_000);
});

test('playback errors stay honest and transcript remains readable', () => {
  assert.equal(stage3cPlaybackErrorMessage({ code: 'PLAYBACK_UNSUPPORTED' }), '当前录音暂不支持原音回放');
  assert.equal(stage3cPlaybackErrorMessage({ code: 'AUDIO_SOURCE_UNAVAILABLE' }), '当前录音暂不支持原音回放');
  assert.equal(stage3cPlaybackErrorMessage({ code: 'PLAYBACK_SOURCE_BOUNDARY_UNVERIFIED' }), '当前录音暂不支持原音回放');
  assert.equal(stage3cPlaybackErrorMessage({ code: 'PLAYBACK_BINDING_MISMATCH' }), '当前录音与转写版本不一致，已停止联动。');
});

test('speaker labels prefer effective correction and otherwise remain anonymous', () => {
  assert.equal(stage3cSpeakerLabel({ effectiveSpeaker: { displayLabel: '主持人' } }), '主持人');
  assert.equal(stage3cSpeakerLabel({ effectiveSpeaker: { speakerId: 'speaker-2' } }), '说话人 2');
  assert.equal(stage3cSpeakerLabel({ speakerRef: 'speaker-3' }), '说话人 3');
  assert.equal(stage3cSpeakerLabel({}), '未标注发言人');
});
