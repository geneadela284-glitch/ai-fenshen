import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMp4ContainerValidator, parseBoxes } from '../../core/meeting/stage3a/mp4Container.js';
import { inspectIndependentMp4Segment } from '../../core/meeting/stage3c/independentMp4.js';
import { resolveMeetingSourceDuration } from './xfyunAsrLlmMeetingProvider.js';
import {
  createMeetingIndependentMp4SourceAssembler,
  INDEPENDENT_MP4_SEGMENTS_V1
} from './meetingIndependentMp4SourceAssembler.js';

export const MEETING_TRANSCRIPTION_SOURCE_TEMP_PREFIX = 'meeting-transcription-source-';
const MAX_SOURCE_CHUNK_BYTES = 64 * 1024 * 1024;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function diagnosticLog(logger, event) {
  try {
    await logger?.log?.(event);
  } catch {
    // Candidate diagnostics are best effort and must never change assembly behavior.
  }
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function positiveInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw codedError(code);
  return normalized;
}

function nonNegativeInteger(value, code) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw codedError(code);
  return normalized;
}

function checksum(value, code = 'SOURCE_ASSEMBLY_CHECKSUM_INVALID') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw codedError(code);
  return normalized;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isCompleteIndependentMp4(bytes) {
  try {
    inspectIndependentMp4Segment(bytes);
    return true;
  } catch {
    try {
      const boxes = parseBoxes(bytes);
      const ftypIndex = boxes.findIndex((box) => box.type === 'ftyp');
      const moovIndex = boxes.findIndex((box) => box.type === 'moov');
      return ftypIndex === 0
        && moovIndex > ftypIndex
        && boxes.some((box) => box.type === 'moof')
        && boxes.some((box) => box.type === 'mdat');
    } catch {
      return false;
    }
  }
}

function isInitializationOnlyMp4(bytes) {
  try {
    const boxes = parseBoxes(bytes);
    return boxes.filter((box) => box.type === 'ftyp').length === 1
      && boxes.filter((box) => box.type === 'moov').length === 1
      && !boxes.some((box) => box.type === 'moof')
      && !boxes.some((box) => box.type === 'mdat');
  } catch {
    return false;
  }
}

function splitPackedIndependentMp4(bytes) {
  try {
    const boxes = parseBoxes(bytes);
    const starts = boxes.filter((box) => box.type === 'ftyp').map((box) => box.offset);
    if (starts.length < 2) return null;
    const segments = starts.map((start, index) => {
      const end = starts[index + 1] ?? bytes.byteLength;
      const segmentBytes = Buffer.from(bytes.subarray(start, end));
      const inspection = inspectIndependentMp4Segment(segmentBytes);
      return Object.freeze({ bytes: segmentBytes, inspection });
    });
    return Object.freeze(segments);
  } catch {
    return null;
  }
}

function sourceAssemblyKey({ ownerId, meetingId, sourceId, sourceRevision, assemblyId, attempt }) {
  return [ownerId, meetingId, sourceId, sourceRevision, assemblyId, attempt].map(String).join('\u0000');
}

function normalizeSource(source = {}) {
  const format = required(source.format, 'SOURCE_ASSEMBLY_FORMAT_REQUIRED');
  if (!['webm-opus', 'm4a'].includes(format)) throw codedError('SOURCE_ASSEMBLY_FORMAT_UNSUPPORTED');
  const mimeType = required(source.mimeType, 'SOURCE_ASSEMBLY_MIME_TYPE_REQUIRED');
  const normalizedMimeType = mimeType.toLowerCase();
  if (format === 'webm-opus' && !normalizedMimeType.includes('webm')) throw codedError('SOURCE_ASSEMBLY_MIME_TYPE_INVALID');
  if (format === 'm4a' && !normalizedMimeType.includes('mp4') && !normalizedMimeType.includes('m4a')) throw codedError('SOURCE_ASSEMBLY_MIME_TYPE_INVALID');
  const containerLayout = source.containerLayout === undefined
    ? ''
    : required(source.containerLayout, 'SOURCE_ASSEMBLY_CONTAINER_LAYOUT_REQUIRED');
  if (containerLayout && !['continuous-fragment-stream-v1', INDEPENDENT_MP4_SEGMENTS_V1].includes(containerLayout)) {
    throw codedError('SOURCE_ASSEMBLY_CONTAINER_LAYOUT_UNSUPPORTED');
  }
  if (containerLayout === INDEPENDENT_MP4_SEGMENTS_V1 && format !== 'm4a') {
    throw codedError('SOURCE_ASSEMBLY_CONTAINER_LAYOUT_INVALID');
  }
  return Object.freeze({
    fileName: required(source.fileName || (format === 'm4a' ? 'meeting-recording.m4a' : 'meeting-recording.webm'), 'SOURCE_ASSEMBLY_FILE_NAME_REQUIRED'),
    mimeType,
    format,
    byteLength: positiveInteger(source.byteLength, 'SOURCE_ASSEMBLY_BYTE_LENGTH_INVALID'),
    durationMs: positiveInteger(source.durationMs, 'SOURCE_ASSEMBLY_DURATION_INVALID'),
    chunkCount: positiveInteger(source.chunkCount, 'SOURCE_ASSEMBLY_CHUNK_COUNT_INVALID'),
    checksum: checksum(source.checksum, 'SOURCE_ASSEMBLY_SOURCE_CHECKSUM_INVALID'),
    ...(containerLayout ? { containerLayout } : {})
  });
}

function normalizeChunk(chunk = {}) {
  return Object.freeze({
    sourceChunkId: required(chunk.sourceChunkId, 'SOURCE_ASSEMBLY_CHUNK_ID_REQUIRED'),
    sequence: nonNegativeInteger(chunk.sequence, 'SOURCE_ASSEMBLY_SEQUENCE_INVALID'),
    durationMs: positiveInteger(chunk.durationMs, 'SOURCE_ASSEMBLY_CHUNK_DURATION_INVALID'),
    byteLength: positiveInteger(chunk.byteLength ?? chunk.bytes?.byteLength, 'SOURCE_ASSEMBLY_CHUNK_SIZE_INVALID'),
    checksum: checksum(chunk.checksum),
    final: chunk.final === true
  });
}

function sameChunk(left, right) {
  return left.sourceChunkId === right.sourceChunkId
    && left.sequence === right.sequence
    && left.durationMs === right.durationMs
    && left.byteLength === right.byteLength
    && left.checksum === right.checksum;
}

function sourceChecksum(entries) {
  return digest(JSON.stringify(entries.map((entry) => entry.checksum)));
}

function fragmentedMp4Session({ sequence, inputPath }) {
  return {
    sequence,
    inputPath,
    sourceChunkIds: [],
    durationMs: 0,
    byteLength: 0,
    hasher: createHash('sha256')
  };
}

function recordFragmentedMp4Chunk(session, chunk, bytes) {
  const current = session.fragmentedMp4Sessions.at(-1);
  if (!current || !bytes?.byteLength) throw codedError('SOURCE_ASSEMBLY_FRAGMENTED_SESSION_INVALID');
  current.sourceChunkIds.push(chunk.sourceChunkId);
  current.durationMs += chunk.durationMs;
  current.byteLength += bytes.byteLength;
  current.hasher.update(bytes);
}

function completedFragmentedMp4Sessions(session) {
  return session.fragmentedMp4Sessions.map((entry) => {
    if (!entry.sourceChunkIds.length || entry.durationMs < 1 || entry.byteLength < 1) {
      throw codedError('SOURCE_ASSEMBLY_FRAGMENTED_SESSION_INVALID');
    }
    return Object.freeze({
      sourceChunkId: entry.sourceChunkIds.length === 1
        ? entry.sourceChunkIds[0]
        : `${entry.sourceChunkIds[0]}..${entry.sourceChunkIds.at(-1)}`,
      sequence: entry.sequence,
      durationMs: entry.durationMs,
      byteLength: entry.byteLength,
      checksum: entry.hasher.digest('hex'),
      inputPath: entry.inputPath
    });
  });
}

async function writeBodyToFile({ body, filePath, offset, expectedByteLength, signal, captureBytes = false }) {
  if (!body?.[Symbol.asyncIterator]) throw codedError('SOURCE_ASSEMBLY_BODY_REQUIRED');
  if (signal?.aborted) throw codedError('TRANSCRIPTION_CANCELLED');
  let handle;
  let written = 0;
  const hasher = createHash('sha256');
  const captured = captureBytes ? [] : null;
  try {
    handle = await open(filePath, 'r+');
    for await (const input of body) {
      if (signal?.aborted) throw codedError('TRANSCRIPTION_CANCELLED');
      const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
      if (!buffer.length) continue;
      written += buffer.length;
      if (written > MAX_SOURCE_CHUNK_BYTES || (expectedByteLength && written > expectedByteLength)) throw codedError('SOURCE_ASSEMBLY_CHUNK_TOO_LARGE');
      hasher.update(buffer);
      if (captured) captured.push(buffer);
      const result = await handle.write(buffer, 0, buffer.length, offset + written - buffer.length);
      if (result.bytesWritten !== buffer.length) throw codedError('SOURCE_ASSEMBLY_WRITE_FAILED');
    }
    if (written !== expectedByteLength) throw codedError('SOURCE_ASSEMBLY_CHUNK_SIZE_INVALID');
    return Object.freeze({ byteLength: written, checksum: hasher.digest('hex'), bytes: captured ? Buffer.concat(captured) : undefined });
  } catch (error) {
    if (error?.code) throw error;
    throw codedError('SOURCE_ASSEMBLY_AUDIO_READ_FAILED');
  } finally {
    await handle?.close?.().catch?.(() => {});
  }
}

export function cleanupOrphanedSourceAssemblies({ root = os.tmpdir() } = {}) {
  let entries = [];
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(MEETING_TRANSCRIPTION_SOURCE_TEMP_PREFIX)) continue;
    try {
      rmSync(path.join(root, entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {}
  }
  return removed;
}

export function createMeetingTranscriptionSourceAssembler({
  tempRoot = os.tmpdir(),
  independentMp4Assembler = createMeetingIndependentMp4SourceAssembler({ tempRoot })
} = {}) {
  const sessions = new Map();
  cleanupOrphanedSourceAssemblies({ root: tempRoot });

  async function createSession(input) {
    const directory = await mkdtemp(path.join(tempRoot, MEETING_TRANSCRIPTION_SOURCE_TEMP_PREFIX));
    const inputPath = path.join(directory, input.source.format === 'm4a' ? 'source.m4a' : 'source.webm');
    await writeFile(inputPath, Buffer.alloc(0), { mode: 0o600 });
    return {
      ...input,
      directory,
      inputPath,
      effectiveContainerLayout: input.source.containerLayout || '',
      firstIndependentCandidate: false,
      initializationOnlyCandidate: false,
      firstIndependentSegmentPath: null,
      containerValidator: input.source.format === 'm4a'
        && input.source.containerLayout !== INDEPENDENT_MP4_SEGMENTS_V1
        ? createMp4ContainerValidator()
        : null,
      containerMetadata: null,
      nextSequence: 0,
      totalBytes: 0,
      assembledByteLength: 0,
      totalDurationMs: 0,
      chunks: [],
      independentSegments: [],
      fragmentedMp4Sessions: input.source.format === 'm4a'
        && input.source.containerLayout !== INDEPENDENT_MP4_SEGMENTS_V1
        ? [fragmentedMp4Session({ sequence: 0, inputPath })]
        : [],
      multipleFragmentedMp4Sessions: false,
      finalizing: false
    };
  }

  async function cleanupSession(session) {
    await rm(session.directory, { recursive: true, force: true }).catch(() => {});
  }

  async function acceptChunk({
    ownerId,
    meetingId,
    sourceId,
    sourceRevision,
    assemblyId,
    attempt,
    traceId,
    source: inputSource,
    chunk: inputChunk,
    body,
    signal,
    diagnosticLogger,
    finalize
  } = {}) {
    const identity = Object.freeze({
      ownerId: required(ownerId, 'OWNER_REQUIRED'),
      meetingId: required(meetingId, 'MEETING_ID_REQUIRED'),
      sourceId: required(sourceId, 'SOURCE_ID_REQUIRED'),
      sourceRevision: positiveInteger(sourceRevision, 'TRANSCRIPTION_SOURCE_REVISION_INVALID'),
      assemblyId: required(assemblyId, 'SOURCE_ASSEMBLY_ID_REQUIRED'),
      attempt: positiveInteger(attempt || 1, 'TRANSCRIPTION_ATTEMPT_INVALID')
    });
    const source = normalizeSource(inputSource);
    const chunk = normalizeChunk(inputChunk);
    if (chunk.sequence >= source.chunkCount) throw codedError('SOURCE_ASSEMBLY_SEQUENCE_INVALID');
    const key = sourceAssemblyKey({ ...identity });
    let session = sessions.get(key);
    if (!session) {
      if (chunk.sequence !== 0) throw codedError('SOURCE_ASSEMBLY_SEQUENCE_INVALID');
      session = await createSession({ ...identity, source });
      sessions.set(key, session);
    }
    if (session.finalizing) throw codedError('SOURCE_ASSEMBLY_BUSY');
    if (JSON.stringify(session.source) !== JSON.stringify(source)) throw codedError('SOURCE_ASSEMBLY_SOURCE_CONFLICT');
    const existing = session.chunks[chunk.sequence];
    if (existing) {
      if (!sameChunk(existing, chunk)) throw codedError('SOURCE_ASSEMBLY_CHUNK_CONFLICT');
      const duplicatePath = path.join(session.directory, `duplicate-${chunk.sequence}`);
      try {
        await writeFile(duplicatePath, Buffer.alloc(0), { mode: 0o600 });
        const duplicate = await writeBodyToFile({ body, filePath: duplicatePath, offset: 0, expectedByteLength: chunk.byteLength, signal });
        if (duplicate.checksum !== chunk.checksum) throw codedError('SOURCE_ASSEMBLY_CHUNK_CHECKSUM_MISMATCH');
      } finally {
        await rm(duplicatePath, { force: true }).catch(() => {});
      }
      return Object.freeze({ acknowledged: true, sequence: chunk.sequence, idempotent: true, completed: false });
    }
    if (chunk.sequence !== session.nextSequence) throw codedError('SOURCE_ASSEMBLY_SEQUENCE_INVALID');
    const previousFileByteLength = session.assembledByteLength;
    let independentLayout = session.effectiveContainerLayout === INDEPENDENT_MP4_SEGMENTS_V1;
    let chunkPath = independentLayout
      ? path.join(session.directory, `segment-${session.independentSegments.length}.m4a`)
      : session.inputPath;
    if (independentLayout) await writeFile(chunkPath, Buffer.alloc(0), { mode: 0o600 });
    const written = await writeBodyToFile({
      body,
      filePath: chunkPath,
      offset: independentLayout ? 0 : previousFileByteLength,
      expectedByteLength: chunk.byteLength,
      signal,
      captureBytes: session.containerValidator !== null
    });
    if (written.checksum !== chunk.checksum) {
      if (independentLayout) await rm(chunkPath, { force: true }).catch(() => {});
      else {
        const handle = await open(session.inputPath, 'r+');
        try { await handle.truncate(previousFileByteLength); } finally { await handle.close(); }
      }
      throw codedError('SOURCE_ASSEMBLY_CHUNK_CHECKSUM_MISMATCH');
    }
    let currentIndependentSegmentsAdded = false;
    if (session.containerValidator && source.format === 'm4a') {
      const packedSegments = splitPackedIndependentMp4(written.bytes);
      if (packedSegments?.length) {
        session.effectiveContainerLayout = INDEPENDENT_MP4_SEGMENTS_V1;
        session.containerValidator = null;
        independentLayout = true;
        for (const packedSegment of packedSegments) {
          const sequence = session.independentSegments.length;
          const inputPath = path.join(session.directory, `segment-${sequence}.m4a`);
          await writeFile(inputPath, packedSegment.bytes, { mode: 0o600 });
          session.independentSegments.push(Object.freeze({
            sourceChunkId: `${chunk.sourceChunkId}:segment-${sequence}`,
            sequence,
            durationMs: Number.isSafeInteger(packedSegment.inspection.durationMs) && packedSegment.inspection.durationMs > 0
              ? packedSegment.inspection.durationMs
              : chunk.durationMs,
            byteLength: packedSegment.bytes.byteLength,
            checksum: digest(packedSegment.bytes),
            inputPath
          }));
        }
        currentIndependentSegmentsAdded = true;
      }
    }
    if (session.containerValidator
      && source.format === 'm4a'
      && source.chunkCount > 1
      && session.chunks.length === 0
      && isCompleteIndependentMp4(written.bytes)) {
      session.firstIndependentCandidate = true;
      session.firstIndependentSegmentPath = path.join(session.directory, 'segment-0.m4a');
      await writeFile(session.firstIndependentSegmentPath, written.bytes, { mode: 0o600 });
    }
    if (session.containerValidator
      && source.format === 'm4a'
      && session.chunks.length === 0
      && isInitializationOnlyMp4(written.bytes)) {
      session.initializationOnlyCandidate = true;
    }
    if (session.containerValidator
      && source.format === 'm4a'
      && session.chunks.length === 1
      && (session.firstIndependentCandidate || session.initializationOnlyCandidate)
      && isCompleteIndependentMp4(written.bytes)) {
      const currentSegmentPath = path.join(
        session.directory,
        `segment-${session.independentSegments.length + (session.firstIndependentCandidate ? 1 : 0)}.m4a`
      );
      await writeFile(currentSegmentPath, written.bytes, { mode: 0o600 });
      session.effectiveContainerLayout = INDEPENDENT_MP4_SEGMENTS_V1;
      session.containerValidator = null;
      independentLayout = true;
      chunkPath = currentSegmentPath;
      if (session.firstIndependentCandidate) {
        session.independentSegments.push(Object.freeze({
          ...session.chunks[0],
          sequence: session.independentSegments.length,
          inputPath: session.firstIndependentSegmentPath
        }));
      }
    }
    let persistedByteLength = written.byteLength;
    if (session.containerValidator) {
      try {
        session.containerMetadata = session.containerValidator.acceptChunk(written.bytes);
      } catch (error) {
        if (error?.code === 'MP4_INITIALIZATION_DUPLICATE') {
          try {
            if (!session.containerMetadata?.fragmentCount || !session.fragmentedMp4Sessions.at(-1)?.sourceChunkIds.length) {
              throw error;
            }
            const handle = await open(session.inputPath, 'r+');
            try { await handle.truncate(previousFileByteLength); } finally { await handle.close(); }
            const nextSequence = session.fragmentedMp4Sessions.length;
            const nextPath = path.join(session.directory, `recorder-session-${nextSequence}.m4a`);
            await writeFile(nextPath, written.bytes, { mode: 0o600 });
            const nextValidator = createMp4ContainerValidator();
            session.containerMetadata = nextValidator.acceptChunk(written.bytes);
            session.containerValidator = nextValidator;
            session.inputPath = nextPath;
            session.assembledByteLength = 0;
            session.fragmentedMp4Sessions.push(fragmentedMp4Session({ sequence: nextSequence, inputPath: nextPath }));
            session.multipleFragmentedMp4Sessions = true;
          } catch (boundaryError) {
            const handle = await open(session.inputPath, 'r+');
            try { await handle.truncate(previousFileByteLength); } finally { await handle.close(); }
            sessions.delete(key);
            await diagnosticLog(diagnosticLogger, {
              traceId,
              phase: 'source_container_validation',
              sourceAssembler: true,
              format: source.format,
              containerValidation: 'FAIL',
              status: 'FAIL',
              errorCode: boundaryError?.code || error?.code || 'MP4_CONTAINER_INVALID'
            });
            await cleanupSession(session);
            throw boundaryError;
          }
        } else {
          const handle = await open(session.inputPath, 'r+');
          try { await handle.truncate(previousFileByteLength); } finally { await handle.close(); }
          sessions.delete(key);
          await diagnosticLog(diagnosticLogger, {
            traceId,
            phase: 'source_container_validation',
            sourceAssembler: true,
            format: source.format,
            containerValidation: 'FAIL',
            status: 'FAIL',
            errorCode: error?.code || 'MP4_CONTAINER_INVALID'
          });
          await cleanupSession(session);
          throw error;
        }
      }
    }
    if (session.containerValidator && source.format === 'm4a' && !independentLayout) {
      recordFragmentedMp4Chunk(session, chunk, written.bytes);
    }
    const committedChunk = Object.freeze({
      sourceChunkId: chunk.sourceChunkId,
      sequence: chunk.sequence,
      durationMs: chunk.durationMs,
      byteLength: chunk.byteLength,
      checksum: chunk.checksum
    });
    session.chunks.push(committedChunk);
    if (independentLayout && !currentIndependentSegmentsAdded) {
      session.independentSegments.push(Object.freeze({
        ...committedChunk,
        sequence: session.independentSegments.length,
        inputPath: chunkPath
      }));
    }
    session.nextSequence += 1;
    session.totalBytes += written.byteLength;
    if (!independentLayout) session.assembledByteLength += persistedByteLength;
    session.totalDurationMs += chunk.durationMs;
    await diagnosticLog(diagnosticLogger, {
      traceId,
      phase: 'source_chunk_received',
      sourceAssembler: true,
      segmentCount: session.chunks.length,
      sequences: session.chunks.map((entry) => entry.sequence),
      totalBytes: session.totalBytes,
      container: session.containerMetadata,
      status: 'PASS'
    });
    const completed = chunk.final === true;
    if (!completed) {
      return Object.freeze({ acknowledged: true, sequence: chunk.sequence, idempotent: false, completed: false });
    }
    if (session.nextSequence !== source.chunkCount || session.totalBytes !== source.byteLength || session.totalDurationMs !== source.durationMs || sourceChecksum(session.chunks) !== source.checksum) {
      await diagnosticLog(diagnosticLogger, {
        traceId,
        phase: 'source_assembled',
        sourceAssembler: true,
        segmentCount: session.chunks.length,
        sequences: session.chunks.map((entry) => entry.sequence),
        totalBytes: session.totalBytes,
        container: session.containerMetadata,
        reconstruction: 'FAIL',
        status: 'FAIL',
        errorCode: 'SOURCE_ASSEMBLY_SOURCE_INTEGRITY_MISMATCH'
      });
      await sessions.delete(key);
      await cleanupSession(session);
      throw codedError('SOURCE_ASSEMBLY_SOURCE_INTEGRITY_MISMATCH');
    }
    await diagnosticLog(diagnosticLogger, {
      traceId,
      phase: 'source_assembled',
      sourceAssembler: true,
      segmentCount: session.chunks.length,
      sequences: session.chunks.map((entry) => entry.sequence),
      totalBytes: session.totalBytes,
      container: session.containerMetadata,
      reconstruction: 'PASS',
      status: 'PASS'
    });
    if (typeof finalize !== 'function') {
      sessions.delete(key);
      await cleanupSession(session);
      throw codedError('SOURCE_ASSEMBLY_FINALIZER_REQUIRED');
    }
    session.finalizing = true;
    let independentAssembly = null;
    try {
      const fragmentedSegments = session.multipleFragmentedMp4Sessions
        ? completedFragmentedMp4Sessions(session)
        : null;
      if (independentLayout || fragmentedSegments) {
        independentAssembly = await independentMp4Assembler.assemble({
          segments: fragmentedSegments || session.independentSegments,
          signal
        });
      }
      // Validate against the original AAC declaration BEFORE projecting the
      // decoded WAV timeline. Reusing the provider contract keeps both the AAC
      // positive bound and the stricter audio-loss bound unchanged.
      const durationContract = independentAssembly ? resolveMeetingSourceDuration({
        declaredDurationMs: source.durationMs,
        decodedDurationMs: independentAssembly.source.durationMs,
        sourceFormat: source.format,
        sourceMimeType: source.mimeType
      }) : null;
      const assembledSource = independentAssembly
        ? Object.freeze({
            ...(session.effectiveContainerLayout === INDEPENDENT_MP4_SEGMENTS_V1
              && source.containerLayout !== INDEPENDENT_MP4_SEGMENTS_V1
              ? { ...source, containerLayout: INDEPENDENT_MP4_SEGMENTS_V1 }
              : source),
            ...independentAssembly.source,
            originalSource: source,
            durationContract,
            durationMs: durationContract.effectiveDurationMs,
            chunkCount: source.chunkCount,
            checksum: source.checksum,
            containerLayout: INDEPENDENT_MP4_SEGMENTS_V1
          })
        : session.effectiveContainerLayout === INDEPENDENT_MP4_SEGMENTS_V1
          && source.containerLayout !== INDEPENDENT_MP4_SEGMENTS_V1
          ? Object.freeze({ ...source, containerLayout: INDEPENDENT_MP4_SEGMENTS_V1 })
          : session.assembledByteLength !== source.byteLength
            ? Object.freeze({ ...source, byteLength: session.assembledByteLength })
            : source;
      const result = await finalize({
        inputPath: independentAssembly?.inputPath || session.inputPath,
        source: assembledSource,
        chunks: Object.freeze([...session.chunks]),
        container: session.containerMetadata,
        signal
      });
      return Object.freeze({ acknowledged: true, sequence: chunk.sequence, idempotent: false, completed: true, result });
    } finally {
      await independentAssembly?.cleanup?.().catch(() => {});
      sessions.delete(key);
      await cleanupSession(session);
    }
  }

  async function close() {
    const pending = [...sessions.values()];
    sessions.clear();
    await Promise.all(pending.map(cleanupSession));
  }

  return Object.freeze({ acceptChunk, close });
}

export { codedError, sourceChecksum };
