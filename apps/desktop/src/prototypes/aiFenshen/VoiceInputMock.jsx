import * as m from 'motion/react-m';
import { useRef } from 'react';
import Icon from './Icon.jsx';
import { createDictationCancelDispatcher } from './dictationCancel.js';

const MAX_DURATION_MS = 30_000;
const WAVEFORM = [0.42, 0.68, 0.9, 0.58, 0.78, 0.48, 0.72];

const labels = {
  idle: '开始语音输入',
  requesting_permission: '正在请求麦克风权限',
  recording: '录音中',
  processing: '正在转写，点击取消',
  processingVoice: '正在转写，点击取消',
  draft_ready: '文字已生成，可编辑',
  permission_denied: '麦克风权限被拒绝，点击重试',
  recording_failed: '录音失败，点击重试',
  audio_invalid: '录音无效，点击重试',
  timeout: '语音转写超时，点击重试',
  busy: '语音转写繁忙，点击重试',
  transcription_failed: '语音转写失败，点击重试',
  service_unavailable: '语音识别服务暂时不可用',
  account_unavailable: '当前账号暂时无法使用语音识别',
  no_speech: '没有听到有效语音，点击重试',
  cancelled: '语音输入已取消，点击重试'
};

export function formatDictationDuration(durationMs = 0) {
  const totalSeconds = Math.max(0, Math.floor((Number(durationMs) || 0) / 1_000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function Waveform({ level = 0, processing = false, reducedMotion = false }) {
  const normalizedLevel = Math.max(0, Math.min(1, Number(level) || 0));
  return (
    <span
      className={`af-dictation-waveform ${processing ? 'is-processing' : ''}`}
      data-testid="dictation-waveform"
      aria-hidden="true"
      style={{ '--af-dictation-level': String(normalizedLevel) }}
    >
      {WAVEFORM.map((base, index) => (
        <i
          key={index}
          className="af-dictation-wave-bar"
          style={{
            '--af-dictation-bar-height': `${Math.round(8 + (base * 17) + (normalizedLevel * 12))}px`,
            '--af-dictation-bar-delay': `${index * 52}ms`
          }}
        />
      ))}
    </span>
  );
}

function ProcessingDots() {
  return (
    <span className="af-dictation-processing-dots" aria-hidden="true">
      <i /><i /><i />
    </span>
  );
}

export default function VoiceInputMock({
  state = 'idle',
  onClick,
  onCancel,
  durationMs = 0,
  level = 0,
  reducedMotion = false
}) {
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const cancelDispatcherRef = useRef(null);
  if (!cancelDispatcherRef.current) {
    cancelDispatcherRef.current = createDictationCancelDispatcher(() => onCancelRef.current?.());
  }
  const handleCancel = cancelDispatcherRef.current.handle;
  const activeState = state === 'processingVoice' ? 'processing' : state;
  const active = ['requesting_permission', 'recording', 'processing'].includes(activeState);
  const recording = activeState === 'recording';
  const processing = activeState === 'processing';
  const remainingMs = Math.max(0, MAX_DURATION_MS - (Number(durationMs) || 0));

  if (active) {
    return (
      <m.div
        className={`af-dictation-bar is-${activeState}`}
        data-testid="dictation-bar"
        data-dictation-state={activeState}
        role={processing || activeState === 'requesting_permission' ? 'status' : undefined}
        aria-live="polite"
        aria-busy={processing}
      >
        <button
          type="button"
          className="af-dictation-action af-dictation-cancel"
          onPointerUp={handleCancel}
          onTouchEnd={handleCancel}
          onClick={handleCancel}
          aria-label={processing ? '取消转写' : '取消录音'}
        >
          <Icon name="x" size={18} />
        </button>
        <div className="af-dictation-center">
          {recording ? (
            <>
              <Waveform level={level} reducedMotion={reducedMotion} />
              <time className="af-dictation-duration" dateTime={`PT${Math.floor((Number(durationMs) || 0) / 1_000)}S`}>
                {formatDictationDuration(durationMs)}
              </time>
              <span className="af-dictation-remaining">剩余 {formatDictationDuration(remainingMs)}</span>
            </>
          ) : processing ? (
            <>
              <Waveform processing reducedMotion={reducedMotion} />
              <span className="af-dictation-processing-label">正在转成文字…</span>
              <ProcessingDots />
            </>
          ) : (
            <span className="af-dictation-processing-label">正在请求麦克风权限…</span>
          )}
        </div>
        {recording ? (
          <m.button
            type="button"
            className="af-dictation-action af-dictation-stop"
            onClick={onClick}
            whileTap={reducedMotion ? undefined : { scale: 0.9 }}
            aria-label="停止录音"
          >
            <Icon name="player-stop" size={18} />
          </m.button>
        ) : <span className="af-dictation-action-placeholder" aria-hidden="true" />}
      </m.div>
    );
  }

  const ready = state === 'draft_ready';
  const failure = ['permission_denied', 'recording_failed', 'audio_invalid', 'timeout', 'busy', 'transcription_failed', 'service_unavailable', 'account_unavailable', 'no_speech'].includes(state);
  return (
    <m.button
      type="button"
      data-testid="dictation-trigger"
      className={`af-composer-button af-voice-button ${ready ? 'is-ready' : ''} ${failure ? 'is-error' : ''}`}
      data-dictation-state={state}
      onClick={onClick}
      whileTap={reducedMotion ? undefined : { scale: 0.92 }}
      aria-label={labels[state] || labels.idle}
    >
      <Icon name="microphone" size={21} />
    </m.button>
  );
}
