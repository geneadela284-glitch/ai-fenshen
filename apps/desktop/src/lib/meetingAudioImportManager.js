import {
  assertOwnerContext,
  MEETING_AUDIO_MANIFEST_VERSION
} from './meetingAudioContracts.js';
import {
  StreamingSha256,
  streamAudioFile,
  validateAudioFile
} from './meetingAudioFormat.js';
import {
  createMeetingAudioImportSession,
  transitionMeetingAudioImport
} from './meetingAudioImportState.js';

function codedError(code, cause = null) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function required(value, code) {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw codedError(code);
  return normalized;
}

function randomId(cryptoImpl, prefix) {
  if (!cryptoImpl?.getRandomValues) return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const random = cryptoImpl.getRandomValues(new Uint8Array(12));
  let binary = '';
  for (const value of random) binary += String.fromCharCode(value);
  const encoder = globalThis.btoa || ((value) => Buffer.from(value, 'binary').toString('base64'));
  return `${prefix}-${encoder(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function timestamp(now) {
  return typeof now === 'function' ? now() : now || new Date().toISOString();
}

function sameFile(source, validation) {
  return source.fileIdentity === validation.fileIdentity
    && source.byteLength === validation.byteLength
    && source.durationMs === validation.durationMs
    && source.format === validation.format
    && source.mimeType === validation.mimeType;
}

function readableError(error) {
  const code = error?.code || 'AUDIO_IMPORT_FAILED';
  const labels = Object.freeze({
    AUDIO_FILE_TOO_LARGE: '文件超过1GB上限。',
    AUDIO_DURATION_TOO_LONG: '音频超过4小时上限。',
    AUDIO_EXTENSION_MISMATCH: '文件扩展名与音频内容不一致。',
    AUDIO_MIME_MISMATCH: '文件类型与音频内容不一致。',
    AUDIO_HEADER_INVALID: '无法识别或读取音频文件头。',
    AUDIO_METADATA_INVALID: '音频元数据不完整或损坏。',
    AUDIO_FILE_TRUNCATED: '音频文件不完整。',
    IMPORT_CANCELLED: '导入已取消，未保留可用半成品。',
    IMPORT_STREAM_FAILED: '导入读取失败，可重新选择同一文件重试。'
  });
  return labels[code] || `导入未完成（${code}）。`;
}

export function createMeetingAudioImportManager({
  ownerContext: inputOwnerContext,
  store,
  cryptoImpl = globalThis.crypto,
  now = () => new Date().toISOString(),
  chunkSize
} = {}) {
  const ownerContext = assertOwnerContext(inputOwnerContext);
  if (!store || typeof store.beginAudioImport !== 'function' || typeof store.commitImportedAudioAsset !== 'function' || typeof store.completeAudioImport !== 'function' || typeof store.listAudioSources !== 'function') {
    throw codedError('MEETING_AUDIO_IMPORT_STORE_REQUIRED');
  }
  let currentSession = null;
  let currentSnapshot = Object.freeze({
    importState: 'idle',
    importId: '',
    sourceId: '',
    fileName: '',
    progress: Object.freeze({ bytesProcessed: 0, totalBytes: 0, percent: 0 }),
    requiresReselect: false,
    errorCode: '',
    message: ''
  });
  let operation = null;
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) {
      try {
        listener(currentSnapshot);
      } catch {
        // Import observers must not interrupt encryption or cleanup.
      }
    }
  }

  function updateSnapshot(patch = {}) {
    currentSnapshot = Object.freeze({
      ...currentSnapshot,
      ...patch,
      progress: Object.freeze({ ...currentSnapshot.progress, ...(patch.progress || {}) })
    });
    notify();
    return currentSnapshot;
  }

  function setSession(next) {
    currentSession = Object.freeze(next);
    updateSnapshot({
      importState: currentSession.importState,
      importId: currentSession.importId,
      sourceId: currentSession.sourceId,
      fileName: currentSession.originalFileName,
      errorCode: currentSession.errorCode || ''
    });
  }

  function transition(event) {
    const result = transitionMeetingAudioImport(currentSession, event, { now: timestamp(now) });
    if (!result.accepted && !result.idempotent) throw codedError(result.errorCode || 'AUDIO_IMPORT_STATE_TRANSITION_REJECTED');
    setSession(result.state);
    return result;
  }

  async function findExisting(meetingId, validation, importId) {
    const sources = await store.listAudioSources(ownerContext, meetingId, { includeLifecycle: true });
    return sources.find((source) => source.importId === importId)
      || (importId.startsWith('generated-') ? sources.find((source) => source.importState !== 'deleted' && sameFile(source, validation)) : null);
  }

  async function runImport(input, controller) {
    const file = input?.file;
    if (!file) throw codedError('AUDIO_FILE_REQUIRED');
    const meetingId = required(input.meetingId, 'MEETING_ID_REQUIRED');
    const requestedImportId = String(input.importId || '').trim();
    const generatedImportId = requestedImportId || `generated-${randomId(cryptoImpl, 'import')}`;
    const requestedSourceId = String(input.sourceId || '').trim() || randomId(cryptoImpl, 'source');
    let importId = generatedImportId;
    let sourceId = requestedSourceId;
    let started = false;
    let idempotent = false;
    try {
      currentSession = createMeetingAudioImportSession({
        importId,
        meetingId,
        ownerId: ownerContext.ownerId,
        sourceId,
        originalFileName: file.name,
        mimeType: file.type,
        now: timestamp(now)
      });
      setSession(currentSession);
      transition({ type: 'begin_validation' });
      const validation = await validateAudioFile(file);
      const existing = await findExisting(meetingId, validation, importId);
      if (existing) {
        importId = existing.importId;
        sourceId = existing.sourceId;
        currentSession = Object.freeze({ ...currentSession, importId, sourceId, originalFileName: validation.originalFileName, mimeType: validation.mimeType, format: validation.format, byteLength: validation.byteLength, durationMs: validation.durationMs, fileIdentity: validation.fileIdentity });
        setSession(currentSession);
      } else {
        currentSession = Object.freeze({ ...currentSession, originalFileName: validation.originalFileName, mimeType: validation.mimeType, format: validation.format, byteLength: validation.byteLength, durationMs: validation.durationMs, fileIdentity: validation.fileIdentity });
        setSession(currentSession);
      }
      transition({ type: 'validation_passed' });
      const began = await store.beginAudioImport(ownerContext, {
        meetingId,
        importId,
        sourceId,
        scope: 'meeting',
        origin: 'imported',
        originalFileName: validation.originalFileName,
        mimeType: validation.mimeType,
        format: validation.format,
        byteLength: validation.byteLength,
        durationMs: validation.durationMs,
        fileIdentity: validation.fileIdentity,
        manifestVersion: MEETING_AUDIO_MANIFEST_VERSION
      });
      sourceId = began.source.sourceId;
      currentSession = Object.freeze({ ...currentSession, sourceId });
      setSession(currentSession);
      if (began.idempotent) {
        idempotent = true;
        currentSession = Object.freeze({ ...currentSession, importState: 'committed', checksum: began.source.checksum, chunkCount: began.source.chunkCount, committedByteLength: began.source.byteLength, committedDurationMs: began.source.durationMs });
        setSession(currentSession);
        updateSnapshot({ progress: { bytesProcessed: validation.byteLength, totalBytes: validation.byteLength, percent: 100 }, requiresReselect: false, message: '导入已存在，保持幂等。' });
        return Object.freeze({ idempotent: true, source: began.source, validation });
      }
      started = true;
      let sequence = 0;
      let processedBytes = 0;
      let previousDuration = 0;
      const hasher = new StreamingSha256();
      updateSnapshot({ progress: { bytesProcessed: 0, totalBytes: validation.byteLength, percent: 0 }, requiresReselect: false, message: '正在加密并提交音频分段。' });
      for await (const chunk of streamAudioFile(file, { chunkSize, signal: controller.signal })) {
        if (controller.signal.aborted) throw codedError('IMPORT_CANCELLED');
        const nextBytes = processedBytes + chunk.byteLength;
        const duration = Math.max(0, Math.round((nextBytes / validation.byteLength) * validation.durationMs) - previousDuration);
        hasher.update(chunk);
        await store.commitImportedAudioAsset(ownerContext, {
          meetingId,
          sourceId,
          asset: {
            assetId: `${sourceId}-asset-${sequence}`,
            chunkId: `${sourceId}-chunk-${sequence}`,
            sequence,
            durationMs: duration,
            mimeType: validation.mimeType
          },
          bytes: chunk
        });
        const transitioned = transition({ type: 'chunk_committed', byteLength: chunk.byteLength, durationMs: duration });
        processedBytes = nextBytes;
        previousDuration += duration;
        sequence += 1;
        const progress = { bytesProcessed: processedBytes, totalBytes: validation.byteLength, percent: Math.min(100, Math.floor((processedBytes / validation.byteLength) * 100)) };
        updateSnapshot({ progress, message: '正在加密并提交音频分段。' });
        input.onProgress?.(Object.freeze({ ...progress, state: transitioned.state.importState }));
      }
      if (controller.signal.aborted) throw codedError('IMPORT_CANCELLED');
      const checksum = hasher.digestHex();
      const completed = await store.completeAudioImport(ownerContext, { meetingId, sourceId, checksum });
      currentSession = Object.freeze({ ...currentSession, checksum, chunkCount: sequence, committedByteLength: processedBytes, committedDurationMs: previousDuration });
      transition({ type: 'commit', checksum });
      updateSnapshot({ progress: { bytesProcessed: validation.byteLength, totalBytes: validation.byteLength, percent: 100 }, requiresReselect: false, message: '音频已完成加密导入。', errorCode: '' });
      return Object.freeze({ ...completed, idempotent, validation });
    } catch (error) {
      const cancelled = controller.signal.aborted || error?.code === 'IMPORT_CANCELLED';
      if (cancelled) {
        if (started) await store.cancelAudioImport(ownerContext, { meetingId, sourceId }).catch(() => {});
        if (currentSession && ['selected', 'validating', 'importing', 'failed_retryable'].includes(currentSession.importState)) {
          transition({ type: 'cancel' });
        } else if (currentSession) {
          currentSession = Object.freeze({ ...currentSession, importState: 'cancelled', errorCode: 'IMPORT_CANCELLED' });
          setSession(currentSession);
        }
        updateSnapshot({ requiresReselect: true, message: readableError({ code: 'IMPORT_CANCELLED' }), errorCode: 'IMPORT_CANCELLED' });
        throw codedError('IMPORT_CANCELLED', error);
      }
      if (started) await store.failAudioImport(ownerContext, { meetingId, sourceId, errorCode: error?.code || 'IMPORT_STREAM_FAILED' }).catch(() => {});
      if (currentSession?.importState === 'validating' && !started) {
        try {
          transition({ type: 'validation_rejected', errorCode: error?.code || 'AUDIO_FILE_REJECTED' });
        } catch {
          currentSession = Object.freeze({ ...currentSession, importState: 'rejected', errorCode: error?.code || 'AUDIO_FILE_REJECTED' });
          setSession(currentSession);
        }
      } else if (currentSession && ['validating', 'importing'].includes(currentSession.importState)) {
        try {
          transition({ type: 'failed_retryable', errorCode: error?.code || 'IMPORT_STREAM_FAILED' });
        } catch {
          currentSession = Object.freeze({ ...currentSession, importState: 'failed_retryable', errorCode: error?.code || 'IMPORT_STREAM_FAILED' });
          setSession(currentSession);
        }
      }
      updateSnapshot({ requiresReselect: started, message: readableError(error), errorCode: error?.code || 'AUDIO_IMPORT_FAILED' });
      throw error;
    }
  }

  function importFile(input) {
    if (operation) throw codedError('AUDIO_IMPORT_BUSY');
    const controller = new AbortController();
    const current = { controller, promise: null };
    current.promise = runImport(input, controller).finally(() => {
      if (operation === current) operation = null;
    });
    operation = current;
    return current.promise;
  }

  async function cancelImport() {
    if (!operation) return false;
    operation.controller.abort();
    try {
      await operation.promise;
    } catch (error) {
      if (error?.code !== 'IMPORT_CANCELLED') throw error;
    }
    return true;
  }

  async function initialize(meetingId) {
    const sources = await store.listAudioSources(ownerContext, required(meetingId, 'MEETING_ID_REQUIRED'), { includeLifecycle: true });
    const pending = sources.find((source) => ['importing', 'failed_retryable', 'cancelled'].includes(source.importState));
    if (!pending) return currentSnapshot;
    currentSession = Object.freeze({
      importId: pending.importId || '',
      meetingId,
      ownerId: ownerContext.ownerId,
      sourceId: pending.sourceId,
      originalFileName: pending.originalFileName,
      importState: pending.importState,
      errorCode: pending.importState === 'importing' ? 'IMPORT_FILE_OBJECT_UNAVAILABLE' : '',
      revision: pending.revision,
      checksum: pending.checksum || '',
      chunkCount: pending.chunkCount,
      committedByteLength: pending.committedByteLength || 0,
      committedDurationMs: pending.committedDurationMs || 0
    });
    updateSnapshot({
      importState: pending.importState,
      importId: pending.importId || '',
      sourceId: pending.sourceId,
      fileName: pending.originalFileName,
      requiresReselect: true,
      errorCode: pending.importState === 'importing' ? 'IMPORT_FILE_OBJECT_UNAVAILABLE' : '',
      message: 'Safari刷新后无法恢复File对象，请重新选择同一文件。'
    });
    return currentSnapshot;
  }

  async function deleteSource(meetingId, sourceId) {
    await store.deleteAudioSource(ownerContext, { meetingId: required(meetingId, 'MEETING_ID_REQUIRED'), sourceId: required(sourceId, 'SOURCE_ID_REQUIRED') });
    if (currentSnapshot.sourceId === sourceId) updateSnapshot({ importState: 'deleted', message: '音频已删除。', requiresReselect: false });
    return true;
  }

  return Object.freeze({
    importFile,
    cancelImport,
    initialize,
    deleteSource,
    getSnapshot() { return currentSnapshot; },
    subscribe(listener) {
      if (typeof listener !== 'function') throw codedError('AUDIO_IMPORT_LISTENER_REQUIRED');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}
