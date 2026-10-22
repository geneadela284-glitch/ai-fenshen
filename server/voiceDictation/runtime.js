import { appendFile, chmod, lstat, mkdir, rm, rmdir, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  DICTATION_LIMITS,
  DICTATION_PROVIDER_ID,
  validateDictationRequest,
  voiceError
} from './audioContract.js';

export const LOCAL_VOICE_ASR_MODULE_URL = 'file:///opt/ai-fenshen/shared/voice-asr/server/index.js';
export const LOCAL_VOICE_ASR_CLI = '/opt/whisper.cpp/build/bin/whisper-cli';
export const DICTATION_DIAGNOSTIC_LOG_ENV = 'AI_FENSHEN_DICTATION_DIAGNOSTIC_LOG';
export const DICTATION_DIAGNOSTIC_LOG_MAX_BYTES = 10 * 1024 * 1024;

function diagnosticRequestFields(request = {}) {
  const audioBytes = request.audioBytes;
  const bytes = Buffer.isBuffer(audioBytes) || audioBytes instanceof Uint8Array
    ? audioBytes.byteLength
    : null;
  const hash = String(request.audioHash || '').trim();
  return {
    requestId: request.requestId || null,
    contentType: request.contentType || request.format || null,
    bytes,
    durationMs: Number.isFinite(Number(request.durationMs)) ? Number(request.durationMs) : null,
    sampleRate: Number.isFinite(Number(request.sampleRate)) ? Number(request.sampleRate) : null,
    audioHashPrefix: hash ? hash.slice(0, 8) : null
  };
}

export function sanitizeDiagnosticStderr(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text
    .replace(/\b(authorization|cookie|token|secret|password|api[-_]?key)\b\s*[:=]\s*(?:bearer\s+)?\S+/gi, '$1=[redacted]')
    .replace(/\bbearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/\/(?:opt|tmp|private|var|home|Users)\/[^\s]+/g, '[path]')
    .slice(0, 240);
}

const DICTATION_DIAGNOSTIC_FIELDS = Object.freeze({
  phase: (value) => sanitizeDiagnosticStderr(value)?.slice(0, 64) || null,
  requestId: (value) => sanitizeDiagnosticStderr(value)?.slice(0, 128) || null,
  httpStatus: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
  errorCode: (value) => sanitizeDiagnosticStderr(value)?.slice(0, 96) || null,
  contentType: (value) => sanitizeDiagnosticStderr(value)?.slice(0, 128) || null,
  bytes: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
  durationMs: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
  sampleRate: (value) => Number.isFinite(Number(value)) ? Number(value) : null,
  audioHashPrefix: (value) => String(value || '').replace(/[^a-f0-9]/gi, '').slice(0, 8) || null,
  exitCode: (value) => Number.isInteger(Number(value)) ? Number(value) : null,
  stderrSummary: (value) => sanitizeDiagnosticStderr(value),
  cleanupStatus: (value) => sanitizeDiagnosticStderr(value)?.slice(0, 96) || null
});

function safeDiagnosticRecord(event = {}) {
  return Object.fromEntries(
    Object.entries(DICTATION_DIAGNOSTIC_FIELDS)
      .filter(([field]) => Object.hasOwn(event, field))
      .map(([field, normalize]) => [field, normalize(event[field])])
  );
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

async function ensureDiagnosticPath(filePath) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error('diagnostic log directory is unsafe');
  }
  await chmod(directory, 0o700);
}

export function createDictationDiagnosticLogger({
  filePath = process.env[DICTATION_DIAGNOSTIC_LOG_ENV] || null,
  maxBytes = DICTATION_DIAGNOSTIC_LOG_MAX_BYTES,
  now = () => new Date().toISOString()
} = {}) {
  const resolvedPath = filePath ? path.resolve(filePath) : null;
  const rotatedPath = resolvedPath ? `${resolvedPath}.1` : null;
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? maxBytes
    : DICTATION_DIAGNOSTIC_LOG_MAX_BYTES;
  let writes = Promise.resolve();

  async function writeRecord(record) {
    if (!resolvedPath) return;
    const line = `${JSON.stringify({ ...record, timestamp: now() })}\n`;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > limit) return;
    await ensureDiagnosticPath(resolvedPath);

    let currentBytes = 0;
    try {
      const current = await lstat(resolvedPath);
      if (current.isSymbolicLink() || !current.isFile()) throw new Error('diagnostic log file is unsafe');
      currentBytes = current.size;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    if (currentBytes + lineBytes > limit) {
      await rm(rotatedPath, { force: true }).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      await rename(resolvedPath, rotatedPath).catch((error) => {
        if (!isMissing(error)) throw error;
      });
      await chmod(rotatedPath, 0o600).catch(() => {});
    }
    await appendFile(resolvedPath, line, { encoding: 'utf8', mode: 0o600 });
    await chmod(resolvedPath, 0o600);
  }

  function log(event = {}) {
    if (!resolvedPath) return Promise.resolve();
    writes = writes.then(() => writeRecord(safeDiagnosticRecord(event))).catch(() => {});
    return writes;
  }

  return Object.freeze({
    filePath: resolvedPath,
    maxBytes: limit,
    log,
    flush: () => writes
  });
}

let defaultDiagnosticLogger;
export function getDictationDiagnosticLogger() {
  if (!defaultDiagnosticLogger) {
    defaultDiagnosticLogger = createDictationDiagnosticLogger();
  }
  return defaultDiagnosticLogger;
}

async function recordPhase(logger, phase, request, fields = {}) {
  try {
    await Promise.resolve(logger?.log?.({ phase, ...diagnosticRequestFields(request), ...fields }));
  } catch {
    // Diagnostics must never change the request outcome.
  }
}

function exitCodeOf(value) {
  return Number.isInteger(value?.exitCode) ? value.exitCode : null;
}

function stderrOf(value) {
  return sanitizeDiagnosticStderr(value?.stderr ?? value?.diagnostic ?? value?.stderrSummary);
}

function defaultModuleLoader(url) {
  return import(url);
}

function normalizeSharedError(error) {
  const code = String(error?.code || '');
  let normalized;
  if (['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(code)) normalized = voiceError('ASR_ENGINE_UNAVAILABLE');
  else if (['AUDIO_NO_SPEECH', 'ACCOUNT_CONTEXT_MISMATCH', 'ACCOUNT_ACCESS_DISABLED', 'ACCOUNT_QUOTA_NOT_CONFIGURED', 'ACCOUNT_REQUEST_RATE_LIMITED', 'ACCOUNT_CONCURRENCY_LIMITED', 'ACCOUNT_USAGE_LIMIT_REACHED', 'ACCESS_CONTROL_UNAVAILABLE'].includes(code)) normalized = voiceError(code);
  else if (code === 'ASR_BUSY') normalized = voiceError('ASR_BUSY');
  else if (code === 'TRANSCRIPTION_TIMEOUT' || code === 'TIMEOUT') normalized = voiceError('TIMEOUT');
  else if (code === 'AUDIO_TOO_LARGE') normalized = voiceError('AUDIO_TOO_LARGE');
  else if (code === 'AUDIO_TOO_LONG') normalized = voiceError('AUDIO_TOO_LONG');
  else if (code === 'AUDIO_EMPTY') normalized = voiceError('AUDIO_EMPTY');
  else if (code === 'AUDIO_FORMAT_UNSUPPORTED' || code === 'AUDIO_DECODE_FAILED') normalized = voiceError('AUDIO_INVALID');
  else if (code === 'ASR_ENGINE_UNAVAILABLE') normalized = voiceError('ASR_ENGINE_UNAVAILABLE');
  else if (code === 'ASR_MODEL_MISSING') normalized = voiceError('ASR_MODEL_MISSING');
  else if (code === 'CANCELLED') normalized = voiceError('CANCELLED');
  else normalized = voiceError('TRANSCRIPTION_FAILED');
  if (Number.isInteger(error?.exitCode)) normalized.exitCode = error.exitCode;
  if (error?.diagnostic || error?.stderr) normalized.stderr = error.diagnostic || error.stderr;
  return normalized;
}

function safeScopeSegment(value, prefix) {
  const normalized = String(value || '').trim();
  if (!normalized) throw voiceError('VOICE_REQUEST_INVALID');
  if (/^[A-Za-z0-9._:-]+$/.test(normalized)) return `${prefix}-${normalized}`;
  const digest = createHash('sha256').update(normalized).digest('hex');
  return `${prefix}-sha256-${digest}`;
}

function assertWithinRoot(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw voiceError('TEMP_DIRECTORY_UNSAFE');
  }
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw voiceError('TEMP_DIRECTORY_UNSAFE');
  await chmod(directory, 0o700);
}

async function createRequestDirectory({ tempRoot, ownerId, requestId }) {
  const root = path.resolve(tempRoot);
  const ownerDirectory = path.join(root, safeScopeSegment(ownerId, 'owner'));
  const requestDirectory = path.join(ownerDirectory, `request-${requestId}`);
  assertWithinRoot(root, ownerDirectory);
  assertWithinRoot(root, requestDirectory);
  let createdRequestDirectory = false;
  try {
    await ensurePrivateDirectory(root);
    await ensurePrivateDirectory(ownerDirectory);
    await mkdir(requestDirectory, { mode: 0o700 });
    createdRequestDirectory = true;
    const stats = await lstat(requestDirectory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw voiceError('TEMP_DIRECTORY_UNSAFE');
    await chmod(requestDirectory, 0o700);
    return { root, ownerDirectory, requestDirectory };
  } catch (error) {
    if (createdRequestDirectory) await rm(requestDirectory, { recursive: true, force: true }).catch(() => {});
    await rmdir(ownerDirectory).catch(() => {});
    throw error;
  }
}

async function cleanupRequestDirectory(paths) {
  if (!paths) return;
  await rm(paths.requestDirectory, { recursive: true, force: true });
  await rmdir(paths.ownerDirectory).catch(() => {});
}

function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(voiceError('TIMEOUT')), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

async function transcribeWithSharedModule({ moduleLoader, request, requestDirectory, logger, diagnostics }) {
  const module = await moduleLoader(LOCAL_VOICE_ASR_MODULE_URL);
  if (
    typeof module?.createTranscribeService !== 'function' ||
    typeof module?.createWhisperRunner !== 'function'
  ) {
    throw voiceError('ASR_ENGINE_UNAVAILABLE');
  }

  const sharedProcessRunner = typeof module.runProcess === 'function' ? module.runProcess : null;
  const processRunner = sharedProcessRunner
    ? async (input) => {
      const isWhisper = input.command === LOCAL_VOICE_ASR_CLI;
      const onSpawn = (pid) => {
        input.onSpawn?.(pid);
        if (isWhisper) {
          diagnostics.started = true;
          void recordPhase(logger, 'whisper_started', request);
        }
      };
      try {
        const result = await sharedProcessRunner({ ...input, onSpawn });
        if (isWhisper) {
          diagnostics.exited = true;
          await recordPhase(logger, 'whisper_exited', request, {
            exitCode: 0,
            stderrSummary: stderrOf(result)
          });
        }
        return result;
      } catch (error) {
        if (isWhisper) {
          if (error?.code === 'TRANSCRIPTION_TIMEOUT') {
            diagnostics.timeout = true;
            await recordPhase(logger, 'whisper_timeout', request, {
              errorCode: 'TIMEOUT',
              exitCode: exitCodeOf(error),
              stderrSummary: stderrOf(error)
            });
          } else {
            diagnostics.exited = true;
            await recordPhase(logger, 'whisper_exited', request, {
              errorCode: normalizeSharedError(error).code,
              exitCode: exitCodeOf(error),
              stderrSummary: stderrOf(error)
            });
          }
        }
        throw error;
      }
    }
    : null;
  const runnerOptions = {
    tempRoot: requestDirectory,
    maxDurationMs: DICTATION_LIMITS.maxDurationMs,
    timeoutMs: DICTATION_LIMITS.timeoutMs
  };
  if (processRunner) runnerOptions.processRunner = processRunner;
  const runner = module.createWhisperRunner(runnerOptions);
  const service = module.createTranscribeService({
    runner,
    limits: {
      ...(module.DEFAULT_LIMITS || {}),
      maxBytes: DICTATION_LIMITS.maxBytes,
      maxDurationMs: DICTATION_LIMITS.maxDurationMs,
      timeoutMs: DICTATION_LIMITS.timeoutMs,
      concurrency: DICTATION_LIMITS.concurrency,
      maxQueueDepth: 0
    },
    maxQueueDepth: 0
  });
  return service.transcribeAudio({
    authenticatedUserId: request.ownerId,
    audioFile: request.audioBytes,
    mimeType: request.format,
    language: 'zh',
    clientRequestId: request.requestId
  });
}

function normalizeResult(raw, request, startedAt, providerId) {
  const transcript = String(raw?.transcript || '').trim();
  if (!transcript) throw voiceError('TRANSCRIPTION_FAILED');
  return {
    requestId: request.requestId,
    transcript,
    durationMs: request.durationMs,
    latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    providerId,
    cleanupStatus: 'cleaned',
    autoSend: false,
    errorCode: null
  };
}

export function createVoiceDictationRuntime({
  moduleLoader = defaultModuleLoader,
  tempRoot = path.join(os.tmpdir(), 'ai-fenshen-dictation'),
  transcribeImpl = null,
  providerId = DICTATION_PROVIDER_ID,
  maxQueueDepth = DICTATION_LIMITS.maxQueueDepth,
  clock = () => Date.now(),
  logger = getDictationDiagnosticLogger()
} = {}) {
  const pending = new Map();
  const completed = new Map();
  const queue = [];
  let active = false;
  let activeExecution = null;
  let closed = false;

  function keyFor(request) {
    return `${request.ownerId}\u0000${request.requestId}`;
  }

  function rememberCompleted(key, value) {
    completed.delete(key);
    completed.set(key, value);
    while (completed.size > 128) completed.delete(completed.keys().next().value);
  }

  async function execute(job) {
    const startedAt = performance.now();
    let paths = null;
    let originalError = null;
    let cleanupStatus = 'not_started';
    let rawResult = null;
    const diagnostics = { started: false, exited: false, timeout: false };
    try {
      paths = await createRequestDirectory({
        tempRoot,
        ownerId: job.request.ownerId,
        requestId: job.request.requestId
      });
      cleanupStatus = 'pending';
      await recordPhase(logger, 'temp_dir_created', job.request, { cleanupStatus });
      const operation = typeof transcribeImpl === 'function'
        ? (async () => {
          diagnostics.started = true;
          await recordPhase(logger, 'whisper_started', job.request);
          try {
            const result = await transcribeImpl({
              request: job.request,
              invocation: job.invocation,
              requestDirectory: paths.requestDirectory,
              signal: job.signal
            });
            diagnostics.exited = true;
            await recordPhase(logger, 'whisper_exited', job.request, {
              exitCode: exitCodeOf(result),
              stderrSummary: stderrOf(result)
            });
            return result;
          } catch (error) {
            if (error?.code === 'TIMEOUT' || error?.code === 'TRANSCRIPTION_TIMEOUT') {
              diagnostics.timeout = true;
              await recordPhase(logger, 'whisper_timeout', job.request, {
                errorCode: 'TIMEOUT',
                exitCode: exitCodeOf(error),
                stderrSummary: stderrOf(error)
              });
            } else {
              diagnostics.exited = true;
              await recordPhase(logger, 'whisper_exited', job.request, {
                errorCode: normalizeSharedError(error).code,
                exitCode: exitCodeOf(error),
                stderrSummary: stderrOf(error)
              });
            }
            throw error;
          }
        })()
        : transcribeWithSharedModule({
          moduleLoader,
          request: job.request,
          requestDirectory: paths.requestDirectory,
          logger,
          diagnostics
        });
      rawResult = await withTimeout(operation, DICTATION_LIMITS.timeoutMs);
    } catch (error) {
      originalError = normalizeSharedError(error);
      if (!diagnostics.started) {
        await recordPhase(logger, 'whisper_not_started', job.request, {
          errorCode: originalError.code,
          exitCode: exitCodeOf(error),
          stderrSummary: stderrOf(error)
        });
      } else if (originalError.code === 'TIMEOUT' && !diagnostics.timeout) {
        diagnostics.timeout = true;
        await recordPhase(logger, 'whisper_timeout', job.request, {
          errorCode: 'TIMEOUT',
          exitCode: exitCodeOf(error),
          stderrSummary: stderrOf(error)
        });
      } else if (!diagnostics.exited && !diagnostics.timeout) {
        diagnostics.exited = true;
        await recordPhase(logger, 'whisper_exited', job.request, {
          errorCode: originalError.code,
          exitCode: exitCodeOf(error),
          stderrSummary: stderrOf(error)
        });
      }
    } finally {
      if (paths) {
        try {
          await cleanupRequestDirectory(paths);
          cleanupStatus = 'cleaned';
          await recordPhase(logger, 'cleanup_completed', job.request, { cleanupStatus });
        } catch (error) {
          cleanupStatus = 'cleanup_failed';
          await recordPhase(logger, 'cleanup_failed', job.request, {
            cleanupStatus,
            errorCode: 'CLEANUP_FAILED',
            stderrSummary: stderrOf(error)
          });
        }
      } else {
        await recordPhase(logger, 'cleanup_completed', job.request, { cleanupStatus });
      }
    }

    if (originalError) {
      originalError.cleanupStatus = cleanupStatus;
      originalError.latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      throw originalError;
    }
    if (cleanupStatus !== 'cleaned') {
      const error = voiceError('CLEANUP_FAILED');
      error.cleanupStatus = cleanupStatus;
      throw error;
    }
    let result;
    try {
      result = normalizeResult(rawResult, job.request, startedAt, providerId);
    } catch (error) {
      error.cleanupStatus = cleanupStatus;
      error.latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      throw error;
    }
    result.cleanupStatus = cleanupStatus;
    return result;
  }

  async function pump() {
    if (active || closed) return;
    const job = queue.shift();
    if (!job) return;
    active = true;
    job.active = true;
    const execution = execute(job);
    activeExecution = execution;
    try {
      const result = await execution;
      if (!job.cancelled) {
        rememberCompleted(job.key, { audioHash: job.request.audioHash, result });
        if (!job.settled) {
          job.settled = true;
          job.resolve(result);
        }
      }
    } catch (error) {
      if (!job.settled) {
        job.settled = true;
        job.reject(error);
      }
    } finally {
      if (activeExecution === execution) activeExecution = null;
      pending.delete(job.key);
      active = false;
      job.done = true;
      queueMicrotask(() => { void pump(); });
    }
  }

  function transcribe(input, invocation = {}) {
    if (closed) return Promise.reject(voiceError('TRANSCRIPTION_FAILED'));
    let request;
    try {
      request = Object.freeze({
        ...validateDictationRequest(input),
        contentType: input?.contentType || input?.format || null
      });
    } catch (error) {
      return Promise.reject(error);
    }
    const key = keyFor(request);
    const cached = completed.get(key);
    if (cached) {
      if (cached.audioHash !== request.audioHash) return Promise.reject(voiceError('REQUEST_CONFLICT'));
      return Promise.resolve(cached.result);
    }
    const existing = pending.get(key);
    if (existing) {
      if (existing.request.audioHash !== request.audioHash) return Promise.reject(voiceError('REQUEST_CONFLICT'));
      return existing.promise;
    }
    if (active && queue.length >= maxQueueDepth) return Promise.reject(voiceError('ASR_BUSY'));

    const job = {
      key,
      request,
      invocation,
      active: false,
      cancelled: false,
      settled: false,
      done: false,
      signal: null,
      resolve: null,
      reject: null,
      promise: null
    };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    const controller = new AbortController();
    job.signal = controller.signal;
    job.controller = controller;
    pending.set(key, job);
    queue.push(job);
    void pump();
    return job.promise;
  }

  function cancel({ ownerId, requestId, audioHash = null } = {}) {
    const key = `${String(ownerId || '').trim()}\u0000${String(requestId || '').trim()}`;
    const job = pending.get(key);
    if (!job) return false;
    if (audioHash && job.request.audioHash !== String(audioHash).trim().toLowerCase()) return false;
    job.cancelled = true;
    job.controller.abort();
    if (!job.active) {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      pending.delete(key);
      if (!job.settled) {
        job.settled = true;
        job.reject(voiceError('CANCELLED'));
      }
    } else if (!job.settled) {
      job.settled = true;
      job.reject(voiceError('CANCELLED'));
    }
    return true;
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const job of [...queue]) cancel({
      ownerId: job.request.ownerId,
      requestId: job.request.requestId,
      audioHash: job.request.audioHash
    });
    for (const job of pending.values()) {
      if (job.active) cancel({
        ownerId: job.request.ownerId,
        requestId: job.request.requestId,
        audioHash: job.request.audioHash
      });
    }
    await activeExecution?.catch?.(() => {});
  }

  return Object.freeze({
    limits: DICTATION_LIMITS,
    transcribe,
    cancel,
    close,
    inspect() {
      return Object.freeze({ active: active ? 1 : 0, queued: queue.length, pending: pending.size, completed: completed.size, now: clock() });
    }
  });
}
