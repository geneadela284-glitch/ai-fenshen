import { execFile } from 'node:child_process';
import { attachmentError } from './contract.js';

// Read only the bounded JPEG EXIF orientation field; never rewrite the original.
export function jpegOrientation(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset++] !== 0xff) return 1;
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xda || marker === 0xd9) return 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return 1;
    const length = buffer.readUInt16BE(offset);
    const end = offset + length;
    if (length < 2 || end > buffer.length) return 1;
    const start = offset + 2;
    if (marker === 0xe1 && end - start >= 14 && buffer.toString('ascii', start, start + 6) === 'Exif\0\0') {
      const tiff = start + 6;
      const order = buffer.toString('ascii', tiff, tiff + 2);
      if (order !== 'II' && order !== 'MM') return 1;
      const u16 = at => order === 'II' ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
      const u32 = at => order === 'II' ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
      if (u16(tiff + 2) !== 42) return 1;
      const ifd = tiff + u32(tiff + 4);
      if (ifd < tiff + 8 || ifd + 2 > end) return 1;
      const count = u16(ifd);
      for (let i = 0; i < count; i += 1) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > end) return 1;
        if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
          const value = u16(entry + 8);
          return value >= 1 && value <= 8 ? value : 1;
        }
      }
    }
    offset = end;
  }
  return 1;
}

export function orientationFilter(buffer) {
  return ({ 2: 'hflip,', 3: 'hflip,vflip,', 4: 'vflip,',
    5: 'transpose=clock,hflip,', 6: 'transpose=clock,',
    7: 'transpose=clock,vflip,', 8: 'transpose=cclock,' })[jpegOrientation(buffer)] || '';
}

let active = 0;
const waiting = [];
// Preview copies are generated in memory after the caller verifies ownership.
// Originals are never rewritten and image input cannot refer to network resources.
export async function createImagePreview(buffer) {
  if (active >= 1) {
    if (waiting.length >= 12) throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 });
    await new Promise(resolve => waiting.push(resolve));
  } else active += 1;
  try {
    return await new Promise((resolve, reject) => {
      const child = execFile('ffmpeg', [
        '-v', 'error', '-nostdin', '-max_alloc', '134217728', '-threads', '1',
        '-filter_threads', '1', '-filter_complex_threads', '1', '-protocol_whitelist', 'pipe', '-noautorotate', '-i', 'pipe:0', '-frames:v', '1',
        '-vf', orientationFilter(buffer) + "scale='min(1200,iw)':'min(1200,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuvj420p",
        '-threads', '1', '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'
      ], { encoding: 'buffer', timeout: 10000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' }, (error, stdout) => {
        if (error || !stdout?.length || stdout[0] !== 255 || stdout[1] !== 216) {
          reject(attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 }));
        } else resolve(stdout);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(buffer);
    });
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }
}
