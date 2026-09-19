import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('./MeetingPlaybackPanel.css', import.meta.url));
const css = await readFile(cssPath, 'utf8');

test('playback panel is mobile-first, safe-area aware, and prevents horizontal overflow', () => {
  assert.match(css, /min-width:\s*320px/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /max-width:\s*100%/);
});

test('transcript window is bounded and player does not cover it', () => {
  assert.match(css, /max-height:/);
  assert.match(css, /overflow-y:\s*auto/);
  assert.match(css, /scroll-padding-bottom/);
  assert.match(css, /position:\s*relative/);
});

test('day and night themes use the existing AI Secretary tokens', () => {
  assert.match(css, /var\(--surface-background\)/);
  assert.match(css, /var\(--primary-text\)/);
  assert.match(css, /var\(--accent-color\)/);
  assert.match(css, /var\(--border-color\)/);
});
