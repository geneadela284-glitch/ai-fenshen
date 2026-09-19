import crypto from 'node:crypto';
import path from 'node:path';

import { attachmentError } from './contract.js';

const TYPES = Object.freeze({
  'image/jpeg': Object.freeze({ extensions: new Set(['jpg', 'jpeg']), extension: 'jpg' }),
  'image/png': Object.freeze({ extensions: new Set(['png']), extension: 'png' }),
  'image/webp': Object.freeze({ extensions: new Set(['webp']), extension: 'webp' })
});
const BLOCKED_EXTENSION_PARTS = new Set([
  'svg', 'gif', 'heic', 'heif', 'pdf', 'doc', 'docx', 'xls', 'xlsx',
  'zip', 'rar', '7z', 'tar', 'gz', 'exe', 'dll', 'bat', 'cmd', 'com',
  'msi', 'js', 'mjs', 'cjs', 'sh', 'app', 'dmg', 'pkg'
]);

function cleanDisplayName(value) {
  const raw = String(value || '').replaceAll('\\', '/');
  const basename = path.posix.basename(raw);
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return cleaned || 'upload';
}

function assertFilename(value, declaredMime) {
  const originalFilename = cleanDisplayName(value);
  const pieces = originalFilename.toLowerCase().split('.');
  if (pieces.length < 2) throw attachmentError('UNSUPPORTED_FILE_TYPE');
  const extension = pieces.at(-1);
  const expected = TYPES[declaredMime];
  if (!expected || !expected.extensions.has(extension)) {
    throw attachmentError('UNSUPPORTED_FILE_TYPE');
  }
  if (pieces.slice(1, -1).some((piece) => BLOCKED_EXTENSION_PARTS.has(piece))) {
    throw attachmentError('UNSUPPORTED_FILE_TYPE');
  }
  return { originalFilename, extension: expected.extension };
}

function detectedMime(buffer) {
  if (buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function pngDimensions(buffer) {
  if (buffer.length < 33 ||
      buffer.toString('ascii', 12, 16) !== 'IHDR' ||
      !buffer.includes(Buffer.from('IDAT')) ||
      !buffer.includes(Buffer.from('IEND'))) {
    throw attachmentError('FILE_CORRUPT');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer) {
  if (buffer.length < 16 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) {
    throw attachmentError('FILE_CORRUPT');
  }
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw attachmentError('FILE_CORRUPT');
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) throw attachmentError('FILE_CORRUPT');
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5)
      };
    }
    offset += length;
  }
  throw attachmentError('FILE_CORRUPT');
}

function uint24le(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function webpDimensions(buffer) {
  const declaredSize = buffer.readUInt32LE(4) + 8;
  if (buffer.length < 20 || declaredSize > buffer.length) throw attachmentError('FILE_CORRUPT');
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const type = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (data + size > buffer.length) throw attachmentError('FILE_CORRUPT');
    if (type === 'VP8X' && size >= 10) {
      return {
        width: uint24le(buffer, data + 4) + 1,
        height: uint24le(buffer, data + 7) + 1
      };
    }
    if (type === 'VP8L' && size >= 5 && buffer[data] === 0x2f) {
      const bits = buffer.readUInt32LE(data + 1);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1
      };
    }
    if (type === 'VP8 ' && size >= 10 &&
        buffer[data + 3] === 0x9d && buffer[data + 4] === 0x01 && buffer[data + 5] === 0x2a) {
      return {
        width: buffer.readUInt16LE(data + 6) & 0x3fff,
        height: buffer.readUInt16LE(data + 8) & 0x3fff
      };
    }
    offset = data + size + (size % 2);
  }
  throw attachmentError('FILE_CORRUPT');
}

export function validateImageFile({
  name,
  declaredMimeType,
  buffer,
  limits
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw attachmentError('FILE_EMPTY');
  }
  if (buffer.length > limits.maxFileBytes) {
    throw attachmentError('FILE_TOO_LARGE', { status: 413 });
  }
  const declared = String(declaredMimeType || '').trim().toLowerCase();
  if (!TYPES[declared]) throw attachmentError('UNSUPPORTED_FILE_TYPE');
  const { originalFilename, extension } = assertFilename(name, declared);
  const actualMime = detectedMime(buffer);
  if (!actualMime) throw attachmentError('FILE_CORRUPT');
  if (actualMime !== declared) throw attachmentError('MIME_SIGNATURE_MISMATCH');
  const dimensions = actualMime === 'image/png'
    ? pngDimensions(buffer)
    : actualMime === 'image/jpeg'
      ? jpegDimensions(buffer)
      : webpDimensions(buffer);
  if (!Number.isSafeInteger(dimensions.width) || dimensions.width <= 0 ||
      !Number.isSafeInteger(dimensions.height) || dimensions.height <= 0) {
    throw attachmentError('FILE_CORRUPT');
  }
  if (dimensions.width * dimensions.height > limits.maxImagePixels) {
    throw attachmentError('IMAGE_DIMENSION_LIMIT_EXCEEDED');
  }
  return {
    originalFilename,
    extension,
    declaredMimeType: declared,
    mimeType: actualMime,
    mediaKind: 'image',
    byteSize: buffer.length,
    width: dimensions.width,
    height: dimensions.height,
    checksumSha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    buffer
  };
}
