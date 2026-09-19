import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const css = await readFile(fileURLToPath(new URL('./MeetingFuturePunk.css', import.meta.url)), 'utf8');
const source = await readFile(fileURLToPath(new URL('../MeetingCenter.jsx', import.meta.url)), 'utf8');
const primitives = await readFile(fileURLToPath(new URL('./FuturePunkPrimitives.jsx', import.meta.url)), 'utf8');

test('Future-Punk integration is scoped, mobile-first, safe-area aware, and reduced-motion friendly', () => {
  assert.match(source, /meeting-future-punk/);
  assert.match(source, /MeetingAnalysisPanel/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /background[^;]*#070914/);
  assert.match(css, /--meeting-future-cyan/);
});

test('desktop detail keeps the approved three-surface hierarchy while mobile preserves the single reading flow', () => {
  assert.match(source, /meeting-future-punk__detail-layout/);
  assert.match(source, /meeting-future-punk__main-slot/);
  assert.match(source, /meeting-future-punk__context-slot/);
  const playbackIndex = source.indexOf('<MeetingPlaybackPanel');
  const analysisIndex = source.indexOf('<MeetingAnalysisPanel');
  const transcriptIndex = source.indexOf('<Section title="原始转写">');
  assert.ok(playbackIndex >= 0 && analysisIndex > playbackIndex && transcriptIndex > analysisIndex);
  assert.match(css, /\.af-prototype-canvas:has\(\.meeting-future-punk\)/);
  assert.match(css, /grid-template-columns:\s*264px\s+minmax\(0, 1fr\)/);
  assert.match(css, /grid-template-columns:\s*minmax\(0, 1fr\)\s+360px/);
  assert.match(css, /\.meeting-future-punk__main-slot[\s\S]*grid-column:\s*1/);
});

test('Meeting detail wires the visible AI整理 action to the owner-scoped analysis manager', () => {
  assert.match(source, /manager\.analysis\.analyze/);
  assert.match(source, /analysisOperation/);
  assert.match(source, /onAnalyze/);
});

test('Meeting topbar centers the official AI分身 logo and keeps controls translucent and non-obstructive', () => {
  assert.match(primitives, /meeting-v1-brand__orb/);
  assert.doesNotMatch(primitives, /AISecretaryLogo/);
  assert.match(source, /className="meeting-v1-topbar/);
  assert.match(css, /grid-template-columns:\s*48px\s+minmax\(0, 1fr\)\s+48px/);
  assert.match(css, /\.meeting-v1-top-action[\s\S]*width:\s*48px[\s\S]*height:\s*48px/);
  assert.match(css, /background:\s*rgba\(15, 18, 47, 0\.48\)/);
  assert.match(css, /\.meeting-v1-topbar[\s\S]*position:\s*relative/);
});
