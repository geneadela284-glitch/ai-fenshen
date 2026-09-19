import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addSelectedImages,
  releaseAttachmentPreviews,
  removeSelectedImage
} from './imageAttachmentSelection.js';

function file(name, type, size = 16, lastModified = 1) {
  return new File([new Uint8Array(size)], name, { type, lastModified });
}

test('selection accepts JPEG PNG WebP, limits to three and rejects duplicates before upload', async () => {
  const urls = [];
  const createObjectURL = (value) => {
    const url = `blob:${value.name}`;
    urls.push(url);
    return url;
  };
  const first = await addSelectedImages([], [
    file('one.jpg', 'image/jpeg'),
    file('two.png', 'image/png'),
    file('three.webp', 'image/webp')
  ], { createObjectURL, idFactory: (value) => `local-${value.name}` });
  assert.equal(first.items.length, 3);
  assert.deepEqual(first.items.map((item) => item.status), ['selected', 'selected', 'selected']);
  assert.equal(first.errors.length, 0);

  const duplicateAndFourth = await addSelectedImages(first.items, [
    file('one.jpg', 'image/jpeg'),
    file('four.png', 'image/png')
  ], { createObjectURL, idFactory: (value) => `local-${value.name}` });
  assert.equal(duplicateAndFourth.items.length, 3);
  assert.equal(duplicateAndFourth.errors.some((error) => error.code === 'DUPLICATE_ATTACHMENT'), true);
  assert.equal(duplicateAndFourth.errors.some((error) => error.code === 'TOO_MANY_ATTACHMENTS'), true);
});

test('selection rejects unsupported and oversized files with explicit stable errors', async () => {
  const result = await addSelectedImages([], [
    file('document.pdf', 'application/pdf'),
    file('large.png', 'image/png', 8 * 1024 * 1024 + 1)
  ], { createObjectURL: () => 'blob:unused' });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.errors.map((error) => error.code), [
    'DOCUMENT_PHASE_NOT_AVAILABLE',
    'FILE_TOO_LARGE'
  ]);
  assert.equal(
    result.errors[0].message,
    'PDF、Word、Excel将在后续文档阶段开放'
  );
});

test('HEIC input is converted only through a verified browser decoder and never relabelled', async () => {
  const original = file('photo.HEIC', 'image/heic');
  const converted = file('photo.jpg', 'image/jpeg', 128, original.lastModified);
  const calls = [];
  const result = await addSelectedImages([], [original], {
    convertHeic: async (value) => {
      calls.push(value);
      return converted;
    },
    createObjectURL: () => 'blob:converted'
  });
  assert.equal(calls.length, 1);
  assert.equal(result.items[0].file, converted);
  assert.equal(result.items[0].convertedFromHeic, true);
  assert.equal(result.items[0].file.type, 'image/jpeg');
});

test('HEIC decode failure is explicit and prevents adding or uploading the file', async () => {
  const result = await addSelectedImages([], [file('photo.heif', 'image/heif')], {
    convertHeic: async () => {
      const error = new Error('decode failed');
      error.code = 'HEIC_CONVERSION_UNAVAILABLE';
      throw error;
    },
    createObjectURL: () => 'blob:must-not-exist'
  });
  assert.equal(result.items.length, 0);
  assert.deepEqual(result.errors.map((error) => error.code), ['HEIC_CONVERSION_UNAVAILABLE']);
});

test('removal and release revoke every local object URL exactly once', async () => {
  const revoked = [];
  const selected = await addSelectedImages([], [
    file('one.png', 'image/png'),
    file('two.png', 'image/png')
  ], {
    createObjectURL: (value) => `blob:${value.name}`,
    idFactory: (value) => value.name
  });
  const remaining = removeSelectedImage(selected.items, 'one.png', {
    revokeObjectURL: (url) => revoked.push(url)
  });
  releaseAttachmentPreviews(remaining, {
    revokeObjectURL: (url) => revoked.push(url)
  });
  assert.deepEqual(revoked, ['blob:one.png', 'blob:two.png']);
});
