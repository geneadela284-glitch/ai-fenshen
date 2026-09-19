import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttachmentParser } from './AttachmentParser.js';

test('prepares an uploaded image as a data URL for a real vision request', async () => {
  const parser = new AttachmentParser();
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  const file = {
    name: 'sample.png',
    type: 'image/png',
    size: bytes.length,
    async arrayBuffer() {
      return bytes.buffer;
    }
  };

  const result = await parser.parse(file);

  assert.equal(result.parsed, true);
  assert.equal(result.contentType, 'image');
  assert.equal(result.metadata.visionRequired, true);
  assert.match(result.imageDataUrl, /^data:image\/png;base64,/);
});
