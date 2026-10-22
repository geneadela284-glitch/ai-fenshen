import { useCallback, useEffect, useRef, useState } from 'react';
import { createDictationClient } from './dictationClient.js';
import { createDictationRecorder, DICTATION_MAX_DURATION_MS } from './dictationRecorder.js';
import { mergeDictationDraft } from './dictationDraft.js';

export const DICTATION_FAILURE_MESSAGES = Object.freeze({
  permission_denied: '请允许麦克风权限后重试。',
  recording_failed: '录音启动失败，请重试。',
  audio_invalid: '没有听清，请重试。',
  timeout: '语音识别超时，请稍后重试。',
  service_unavailable: '语音识别服务暂时不可用，请稍后重试。',
  account_unavailable: '当前账号暂时无法使用语音识别，请检查登录和使用额度。',
  no_speech: '没有听到有效语音，请靠近麦克风重试。',
  busy: '正在处理上一条消息，请稍候。',
  transcription_failed: '这次语音识别未完成，请重试。',
  cancelled: '已取消语音转写。'
});

const ACTIVE_STATES = new Set(['requesting_permission', 'recording', 'processing']);

function defaultRequestId() {
  return globalThis.crypto?.randomUUID?.() || `dictation_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function failureState(error) {
  const code = String(error?.code || '').toUpperCase();
  if (code === 'PERMISSION_DENIED' || code === 'MICROPHONE_UNAVAILABLE' || code === 'NOTALLOWEDERROR') return 'permission_denied';
  if (code === 'AUDIO_EMPTY' || code === 'AUDIO_INVALID' || code === 'AUDIO_TOO_LARGE' || code === 'AUDIO_TOO_LONG' || code === 'AUDIO_HASH_MISMATCH') return 'audio_invalid';
  if (['ASR_ENGINE_UNAVAILABLE', 'ASR_MODEL_MISSING', 'ACCESS_CONTROL_UNAVAILABLE'].includes(code)) return 'service_unavailable';
  if (code === 'AUTH_REQUIRED' || code.startsWith('ACCOUNT_')) return 'account_unavailable';
  if (code === 'AUDIO_NO_SPEECH') return 'no_speech';
  if (code === 'ASR_BUSY') return 'busy';
  if (code === 'TIMEOUT' || code === 'TRANSCRIPTION_TIMEOUT') return 'timeout';
  if (code === 'CANCELLED' || code === 'ABORT_ERR') return 'cancelled';
  if (code === 'RECORDING_FAILED') return 'recording_failed';
  return 'transcription_failed';
}

export function useDictation({
  draft = '',
  onDraftChange = () => {},
  busy = false,
  showToast = () => {},
  onSettled = () => {},
  clientFactory = createDictationClient,
  recorderFactory = createDictationRecorder,
  idFactory = defaultRequestId
} = {}) {
  const [voiceState, setVoiceState] = useState('idle');
  const [voiceError, setVoiceError] = useState('');
  const [voiceDurationMs, setVoiceDurationMs] = useState(0);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const stateRef = useRef('idle');
  const settledRef = useRef(onSettled); settledRef.current = onSettled;
  const draftRef = useRef(draft);
  const onDraftChangeRef = useRef(onDraftChange);
  const clientRef = useRef(null);
  const recorderRef = useRef(null);
  const requestRef = useRef(null);
  const transientTimerRef = useRef(null);
  const mountedRef = useRef(true);

  draftRef.current = draft;
  onDraftChangeRef.current = onDraftChange;
  if (!clientRef.current) clientRef.current = clientFactory();

  const setState = useCallback((next) => {
    const wasActive = ACTIVE_STATES.has(stateRef.current);
    stateRef.current = next;
    if (wasActive && !ACTIVE_STATES.has(next)) settledRef.current();
    if (mountedRef.current) setVoiceState(next);
  }, []);

  const clearTransientTimer = useCallback(() => {
    if (transientTimerRef.current) clearTimeout(transientTimerRef.current);
    transientTimerRef.current = null;
  }, []);

  const settleTransient = useCallback((next, durationMs = 2_000) => {
    clearTransientTimer();
    setState(next);
    transientTimerRef.current = setTimeout(() => {
      transientTimerRef.current = null;
      setState('idle');
      setVoiceDurationMs(0);
      setVoiceLevel(0);
    }, durationMs);
  }, [clearTransientTimer, setState]);

  const fail = useCallback((error) => {
    const next = failureState(error);
    setVoiceError(String(error?.code || next));
    setVoiceLevel(0);
    settleTransient(next);
  }, [settleTransient]);

  const transcribe = useCallback(({ blob, durationMs }) => {
    const requestId = idFactory();
    const controller = new AbortController();
    const request = { requestId, controller, cancelled: false };
    requestRef.current = request;
    setState('processing');
    void clientRef.current.transcribe({
      audioBlob: blob,
      requestId,
      durationMs,
      signal: controller.signal
    }).then((payload) => {
      if (request.cancelled || requestRef.current !== request) return;
      const transcript = String(payload?.transcript || '').trim();
      if (!transcript) throw Object.assign(new Error('TRANSCRIPT_EMPTY'), { code: 'TRANSCRIPTION_FAILED' });
      onDraftChangeRef.current(mergeDictationDraft(draftRef.current, transcript));
      setVoiceError('');
      settleTransient('draft_ready', 1_600);
    }).catch((error) => {
      if (request.cancelled || error?.name === 'AbortError' || error?.code === 'CANCELLED') return;
      if (requestRef.current !== request) return;
      fail(error);
    }).finally(() => {
      if (requestRef.current === request) requestRef.current = null;
    });
  }, [fail, idFactory, settleTransient, setState]);

  const start = useCallback(() => {
    if (busy) {
      fail({ code: 'ASR_BUSY' });
      return false;
    }
    if (ACTIVE_STATES.has(stateRef.current)) return false;
    clearTransientTimer();
    setVoiceError('');
    setVoiceDurationMs(0);
    setVoiceLevel(0);
    const recorder = recorderFactory({
      onStateChange: (next) => {
        if (next === 'requesting_permission' || next === 'recording' || next === 'processing') setState(next);
        else if (next === 'permission_denied' || next === 'recording_failed' || next === 'audio_invalid') setState(next);
        else if (next === 'cancelled') settleTransient('cancelled', 1_200);
      },
      onProgress: ({ durationMs = 0, level = 0 } = {}) => {
        if (stateRef.current !== 'recording') return;
        setVoiceDurationMs(Math.max(0, Math.min(DICTATION_MAX_DURATION_MS, Number(durationMs) || 0)));
        setVoiceLevel(Math.max(0, Math.min(1, Number(level) || 0)));
      },
      onAudioReady: ({ blob, durationMs }) => transcribe({ blob, durationMs }),
      onError: fail
    });
    recorderRef.current = recorder;
    void recorder.start();
    return true;
  }, [busy, clearTransientTimer, fail, recorderFactory, setState, settleTransient, transcribe]);

  const cancel = useCallback(() => {
    if (!ACTIVE_STATES.has(stateRef.current)) return false;
    requestRef.current?.controller.abort();
    if (requestRef.current) requestRef.current.cancelled = true;
    recorderRef.current?.cancel?.();
    requestRef.current = null;
    settleTransient('cancelled', 1_200);
    return true;
  }, [settleTransient]);

  const toggle = useCallback(() => {
    if (stateRef.current === 'recording') {
      recorderRef.current?.stop?.();
      return true;
    }
    if (stateRef.current === 'requesting_permission' || stateRef.current === 'processing') return cancel();
    return start();
  }, [cancel, start]);

  useEffect(() => { mountedRef.current = true; return () => {
    mountedRef.current = false;
    clearTransientTimer();
    requestRef.current?.controller.abort();
    if (requestRef.current) requestRef.current.cancelled = true;
    recorderRef.current?.cancel?.();
  }; }, [clearTransientTimer]);

  return Object.freeze({
    voiceState,
    voiceError,
    voiceDurationMs,
    voiceLevel,
    onVoice: toggle,
    onVoiceCancel: cancel,
    voiceBusy: ACTIVE_STATES.has(voiceState)
  });
}
