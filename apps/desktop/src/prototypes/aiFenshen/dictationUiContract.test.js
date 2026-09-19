import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const directory = path.dirname(new URL(import.meta.url).pathname);
const source = (file) => readFile(path.join(directory, file), 'utf8');

test('Dictation renders a fixed inline recording bar with recording and processing states', async () => {
  const voice = await source('VoiceInputMock.jsx');
  const composer = await source('ChatComposer.jsx');
  const css = await readFile(path.join(directory, 'aiFenshenPrototype.css'), 'utf8');

  assert.match(voice, /data-testid="dictation-bar"/);
  assert.match(voice, /data-testid="dictation-waveform"/);
  assert.match(voice, /正在转成文字…/);
  assert.match(voice, /停止录音/);
  assert.match(voice, /取消录音/);
  assert.match(composer, /data-dictation-state=/);
  assert.match(composer, /voiceState === 'recording'/);
  assert.match(composer, /voiceState === 'processing'/);
  assert.match(css, /\.af-dictation-bar\s*\{/);
  assert.match(css, /\.af-dictation-waveform/);
  assert.match(css, /\.af-dictation-processing/);
});

test('Dictation completion focuses the draft without entering chat and honors reduced motion', async () => {
  const composer = await source('ChatComposer.jsx');
  const css = await readFile(path.join(directory, 'aiFenshenPrototype.css'), 'utf8');

  assert.match(composer, /is-dictation-ready/);
  assert.match(composer, /setSelectionRange/);
  assert.match(composer, /suppressFocus/);
  assert.match(composer, /reducedMotion/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test('Dictation state exposes recording metrics and inline failure state to the composer', async () => {
  const hook = await source('useDictation.js');
  const home = await source('HomeAmbientScene.jsx');
  const chat = await source('ImmersiveChatView.jsx');
  const app = await source('AIFenshenRealApp.jsx');

  assert.match(hook, /onProgress/);
  assert.match(hook, /voiceDurationMs/);
  assert.match(hook, /voiceLevel/);
  assert.match(hook, /voiceError/);
  assert.match(home, /voiceDurationMs/);
  assert.match(home, /voiceLevel/);
  assert.match(chat, /voiceDurationMs/);
  assert.match(chat, /voiceLevel/);
  assert.match(app, /voiceError/);
});

test('cancel uses a native touch-safe activation path and keeps a directly hittable button', async () => {
  const voice = await source('VoiceInputMock.jsx');
  const css = await readFile(path.join(directory, 'aiFenshenPrototype.css'), 'utf8');

  assert.match(voice, /createDictationCancelDispatcher/);
  assert.match(voice, /onPointerUp=\{handleCancel\}/);
  assert.match(voice, /onTouchEnd=\{handleCancel\}/);
  assert.match(voice, /onClick=\{handleCancel\}/);
  assert.match(css, /\.af-dictation-cancel\s*\{[^}]*width:\s*44px[^}]*height:\s*44px[^}]*pointer-events:\s*auto[^}]*touch-action:\s*manipulation[^}]*z-index:\s*3/s);
  assert.doesNotMatch(css, /\.af-dictation-cancel\s*\{[^}]*pointer-events:\s*none/s);
});

test('cancel button keeps a deliberate gap from the paperclip slot on narrow screens', async () => {
  const css = await readFile(path.join(directory, 'aiFenshenPrototype.css'), 'utf8');

  assert.match(css, /\.af-attach-wrap\s*\{[^}]*width:\s*46px[^}]*height:\s*46px/s);
  assert.match(css, /\.af-composer\s*\{[^}]*gap:\s*1px/s);
  assert.match(css, /\.af-dictation-bar\s*\{[^}]*padding:\s*2px 4px 2px 16px/s);
});

test('cancel leaves the existing draft untouched and abandons work before transcription', async () => {
  const hook = await source('useDictation.js');
  const cancelBody = hook.match(/const cancel = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[settleTransient\]\);/)?.[0] || '';

  assert.match(cancelBody, /requestRef\.current\?\.controller\.abort/);
  assert.match(cancelBody, /recorderRef\.current\?\.cancel/);
  assert.match(cancelBody, /requestRef\.current = null/);
  assert.doesNotMatch(cancelBody, /onDraftChange|transcribe\(/);
});
