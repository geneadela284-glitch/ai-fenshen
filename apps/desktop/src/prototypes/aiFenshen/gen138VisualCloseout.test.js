import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const source = (file) => readFile(new URL(file, root), 'utf8');
const publicAsset = (file) => readFile(new URL(`../../../public/prototype/ai-fenshen/${file}`, root));

function jpegDimensions(buffer) {
  assert.equal(buffer[0], 0xff);
  assert.equal(buffer[1], 0xd8);

  let offset = 2;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < buffer.length) {
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const segmentLength = buffer.readUInt16BE(offset);
    if (startOfFrameMarkers.has(marker)) {
      return {
        width: buffer.readUInt16BE(offset + 5),
        height: buffer.readUInt16BE(offset + 3)
      };
    }
    offset += segmentLength;
  }
  throw new Error('JPEG dimensions not found');
}

test('day theme serves the approved portrait source without runtime softening', async () => {
  const [css, state, portrait] = await Promise.all([
    source('aiFenshenPrototype.css'),
    source('prototypeState.js'),
    publicAsset('home-day-20260910.jpg')
  ]);

  assert.deepEqual(jpegDimensions(portrait), { width: 606, height: 1280 });
  assert.match(
    state,
    /url\('\/prototype\/ai-fenshen\/home-day-20260910\.jpg'\)/
  );
  assert.match(
    css,
    /\[data-af-theme='day-sky'\]\s+\.af-home-avatar\s*\{[^}]*background-image:\s*var\(--af-avatar-asset\)[^}]*background-size:\s*cover[^}]*filter:\s*none/s
  );
  assert.doesNotMatch(css, /ai-fenshen-avatar-day-sky-landscape/);
});

test('portrait hero uses true cover geometry so wide iPhone viewports cannot expose a frame', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(
    css,
    /\.af-home-hero-visual\s*\{[^}]*top:\s*50%[^}]*left:\s*50%[^}]*width:\s*auto[^}]*height:\s*auto[^}]*min-width:\s*calc\(100% \+ 4px\)[^}]*min-height:\s*calc\(100% \+ 4px\)[^}]*aspect-ratio:\s*var\(--af-avatar-aspect-ratio\)[^}]*transform:\s*translate\(-50%,\s*-50%\)/s
  );
  assert.doesNotMatch(css, /\.af-home-hero-visual\s*\{[^}]*top:\s*0[^}]*height:\s*100%/s);
});

test('home wordmark preserves its original 68px floor and scales only on wider viewports', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(css, /\.af-wordmark-small \.af-wordmark-asset\s*\{\s*width:\s*clamp\(68px,\s*17vw,\s*86px\);\s*\}/);
});

test('day theme leaves the source ungraded and strengthens only local task bubble readability', async () => {
  const [css, state] = await Promise.all([
    source('aiFenshenPrototype.css'),
    source('prototypeState.js')
  ]);

  assert.match(
    css,
    /\[data-af-theme='day-sky'\]\s+\.af-home-avatar\s*\{[^}]*filter:\s*none/s
  );
  assert.match(state, /surfaceBlur:\s*'14px'/);
  assert.match(state, /glassFill:\s*'rgba\(4,\s*45,\s*96,\s*0\.38\)'/);
  assert.match(state, /glassBorder:\s*'rgba\(246,\s*253,\s*255,\s*0\.72\)'/);
  assert.match(state, /textPrimary:\s*'#ffffff'/);
  assert.match(
    css,
    /\[data-af-theme='day-sky'\]\s+\.af-home-vignette\s*\{[^}]*background:\s*transparent/s
  );
  assert.match(
    css,
    /\[data-af-theme='day-sky'\]\s+\.af-brain-label\s*\{[^}]*color:\s*var\(--af-text-primary\)[^}]*text-shadow:/s
  );
  assert.match(
    css,
    /\[data-af-theme='day-sky'\]\s+\.af-online\s*\{[^}]*background:\s*rgba\(4,\s*50,\s*104,\s*0\.28\)[^}]*backdrop-filter:\s*blur\(10px\)/s
  );
  assert.match(
    css,
    /\[data-af-theme='day-sky'\]\s+\.af-task-bubble-card\s*\{[^}]*rgba\(24,\s*96,\s*158,\s*0\.46\)[^}]*text-shadow:[^}]*backdrop-filter:\s*blur\(16px\)\s*saturate\(1\.24\)/s
  );
  assert.match(css, /\[data-af-theme='day-sky'\]\s+\.af-task-bubble-heading strong\s*\{[^}]*font-weight:\s*700/s);
  assert.match(css, /\[data-af-theme='day-sky'\]\s+\.af-task-bubble-item b\s*\{[^}]*font-weight:\s*650/s);
  assert.match(css, /\[data-af-theme='day-sky'\]\s+\.af-task-bubble-status\s*\{[^}]*font-weight:\s*600/s);
  assert.match(
    css,
    /\[data-af-theme='day-sky'\]\s+\.af-brain-function\s*\{[^}]*rgba\(15,\s*96,\s*166,\s*0\.42\)[^}]*color:\s*#ffffff[^}]*font-weight:\s*650[^}]*text-shadow:[^}]*0 0 22px rgba\(54,\s*190,\s*255,\s*0\.92\)/s
  );
  assert.match(
    css,
    /\[data-af-theme='day-sky'\]\s+\.af-brain-function \.af-icon\s*\{[^}]*invert\(100%\)[^}]*drop-shadow\(0 0 8px rgba\(72,\s*198,\s*255,\s*0\.96\)\)/s
  );
  assert.doesNotMatch(css, /\.af-prototype-canvas\s*\{[^}]*filter:/s);
});

test('day wordmark uses the permanent asset with a restrained legibility shadow', async () => {
  const [css, wordmark] = await Promise.all([
    source('aiFenshenPrototype.css'),
    source('AIFenshenWordmark.jsx')
  ]);

  assert.match(wordmark, /ai-fenshen-logo-primary\.png/);
  assert.match(css, /\[data-af-theme='day-sky'\]\s+\.af-wordmark-asset\s*\{[^}]*drop-shadow\(0 1px 2px rgba\(0,\s*39,\s*94,\s*0\.88\)\)/s);
});

test('day hero anchors the brain to the approved source geometry without stretching', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(
    css,
    /\[data-af-theme='day-sky'\]\s+\.af-home-hero-visual\s*\{[^}]*--brain-center-x:\s*var\(--af-brain-center-x\)[^}]*--brain-center-y:\s*var\(--af-brain-center-y\)/s
  );
  assert.doesNotMatch(
    css,
    /\[data-af-theme='day-sky'\]\s+\.af-home-hero-visual\s*\{[^}]*(?:inset:|width:\s*calc|aspect-ratio:\s*auto|transform:\s*none)/s
  );
  assert.match(css, /\.af-home-hero-visual\s*\{[^}]*aspect-ratio:\s*var\(--af-avatar-aspect-ratio\)/s);
  assert.match(css, /\.af-home-avatar\s*\{[^}]*background-size:\s*cover[^}]*filter:\s*none/s);
  assert.doesNotMatch(css, /\.af-brain-avatar\s*\{[^}]*(?:right:|100vw|100vh)/s);
});

test('dual task bubbles remain true circles inside the requested mobile bounds', async () => {
  const css = await source('aiFenshenPrototype.css');

  assert.match(
    css,
    /\.af-task-bubble\.is-tomorrow\s*\{[^}]*top:\s*calc\(132px[^}]*left:\s*max\(24px/s
  );
  assert.match(
    css,
    /\.af-task-bubble\.is-today\s*\{[^}]*bottom:\s*calc\(var\(--af-safe-bottom\)\s*\+\s*132px\)[^}]*left:\s*max\(32px/s
  );
  assert.match(
    css,
    /\.af-task-bubble-card\s*\{[^}]*width:\s*clamp\(116px,\s*34vw,\s*136px\)[^}]*aspect-ratio:\s*1[^}]*border-radius:\s*50%/s
  );
  assert.match(
    css,
    /\.af-task-bubble-card\s*\{[^}]*backdrop-filter:\s*blur\(14px\)\s*saturate\(1\.32\)/s
  );
  assert.match(
    css,
    /@media\s*\(orientation:\s*landscape\)\s*and\s*\(max-height:\s*500px\)[\s\S]*\.af-task-bubble-card\s*\{[^}]*width:\s*100px/s
  );
});

test('closed brain state does not render a permanent function ring', async () => {
  const home = await source('HomeAmbientScene.jsx');
  const brain = await source('AIBrainAvatar.jsx');

  assert.match(home, /const brainOpen = homeState === 'brainOpen'/);
  assert.match(brain, /open=\{open\}/);
  assert.match(brain, /<BrainFunctionRing/);
});

test('brain functions orbit one responsive center by radius and angle instead of handwritten x y points', async () => {
  const [ring, css] = await Promise.all([
    source('BrainFunctionRing.jsx'),
    source('aiFenshenPrototype.css')
  ]);

  assert.match(ring, /BRAIN_FUNCTION_ORBIT_ANGLES/);
  assert.match(ring, /--brain-orbit-angle/);
  assert.match(ring, /--brain-orbit-counter-angle/);
  assert.match(ring, /af-brain-orbit-slot/);
  assert.doesNotMatch(ring, /BRAIN_FUNCTION_POSITIONS/);
  assert.doesNotMatch(ring, /animate=\{\{[^}]*\bx:/s);
  assert.match(
    css,
    /\.af-brain-avatar\s*\{[^}]*--brain-orbit-radius:\s*clamp\([^}]*left:\s*var\(--brain-center-x\)[^}]*top:\s*var\(--brain-center-y\)/s
  );
  assert.match(
    css,
    /\.af-brain-orbit-slot\s*\{[^}]*left:\s*50%[^}]*top:\s*50%[^}]*rotate\(var\(--brain-orbit-angle\)\)[^}]*translateX\(var\(--brain-orbit-radius\)\)/s
  );
});
