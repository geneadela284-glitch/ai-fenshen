import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('./', import.meta.url);
const source = (file) => readFile(new URL(file, root), 'utf8');
const publicAsset = (file) => readFile(new URL(`../../../public/prototype/ai-fenshen/${file}`, root));

function pngDimensions(buffer) {
  assert.equal(buffer.toString('ascii', 1, 4), 'PNG');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

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

test('the permanent AI分身 brand uses one real transparent logo asset at every wordmark placement', async () => {
  const [wordmark, css, logo] = await Promise.all([
    source('AIFenshenWordmark.jsx'),
    source('aiFenshenPrototype.css'),
    publicAsset('ai-fenshen-logo-primary.png')
  ]);

  const { width, height } = pngDimensions(logo);
  assert.ok(width >= 512);
  assert.ok(height >= 512);
  assert.match(wordmark, /src="\/prototype\/ai-fenshen\/ai-fenshen-logo-primary\.png"/);
  assert.match(wordmark, /className="af-wordmark-asset"/);
  assert.doesNotMatch(wordmark, /af-wordmark-echo|af-wordmark-orbit|af-wordmark-ai|af-wordmark-twin/);
  assert.match(css, /\.af-wordmark-asset\s*\{[^}]*object-fit:\s*contain/s);
});

test('home themes serve the exact approved day and night source images', async () => {
  const [{ getThemeTokens }, night, day] = await Promise.all([
    import('./prototypeState.js'),
    publicAsset('home-night-20260910.jpg'),
    publicAsset('home-day-20260910.jpg')
  ]);

  assert.deepEqual(jpegDimensions(night), { width: 609, height: 1280 });
  assert.deepEqual(jpegDimensions(day), { width: 606, height: 1280 });
  assert.equal(createHash('sha256').update(night).digest('hex'), 'a2eae6524d4fb65eeca71bc08e50763ae4aeca44755c11b4f9e29e0f1d64f5d4');
  assert.equal(createHash('sha256').update(day).digest('hex'), '81b6385192e53656c99f6336733692d8a0e79530dc00b3cd0ebbaa2a9ff812a4');
  const nightTheme = getThemeTokens('deep-blue');
  const dayTheme = getThemeTokens('day-sky');
  assert.equal(nightTheme.avatarAsset, "url('/prototype/ai-fenshen/home-night-20260910.jpg')");
  assert.equal(dayTheme.avatarAsset, "url('/prototype/ai-fenshen/home-day-20260910.jpg')");
  assert.equal(nightTheme.avatarAspectRatio, '609 / 1280');
  assert.equal(dayTheme.avatarAspectRatio, '606 / 1280');
  assert.equal(nightTheme.brainCenterX, '82.1018%');
  assert.equal(dayTheme.brainCenterX, '82.5083%');
  assert.equal(nightTheme.brainCenterY, '44.1406%');
  assert.equal(dayTheme.brainCenterY, '44.1406%');
});
