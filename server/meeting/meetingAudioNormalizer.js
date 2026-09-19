import { spawn as defaultSpawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMp4ContainerValidator } from '../../core/meeting/stage3a/mp4Container.js';

export const MEETING_AUDIO_NORMALIZATION_FAILED = 'MEETING_AUDIO_NORMALIZATION_FAILED';
export const TRANSCRIPTION_CANCELLED = 'TRANSCRIPTION_CANCELLED';
export const MEETING_AUDIO_NORMALIZATION_TEMP_PREFIX = 'meeting-asr-normalize-';
const MIN_ASR_WINDOW_DURATION_MS = 1_000;
const NORMALIZATION_LEASE_FILE = 'lease.json';
const NORMALIZATION_ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const activeNormalizationTemps = new Set();

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizedText(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function inferMeetingAudioFormat({ format, mimeType, fileName } = {}) {
  const declaredFormat = normalizedText(format);
  if (declaredFormat && !['recorded', 'imported', 'unknown'].includes(declaredFormat)) return declaredFormat;
  const mime = normalizedText(mimeType);
  if (mime.includes('webm')) return 'webm-opus';
  if (mime.includes('wav') || mime.includes('wave')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a';
  if (mime.includes('aac')) return 'aac';
  const extension = path.extname(String(fileName || '')).toLowerCase();
  if (extension === '.webm') return 'webm-opus';
  if (extension === '.wav') return 'wav';
  if (extension === '.mp3') return 'mp3';
  if (extension === '.m4a' || extension === '.mp4') return 'm4a';
  if (extension === '.aac') return 'aac';
  return declaredFormat || 'unknown';
}

function extensionForFormat(format) {
  switch (format) {
    case 'webm-opus': return 'webm';
    case 'm4a': return 'm4a';
    case 'mp3': return 'mp3';
    case 'aac': return 'aac';
    case 'wav': return 'wav';
    default: return 'audio';
  }
}

function safeFileName(value, fallback) {
  const candidate = path.basename(String(value || '').replace(/[\u0000-\u001f]/g, '_')).trim();
  return candidate || fallback;
}

function wavOutputName(fileName) {
  const safe = safeFileName(fileName, 'meeting-chunk.webm');
  const withoutExtension = safe.replace(/\.[^.]*$/, '') || 'meeting-chunk';
  return `${withoutExtension}.wav`;
}

function isWebmInput({ format, mimeType, fileName } = {}) {
  return inferMeetingAudioFormat({ format, mimeType, fileName }) === 'webm-opus';
}

function isMp4Input({ format, mimeType, fileName } = {}) {
  return inferMeetingAudioFormat({ format, mimeType, fileName }) === 'm4a';
}

function isContainerInput(input = {}) {
  return isWebmInput(input) || isMp4Input(input);
}

function parseWavMetadata(buffer, { allowTruncatedData = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) {
      if (allowTruncatedData && chunkId === 'data' && chunkSize > 0) {
        data = { offset: chunkStart, length: chunkSize };
        break;
      }
      return null;
    }
    if (chunkId === 'fmt ' && chunkSize >= 16) {
      fmt = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        byteRate: buffer.readUInt32LE(chunkStart + 8),
        blockAlign: buffer.readUInt16LE(chunkStart + 12),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    }
    if (chunkId === 'data' && chunkSize > 0) data = { offset: chunkStart, length: chunkSize };
    offset = chunkEnd + (chunkSize % 2);
  }
  if (!fmt || !data || fmt.audioFormat !== 1 || fmt.channels !== 1 || fmt.sampleRate !== 16_000 || fmt.bitsPerSample !== 16 || fmt.blockAlign !== 2) return null;
  return Object.freeze({
    ...fmt,
    dataOffset: data.offset,
    dataLength: data.length,
    durationMs: Math.round((data.length / fmt.blockAlign / fmt.sampleRate) * 1000)
  });
}

function validWavMetadata(buffer) {
  const metadata = parseWavMetadata(buffer);
  return Boolean(metadata && metadata.dataOffset + metadata.dataLength <= buffer.length && metadata.dataLength > 0);
}

function normalizationError(details = {}) {
  return Object.assign(codedError(MEETING_AUDIO_NORMALIZATION_FAILED), details);
}

function runFfmpeg({ spawnImpl, ffmpegPath, inputPath, outputPath, signal }) {
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let aborted = false;
    const finish = (error = null, result = undefined) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => {
      aborted = true;
      try { child?.kill('SIGTERM'); } catch {}
      finish(codedError(TRANSCRIPTION_CANCELLED));
    };

    if (signal?.aborted) {
      finish(codedError(TRANSCRIPTION_CANCELLED));
      return;
    }
    try {
      child = spawnImpl(ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-i', inputPath,
        '-vn', '-ac', '1', '-ar', '16000', '-sample_fmt', 's16', '-f', 'wav', outputPath
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr?.resume?.();
    } catch {
      finish(normalizationError({ ffmpegExitCode: null }));
      return;
    }
    child.once('error', () => finish(aborted ? codedError(TRANSCRIPTION_CANCELLED) : normalizationError({ ffmpegExitCode: null })));
    child.once('close', (code) => {
      if (aborted) return finish(codedError(TRANSCRIPTION_CANCELLED));
      if (code !== 0) return finish(normalizationError({ ffmpegExitCode: Number.isInteger(code) ? code : null }));
      finish(null, { ffmpegExitCode: 0 });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function readWavFileMetadata(filePath) {
  let handle;
  try {
    handle = await open(filePath, 'r');
    const stats = await handle.stat();
    const header = Buffer.alloc(Math.min(64 * 1024, Math.max(44, stats.size)));
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const metadata = parseWavMetadata(header.subarray(0, bytesRead), { allowTruncatedData: true });
    if (!metadata || metadata.dataOffset + metadata.dataLength > stats.size || metadata.dataLength % metadata.blockAlign !== 0) throw normalizationError();
    return metadata;
  } catch (error) {
    if (error?.code === MEETING_AUDIO_NORMALIZATION_FAILED) throw error;
    throw normalizationError();
  } finally {
    await handle?.close?.().catch?.(() => {});
  }
}

function wavHeader({ dataLength, sampleRate = 16_000, channels = 1, bitsPerSample = 16 }) {
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataLength, 40);
  return header;
}

async function writeWavSlice({ inputPath, outputPath, metadata, startFrame, endFrame }) {
  const firstFrame = Math.max(0, startFrame);
  const lastFrame = Math.min(Math.ceil(metadata.dataLength / metadata.blockAlign), endFrame);
  const frameCount = lastFrame - firstFrame;
  if (frameCount <= 0) throw normalizationError();
  const dataLength = frameCount * metadata.blockAlign;
  let inputHandle;
  let outputHandle;
  try {
    inputHandle = await open(inputPath, 'r');
    outputHandle = await open(outputPath, 'w', 0o600);
    await outputHandle.write(wavHeader({
      dataLength,
      sampleRate: metadata.sampleRate,
      channels: metadata.channels,
      bitsPerSample: metadata.bitsPerSample
    }));
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, dataLength));
    let remaining = dataLength;
    let position = metadata.dataOffset + firstFrame * metadata.blockAlign;
    while (remaining > 0) {
      const requested = Math.min(buffer.length, remaining);
      const { bytesRead } = await inputHandle.read(buffer, 0, requested, position);
      if (bytesRead !== requested) throw normalizationError();
      await outputHandle.write(buffer, 0, bytesRead);
      remaining -= bytesRead;
      position += bytesRead;
    }
  } catch (error) {
    if (error?.code === MEETING_AUDIO_NORMALIZATION_FAILED) throw error;
    throw normalizationError();
  } finally {
    await outputHandle?.close?.().catch?.(() => {});
    await inputHandle?.close?.().catch?.(() => {});
  }
  await chmod(outputPath, 0o600);
  return readWavFileMetadata(outputPath);
}

export function cleanupOrphanedNormalizationTemps({ root = os.tmpdir() } = {}) {
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(MEETING_AUDIO_NORMALIZATION_TEMP_PREFIX)) continue;
    try {
      const directory = path.resolve(root, entry.name);
      if (activeNormalizationTemps.has(directory)) continue;
      const directoryStats = lstatSync(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()
        || (process.getuid && directoryStats.uid !== process.getuid())) continue;
      const leasePath = path.join(directory, NORMALIZATION_LEASE_FILE);
      const leaseStats = lstatSync(leasePath);
      if (!leaseStats.isFile() || leaseStats.isSymbolicLink() || leaseStats.size > 1024) continue;
      if (Date.now() - Math.max(directoryStats.mtimeMs, leaseStats.mtimeMs) < NORMALIZATION_ORPHAN_MIN_AGE_MS) continue;
      const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
      if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0 || lease.hostname !== os.hostname()) continue;
      // Age alone never expires a live lease. PID reuse and EPERM conservatively
      // retain the directory; legacy/malformed/missing leases also stay intact.
      try {
        process.kill(lease.pid, 0);
        continue;
      } catch (error) {
        if (error?.code !== 'ESRCH') continue;
      }
      rmSync(directory, { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return removed;
}

async function createLeasedNormalizationTemp(tempRoot) {
  const directory = await mkdtemp(path.join(tempRoot, MEETING_AUDIO_NORMALIZATION_TEMP_PREFIX));
  activeNormalizationTemps.add(path.resolve(directory));
  try {
    // Publish ownership before any ffmpeg/file operation can yield to another
    // provider construction. Other processes also honor this on-disk lease.
    writeFileSync(path.join(directory, NORMALIZATION_LEASE_FILE), JSON.stringify({
      pid: process.pid, hostname: os.hostname()
    }), { flag: 'wx', mode: 0o600 });
    return directory;
  } catch (error) {
    await releaseNormalizationTemp(directory);
    throw error;
  }
}

async function releaseNormalizationTemp(directory) {
  try {
    await rm(directory, { recursive: true, force: true });
  } catch {
    // Leave the lease in place if cleanup fails; do not make a live file look orphaned.
  } finally {
    activeNormalizationTemps.delete(path.resolve(directory));
  }
}

export function createMeetingAudioNormalizer({
  ffmpegPath = process.env.MEETING_ASR_FFMPEG_PATH || 'ffmpeg',
  tempRoot = os.tmpdir(),
  spawnImpl = defaultSpawn
} = {}) {
  if (typeof spawnImpl !== 'function') throw codedError('MEETING_AUDIO_NORMALIZER_UNAVAILABLE');
  cleanupOrphanedNormalizationTemps({ root: tempRoot });

  async function normalizeChunk(chunk = {}) {
    const format = inferMeetingAudioFormat(chunk);
    const bytes = Buffer.isBuffer(chunk.bytes)
      ? Buffer.from(chunk.bytes)
      : chunk.bytes instanceof Uint8Array
        ? Buffer.from(chunk.bytes.buffer, chunk.bytes.byteOffset, chunk.bytes.byteLength)
        : null;
    if (!bytes || bytes.length === 0) throw codedError('XFYUN_AUDIO_BYTES_REQUIRED');
    const fileName = safeFileName(chunk.fileName, `meeting-chunk-${chunk.sequence ?? 0}.${extensionForFormat(format)}`);
    if (!isContainerInput({ ...chunk, format })) {
      return Object.freeze({
        ...chunk,
        bytes,
        fileName,
        mimeType: String(chunk.mimeType || (format === 'wav' ? 'audio/wav' : 'application/octet-stream')),
        format,
        cleanupStatus: 'not_required'
      });
    }

    if (chunk.signal?.aborted) throw codedError(TRANSCRIPTION_CANCELLED);
    let tempDirectory = null;
    try {
      if (isMp4Input({ ...chunk, format })) {
        const validator = createMp4ContainerValidator();
        const container = validator.acceptChunk(bytes);
        if (container.fragmentCount < 1) throw normalizationError({ containerErrorCode: 'MP4_MEDIA_FRAGMENT_REQUIRED' });
      }
      tempDirectory = await createLeasedNormalizationTemp(tempRoot);
      const inputPath = path.join(tempDirectory, `input.${extensionForFormat(format)}`);
      const outputPath = path.join(tempDirectory, 'output.wav');
      await writeFile(inputPath, bytes, { mode: 0o600 });
      await chmod(inputPath, 0o600);
      const ffmpeg = await runFfmpeg({ spawnImpl, ffmpegPath, inputPath, outputPath, signal: chunk.signal });
      await chmod(outputPath, 0o600);
      const normalizedBytes = await readFile(outputPath);
      if (!validWavMetadata(normalizedBytes)) throw normalizationError();
      return Object.freeze({
        ...chunk,
        bytes: normalizedBytes,
        fileName: wavOutputName(fileName),
        mimeType: 'audio/wav',
        format: 'wav',
        normalized: true,
        ffmpegExitCode: ffmpeg?.ffmpegExitCode ?? 0,
        cleanupStatus: 'completed'
      });
    } catch (error) {
      if (error?.code === TRANSCRIPTION_CANCELLED) throw error;
      if (error?.code === MEETING_AUDIO_NORMALIZATION_FAILED) throw error;
      throw normalizationError();
    } finally {
      if (tempDirectory) await releaseNormalizationTemp(tempDirectory);
    }
  }

  async function normalizeSourceFile({ inputPath, fileName = 'meeting-source.webm', mimeType = 'audio/webm;codecs=opus', format = 'webm-opus', signal } = {}) {
    const sourcePath = String(inputPath || '').trim();
    if (!sourcePath) throw normalizationError();
    const normalizedFormat = inferMeetingAudioFormat({ fileName, mimeType, format });
    if (!isContainerInput({ format: normalizedFormat, mimeType, fileName })) {
      const metadata = await readWavFileMetadata(sourcePath);
      return Object.freeze({
        path: sourcePath,
        fileName: safeFileName(fileName, 'meeting-source.wav'),
        mimeType: 'audio/wav',
        format: 'wav',
        normalized: false,
        metadata,
        cleanup: async () => {}
      });
    }
    if (signal?.aborted) throw codedError(TRANSCRIPTION_CANCELLED);
    let tempDirectory = null;
    let cleaned = false;
    try {
      tempDirectory = await createLeasedNormalizationTemp(tempRoot);
      const outputPath = path.join(tempDirectory, 'normalized-source.wav');
      const ffmpeg = await runFfmpeg({ spawnImpl, ffmpegPath, inputPath: sourcePath, outputPath, signal });
      await chmod(outputPath, 0o600);
      const metadata = await readWavFileMetadata(outputPath);
      const cleanup = async () => {
        if (cleaned) return;
        cleaned = true;
        await releaseNormalizationTemp(tempDirectory);
      };
      return Object.freeze({
        path: outputPath,
        fileName: wavOutputName(fileName),
        mimeType: 'audio/wav',
        format: 'wav',
        normalized: true,
        ffmpegExitCode: ffmpeg?.ffmpegExitCode ?? 0,
        metadata,
        cleanup
      });
    } catch (error) {
      if (tempDirectory) await releaseNormalizationTemp(tempDirectory);
      if (error?.code === TRANSCRIPTION_CANCELLED) throw error;
      if (error?.code === MEETING_AUDIO_NORMALIZATION_FAILED) throw error;
      throw normalizationError();
    }
  }

  async function splitWavFile({ normalized, maxChunkDurationMs = 60_000, overlapMs = 0 } = {}) {
    if (!normalized?.path || !normalized?.metadata) throw normalizationError();
    if (!Number.isSafeInteger(maxChunkDurationMs) || maxChunkDurationMs <= 0) throw codedError('ASR_CHUNK_DURATION_INVALID');
    if (!Number.isSafeInteger(overlapMs) || overlapMs < 0 || overlapMs >= maxChunkDurationMs) throw codedError('ASR_OVERLAP_INVALID');
    const durationMs = normalized.metadata.durationMs;
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0) throw normalizationError();
    const windowDirectory = path.join(path.dirname(normalized.path), 'windows');
    await mkdir(windowDirectory, { recursive: true, mode: 0o700 });
    const windows = [];

    // A decoded WebM duration can leave a very short trailing remainder (for
    // example 120105ms -> 60000ms + 60000ms + 105ms). XFYUN may classify that
    // standalone tail as a silent file. When there is more than one window and
    // no overlap, distribute that remainder across the windows while keeping
    // every window within the provider's maximum duration.
    const remainderMs = durationMs % maxChunkDurationMs;
    if (overlapMs === 0 && Math.ceil(durationMs / maxChunkDurationMs) > 1 && remainderMs > 0 && remainderMs < MIN_ASR_WINDOW_DURATION_MS) {
      const windowCount = Math.ceil(durationMs / maxChunkDurationMs);
      const baseDurationMs = Math.floor(durationMs / windowCount);
      const extraDurationMs = durationMs % windowCount;
      for (let sequence = 0, startMs = 0; sequence < windowCount; sequence += 1) {
        const duration = baseDurationMs + (sequence < extraDurationMs ? 1 : 0);
        const endMs = startMs + duration;
        const startFrame = Math.floor(startMs * normalized.metadata.sampleRate / 1000);
        const endFrame = Math.ceil(endMs * normalized.metadata.sampleRate / 1000);
        const outputPath = path.join(windowDirectory, `window-${sequence}.wav`);
        const metadata = await writeWavSlice({ inputPath: normalized.path, outputPath, metadata: normalized.metadata, startFrame, endFrame });
        windows.push(Object.freeze({
          sequence,
          startMs,
          endMs,
          durationMs: duration,
          path: outputPath,
          fileName: `meeting-window-${sequence}.wav`,
          mimeType: 'audio/wav',
          format: 'wav',
          metadata
        }));
        startMs = endMs;
      }
      return Object.freeze(windows);
    }

    let startMs = 0;
    let sequence = 0;
    while (startMs < durationMs) {
      const endMs = Math.min(durationMs, startMs + maxChunkDurationMs);
      const startFrame = Math.floor(startMs * normalized.metadata.sampleRate / 1000);
      const endFrame = Math.ceil(endMs * normalized.metadata.sampleRate / 1000);
      const outputPath = path.join(windowDirectory, `window-${sequence}.wav`);
      const metadata = await writeWavSlice({ inputPath: normalized.path, outputPath, metadata: normalized.metadata, startFrame, endFrame });
      windows.push(Object.freeze({
        sequence,
        startMs,
        endMs,
        durationMs: endMs - startMs,
        path: outputPath,
        fileName: `meeting-window-${sequence}.wav`,
        mimeType: 'audio/wav',
        format: 'wav',
        metadata
      }));
      sequence += 1;
      if (endMs >= durationMs) break;
      const nextStartMs = endMs - overlapMs;
      if (nextStartMs <= startMs) throw codedError('ASR_OVERLAP_INVALID');
      startMs = nextStartMs;
    }
    return Object.freeze(windows);
  }

  return Object.freeze({ normalizeChunk, normalizeSourceFile, splitWavFile });
}

export { codedError, parseWavMetadata, readWavFileMetadata, validWavMetadata };
