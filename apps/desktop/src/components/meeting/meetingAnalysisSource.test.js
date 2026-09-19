import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMeetingAnalysisSource } from './meetingAnalysisSource.js';

function source(overrides = {}) {
  return {
    sourceId: 'recorded-meeting-a',
    meetingId: 'meeting-a',
    ownerId: 'owner-a',
    scope: 'meeting',
    origin: 'recorded',
    importState: 'committed',
    revision: 1,
    checksum: 'a'.repeat(64),
    durationMs: 180_000,
    ...overrides
  };
}

function transcript(endMs) {
  return {
    segments: [{ startMs: 179_000, endMs, text: '会议结尾。' }]
  };
}

test('Meeting analysis accepts only bounded AAC/MP4 timeline drift at the integration boundary', () => {
  const original = source({ format: 'm4a', mimeType: 'audio/mp4;codecs=mp4a.40.2' });
  const resolved = resolveMeetingAnalysisSource(original, transcript(181_250));

  assert.equal(resolved.durationMs, 181_250);
  assert.equal(original.durationMs, 180_000);
  assert.equal(resolved.sourceId, original.sourceId);
  assert.equal(resolved.revision, original.revision);
  assert.equal(resolved.checksum, original.checksum);
});

test('Meeting analysis keeps the original source for material timeline drift', () => {
  const original = source({ format: 'm4a', mimeType: 'audio/mp4;codecs=mp4a.40.2' });
  const resolved = resolveMeetingAnalysisSource(original, transcript(181_501));

  assert.equal(resolved, original);
});

test('Meeting analysis does not apply AAC tolerance to an unclassified m4a MIME', () => {
  const original = source({ format: 'm4a', mimeType: 'audio/m4a' });
  const resolved = resolveMeetingAnalysisSource(original, transcript(181_001));

  assert.equal(resolved, original);
});

test('Meeting analysis does not change a source when transcript bounds already fit', () => {
  const original = source({ format: 'm4a', mimeType: 'audio/mp4;codecs=mp4a.40.2' });

  assert.equal(resolveMeetingAnalysisSource(original, transcript(180_000)), original);
});
