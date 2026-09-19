import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const panelPath = fileURLToPath(new URL('./MeetingPlaybackPanel.jsx', import.meta.url));
const panelSource = await readFile(panelPath, 'utf8');
const uiModelPath = fileURLToPath(new URL('../../../lib/meetingStage3cPlaybackUiModel.js', import.meta.url));
const uiModelSource = await readFile(uiModelPath, 'utf8');

test('playback panel exposes the bounded controls without leaking storage internals', () => {
  assert.match(panelSource, /播放/);
  assert.match(panelSource, /暂停/);
  assert.match(panelSource, /前15秒/);
  assert.match(panelSource, /后15秒/);
  assert.match(panelSource, /type="range"/);
  assert.match(panelSource, /当前时间/);
  assert.match(panelSource, /总时长/);
  assert.doesNotMatch(panelSource, />\s*(chunk|codec|revision|hash)\s*</i);
});

test('playback controls keep a subdued readable treatment and distinct interactive hooks', async () => {
  const cssPath = fileURLToPath(new URL('./MeetingPlaybackPanel.css', import.meta.url));
  const css = await readFile(cssPath, 'utf8');
  assert.match(panelSource, /meeting-playback-panel__button--play/);
  assert.match(panelSource, /meeting-playback-panel__button--skip/);
  assert.match(css, /meeting-playback-panel__button--play/);
  assert.match(css, /meeting-playback-panel__button--skip/);
  assert.match(css, /:hover/);
  assert.match(css, /:active/);
});

test('playback panel keeps transcript sync actions in the isolated panel', () => {
  assert.match(panelSource, /createStage3cTranscriptPlaybackSync/);
  assert.match(panelSource, /回到当前发言/);
  assert.match(panelSource, /onUserScroll/);
  assert.match(panelSource, /clickSegment/);
  assert.match(panelSource, /setSegmentVisibility/);
  assert.match(panelSource, /speakerCorrectionManager/);
});

test('unsupported playback remains readable and boundary uncertainty is honest', () => {
  assert.match(`${panelSource}\n${uiModelSource}`, /当前录音暂不支持原音回放/);
  assert.match(panelSource, /PLAYBACK_SOURCE_BOUNDARY_UNVERIFIED/);
  assert.match(panelSource, /原始转写/);
});

test('Safari gesture loss stays explicit and keeps the prepared window resumable', () => {
  assert.match(panelSource, /requiresUserGesture/);
  assert.match(panelSource, /音频已定位，点击继续播放/);
  assert.match(panelSource, /PLAYBACK_USER_GESTURE_REQUIRED/);
});

test('audio readiness is independent from transcript readiness', () => {
  assert.match(panelSource, /resolveStage3cPlaybackDependency/);
  assert.match(panelSource, /dependency\.mode !== 'playback-ready'/);
  assert.doesNotMatch(panelSource, /if \(!source \|\| !currentTranscript \|\| !playback\?\.createSession\)/);
  assert.match(panelSource, /转写尚未完成，原音仍可播放。/);
});

test('Speaker Correction and Transcript Sync initialization cannot gate the opened Playback session', () => {
  const openIndex = panelSource.indexOf('await activeSession.open');
  const projectionIndex = panelSource.indexOf('speakerCorrectionManager?.getSpeakerProjection');
  assert.ok(openIndex >= 0, 'Playback session open must remain explicit');
  assert.ok(projectionIndex > openIndex, 'optional projection must be loaded after Playback opens');
  assert.match(panelSource, /说话人修正暂不可用，原音与转写仍可使用/);
  assert.match(panelSource, /文字联动暂不可用，原音仍可播放/);
});

test('mobile range drag previews locally and commits only after the interaction ends', () => {
  assert.match(panelSource, /seekDraftMs/);
  assert.match(panelSource, /beginSeekDraft/);
  assert.match(panelSource, /updateSeekDraft/);
  assert.match(panelSource, /commitSeekDraft/);
  assert.match(panelSource, /onPointerUp=\{commitSeekDraft\}/);
  assert.match(panelSource, /onKeyUp=\{commitSeekDraft\}/);
  assert.doesNotMatch(panelSource, /onChange=\{\(event\) => seekTo\(/);
  assert.match(panelSource, /result\?\.currentTargetMs/);
  assert.match(panelSource, /result\?\.seekResult\?\.currentTargetMs/);
});

test('playback controls are serialized after a range seek instead of becoming unavailable during the seek', () => {
  assert.match(panelSource, /meetingPlaybackActionQueue/);
  assert.match(panelSource, /playbackActionQueueRef/);
  assert.match(panelSource, /playbackActionQueueRef\.current\.enqueue/);
  assert.doesNotMatch(panelSource, /disabled=\{phase !== 'ready' \|\| .*seek/);
});

test('recoverable playback action errors keep the prepared controls usable', () => {
  assert.match(panelSource, /isTerminalPlaybackActionError/);
  assert.match(panelSource, /setPhase\('ready'\)/);
  assert.match(panelSource, /这次定位没有完成，原音仍可继续操作/);
  assert.match(panelSource, /session\.open\(/);
});

test('recoverable seek errors preserve autoplay instead of silently pausing the prepared session', () => {
  const recoveryStart = panelSource.indexOf('await session.open({');
  const recoveryBlock = panelSource.slice(recoveryStart, recoveryStart + 1_200);
  assert.match(recoveryBlock, /autoplayRequested/);
  assert.match(recoveryBlock, /await session\.play\(\)/);
  assert.doesNotMatch(recoveryBlock, /setPlaying\(false\);\s*setRequiresUserGesture\(false\)/);
});

test('panel keeps the MeetingCenter integration additive and singular', async () => {
  const meetingCenterPath = fileURLToPath(new URL('../../MeetingCenter.jsx', import.meta.url));
  const meetingCenterSource = await readFile(meetingCenterPath, 'utf8');
  assert.match(meetingCenterSource, /MeetingPlaybackPanel/);
  assert.equal((meetingCenterSource.match(/<MeetingPlaybackPanel\b/g) || []).length, 1);
  assert.match(meetingCenterSource, /const playbackSource = active\?\.audioSources/);
  assert.match(meetingCenterSource, /const playbackPanelSource = playbackSource \|\| playbackTranscript\?\.source \|\| null/);
  assert.match(meetingCenterSource, /transcript=\{playbackTranscript\?\.transcript \|\| null\}/);
  assert.doesNotMatch(meetingCenterSource, /createStage3cTranscriptPlaybackSync/);
  assert.doesNotMatch(meetingCenterSource, /createStage3cPlaybackManager/);
});

test('evidence navigation uses the existing playback session seam to seek and let transcript sync highlight', () => {
  assert.match(panelSource, /evidenceTarget/);
  assert.match(panelSource, /evidenceTarget\.evidenceRef\.startMs/);
  assert.match(panelSource, /session\.seekTo/);
  assert.match(panelSource, /sync\.updateCurrentTime/);
});
