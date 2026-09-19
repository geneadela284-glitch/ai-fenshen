import DocumentPanel, { DocumentAttachmentMenu } from './DocumentPanel.jsx';
import { DocumentQaContext } from './useDocumentQa.js';
import { useContext, useEffect, useRef } from 'react';
import * as m from 'motion/react-m';
import AttachmentPreview from './AttachmentPreview.jsx';
import Icon from './Icon.jsx';
import VoiceInputMock from './VoiceInputMock.jsx';
import { submitComposerMessage } from './composerSubmission.js';
import { calculateComposerHeight } from './prototypeState.js';
import { VoiceWaveIcon } from './voiceChat/VoiceChatPanel.jsx';

const DICTATION_ACTIVE_STATES = new Set(['requesting_permission', 'recording', 'processing', 'processingVoice']);
const DICTATION_FAILURE_MESSAGES = Object.freeze({
  permission_denied: '请允许麦克风权限后重试',
  recording_failed: '录音没能开始，请重试',
  audio_invalid: '没有听清，请重试',
  timeout: '没有听清，请重试',
  busy: '正在处理上一段语音，请稍候',
  transcription_failed: '没有听清，请重试'
});

export default function ChatComposer({
  draft,
  attachments = [],
  composerState = 'idle',
  voiceState = 'idle',
  voiceError = '',
  voiceDurationMs = 0,
  voiceLevel = 0,
  reducedMotion = false,
  onDraftChange,
  onFocus,
  onSend,
  onStop,
  onAttach,
  onSelectImages,
  onRemoveAttachment,
  onVoice,
  onVoiceChat,
  onVoiceCancel,
  error,
  onRetry
}) {
  const documentQa = useContext(DocumentQaContext);
  const textareaRef = useRef(null);
  const suppressFocusRef = useRef(false);
  const isStreaming = ['streaming', 'stopping'].includes(composerState);
  const isSending = ['sending', 'streaming', 'stopping'].includes(composerState);
  const canSend = Boolean(draft.trim() || attachments.length || documentQa?.state.document) && !isSending && documentQa?.state.state !== 'parsing';
  const dictationActive = DICTATION_ACTIVE_STATES.has(voiceState);
  const canStartVoiceChat = Boolean(onVoiceChat) && !draft.trim() && !attachments.length && !documentQa?.state.document && !isSending && documentQa?.state.state !== 'parsing' && !dictationActive;
  const dictationRecording = voiceState === 'recording';
  const dictationProcessing = voiceState === 'processing';
  const dictationReady = voiceState === 'draft_ready';
  const inlineDictationError = DICTATION_FAILURE_MESSAGES[voiceState] || '';

  const allowNativePicker = (event) => {
    if (onAttach?.('image') === false) {
      event.preventDefault();
      event.currentTarget.value = '';
    }
  };

  const handleSelectedFiles = (event) => {
    const input = event.currentTarget;
    const selected = Array.from(input.files || []);
    input.value = '';
    if (selected.length) onSelectImages?.(selected);
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '56px';
    const viewportHeight = window.visualViewport?.height || window.innerHeight || 812;
    const height = calculateComposerHeight({ scrollHeight: textarea.scrollHeight, viewportHeight });
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > height ? 'auto' : 'hidden';
  }, [draft, voiceState]);

  useEffect(() => {
    if (!dictationReady) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    const alreadyFocused = document.activeElement === textarea;
    suppressFocusRef.current = !alreadyFocused;
    textarea.focus({ preventScroll: true });
    const end = textarea.value.length;
    if (document.activeElement === textarea) textarea.setSelectionRange(end, end);
    if (document.activeElement !== textarea) suppressFocusRef.current = false;
    if (alreadyFocused) suppressFocusRef.current = false;
  }, [dictationReady, draft]);

  const handleTextareaFocus = () => {
    if (suppressFocusRef.current) {
      suppressFocusRef.current = false;
      return;
    }
    onFocus?.();
  };

  const submitMessage = () => submitComposerMessage({
    draft: draft || (documentQa?.state.document ? '请概括这份文件的主要内容。' : ''),
    attachments,
    isSending: isSending || documentQa?.state.state === 'parsing',
    input: textareaRef.current,
    activeElement: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    clearDraft: () => onDraftChange?.(''),
    sendMessage: (content, selectedAttachments) => onSend?.(content, selectedAttachments)
  });

  const textarea = (
    <textarea
      ref={textareaRef}
      rows="1"
      value={draft}
      placeholder="告诉AI分身你想完成什么…"
      onChange={(event) => onDraftChange?.(event.target.value)}
      onFocus={handleTextareaFocus}
      onCompositionStart={(event) => { event.currentTarget.dataset.composing = 'true'; }}
      onCompositionEnd={(event) => { event.currentTarget.dataset.composing = 'false'; }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && event.currentTarget.dataset.composing !== 'true' && !event.nativeEvent.isComposing) {
          event.preventDefault();
          submitMessage();
        }
      }}
      aria-label="对话输入框"
    />
  );

  return (
    <m.section
      className="af-composer-shell"
      data-testid="chat-composer"
      data-composer-state={composerState}
      data-dictation-error={voiceError || undefined}
    >
      <DocumentPanel busy={isSending} />
      <AttachmentPreview attachments={attachments} onRemove={onRemoveAttachment} />
      {error ? (
        <div className="af-composer-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => onRetry?.()}><Icon name="refresh" size={16} />重试</button>
        </div>
      ) : null}
      {inlineDictationError ? (
        <div className="af-dictation-inline-error" role="status" aria-live="polite">{inlineDictationError}</div>
      ) : null}
      <div
        className={`af-composer ${dictationActive ? 'is-dictation-active' : ''} ${dictationReady ? 'is-dictation-ready' : ''}`}
        data-dictation-state={voiceState}
        aria-busy={dictationProcessing || (dictationActive && !dictationRecording) ? 'true' : undefined}
      >
        {documentQa?.available ? <DocumentAttachmentMenu onSelectImages={onSelectImages} onAttach={onAttach} imageDisabled={isSending} /> : <div className="af-attach-wrap">
          <m.span
            className="af-composer-button"
            aria-hidden="true"
          >
            <Icon name="paperclip" size={22} />
          </m.span>
          <input
            className="af-attachment-input"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            multiple
            aria-label="添加图片"
            onClick={allowNativePicker}
            onCancel={(event) => { event.currentTarget.value = ''; }}
            onChange={handleSelectedFiles}
          />
        </div>}
        {dictationActive ? (
          <VoiceInputMock
            state={voiceState}
            onClick={onVoice}
            onCancel={onVoiceCancel}
            durationMs={voiceDurationMs}
            level={voiceLevel}
            reducedMotion={reducedMotion}
          />
        ) : (
          <>
            {textarea}
            <VoiceInputMock
              state={voiceState}
              onClick={onVoice}
              onCancel={onVoiceCancel}
              reducedMotion={reducedMotion}
            />
            {isStreaming ? (
              <m.button type="button" className="af-send-button is-stop" whileTap={{ scale: 0.88 }} onClick={onStop} disabled={composerState === 'stopping'} aria-label="停止生成"><Icon name="player-stop" size={20} /></m.button>
            ) : (
              <m.button type="button" className="af-send-button" whileTap={canSend || canStartVoiceChat ? { scale: 0.88 } : undefined} onClick={canStartVoiceChat ? onVoiceChat : submitMessage} disabled={!canSend && !canStartVoiceChat} aria-label={canStartVoiceChat ? '开始语音聊天' : '发送消息'}>{canStartVoiceChat ? <VoiceWaveIcon /> : <Icon name="send" size={21} />}</m.button>
            )}
          </>
        )}
        {dictationReady ? <span className="af-dictation-ready-status" aria-live="polite">文字已生成</span> : null}
      </div>
    </m.section>
  );
}
