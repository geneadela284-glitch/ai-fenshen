import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const cssUrl = new URL('./MeetingRecordingExperience.css', import.meta.url);

test('recording surface uses every AI分身 semantic token with a fallback', async () => {
  const css = await readFile(cssUrl, 'utf8');
  for (const token of [
    '--af-surface', '--af-surface-strong', '--af-text-primary', '--af-text-secondary',
    '--af-border-subtle', '--af-primary', '--af-danger', '--af-focus-ring'
  ]) {
    assert.match(css, new RegExp(`var\\(${token},\\s*[^)]+\\)`), `${token} lacks fallback`);
  }
});

test('mobile-first controls are touch safe and protect all safe areas without overflow', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /\.meeting-stage3c-recording-root\s*\{[^}]*box-sizing:\s*border-box[^}]*width:\s*100%[^}]*max-width:\s*100%[^}]*overflow-x:\s*(?:clip|hidden)/s);
  assert.match(css, /\.meeting-stage3c-recording-button\s*\{[^}]*(?:min-height|height):\s*48px/s);
  assert.match(css, /env\(safe-area-inset-left\)/);
  assert.match(css, /env\(safe-area-inset-right\)/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.meeting-stage3c-recording-dialog-backdrop\s*\{[^}]*min-height:\s*100dvh/s);
});

test('future recording states preserve horizontal safe-area fallback', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(
    css,
    /\.meeting-stage3c-recording-root\[data-recording-state\]\s*\{[^}]*padding:\s*0\s+max\(16px,\s*env\(safe-area-inset-right\)\)\s+0\s+max\(16px,\s*env\(safe-area-inset-left\)\)/s
  );
});

test('desktop remains one focused card and mobile rules begin at 320px', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /\.meeting-stage3c-recording-card\s*\{[^}]*max-width:\s*(?:[3-6]\d{2}px|[2-4]\drem)/s);
  assert.match(css, /@media\s*\(min-width:\s*640px\)/);
  assert.doesNotMatch(css, /grid-template-columns:\s*repeat\(3|grid-template-columns:\s*[^;]+\s+[^;]+\s+[^;]+/);
  assert.doesNotMatch(css, /\btable\b|admin|dashboard/i);
});

test('glass styling is restrained and red selectors are scoped to true recording and final confirmation', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /backdrop-filter:\s*blur\(/);
  assert.match(css, /\.meeting-stage3c-recording-card\s*\{[^}]*border:/s);
  assert.match(css, /\.meeting-stage3c-recording-root\[data-recording=['"]true['"]\]/);
  assert.match(css, /\.meeting-stage3c-recording-confirm/);
  const dangerBlocks = [...css.matchAll(/([^{}]+)\{([^{}]*var\(--af-danger[^{}]*)\}/g)];
  assert.ok(dangerBlocks.length >= 2);
  assert.ok(
    dangerBlocks.every((match) => /data-recording|confirm|recording-dot/.test(match[1])),
    `unscoped danger use: ${dangerBlocks.map((match) => match[1].trim()).join(' | ')}`
  );
});

test('recording controls expose explicit start, pause, and end semantic color hooks', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const source = await readFile(new URL('./MeetingRecordingExperience.jsx', import.meta.url), 'utf8');
  assert.match(source, /meeting-stage3c-recording-button--start/);
  assert.match(source, /meeting-stage3c-recording-button--pause/);
  assert.match(source, /meeting-stage3c-recording-button--end/);
  assert.match(css, /meeting-stage3c-recording-button--start[\s\S]*#86f1c7/);
  assert.match(css, /meeting-stage3c-recording-button--pause[\s\S]*#86f1c7/);
  assert.match(css, /meeting-stage3c-recording-button--end[\s\S]*#ff6487/);
});

test('measured bars have no fake animation or random waveform source and reduced motion disables decoration', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /\.meeting-stage3c-recording-waveform-bar\s*\{[^}]*height:\s*var\(--meeting-stage3c-measured-height\)/s);
  assert.doesNotMatch(css, /Math\.random|random\(|@keyframes\s+[^\s{]*(wave|bar|meter)|animation[^;]*(wave|bar|meter)/i);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?(animation|transition):\s*none/s);
});

test('all CSS selectors stay component-scoped', async () => {
  const css = await readFile(cssUrl, 'utf8');
  const selectorBlocks = css.match(/(?:^|\})\s*([^@][^{}]*)\{/gm) || [];
  for (const block of selectorBlocks) {
    const selectorText = block.trim().replace(/^}[\s}]*/, '').replace(/\{$/, '').trim();
    if (selectorText.startsWith('@')) continue;
    for (const selector of selectorText.split(',')) {
      assert.match(selector.trim(), /^\.meeting-stage3c-recording-/, `unscoped selector: ${selector.trim()}`);
    }
  }
});
