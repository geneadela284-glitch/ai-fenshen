import AIFenshenWordmark from './AIFenshenWordmark.jsx';
import * as m from 'motion/react-m';
import ChatComposer from './ChatComposer.jsx';
import ChatMessageList from './ChatMessageList.jsx';
import Icon from './Icon.jsx';

export default function ImmersiveChatView({
  transitionState,
  transitionProgress,
  reducedMotion,
  messages,
  draft,
  attachments,
  composerState,
  voiceState,
  voiceBar,
  voiceError,
  voiceDurationMs,
  voiceLevel,
  error,
  onTransitionComplete,
  onBack,
  onNewConversation,
  onDraftChange,
  onSend,
  onStop,
  onAttach,
  onSelectImages,
  onRemoveAttachment,
  onVoice,
  onVoiceChat,
  onVoiceCancel,
  onRetry
}) {
  const entering = transitionState === 'entering';
  const exiting = transitionState === 'exiting';
  const duration = reducedMotion ? 0.14 : 0.38;
  const progress = transitionProgress ?? (exiting ? 0 : 1);
  const effectiveVoiceState = voiceState ?? composerState;
  const hidden = { opacity: 0, y: reducedMotion ? 0 : 10 };
  const visible = { opacity: 1, y: 0 };
  const rootTarget = transitionProgress === null
    ? (exiting ? hidden : visible)
    : { opacity: progress, y: reducedMotion ? 0 : 10 * (1 - progress) };
  const childTarget = (start) => {
    const childProgress = Math.max(0, Math.min(1, (progress - start) / (1 - start)));
    return { opacity: childProgress, y: reducedMotion ? 0 : 7 * (1 - childProgress) };
  };
  const childTransition = (delay) => transitionProgress !== null
    ? { duration: 0 }
    : { duration: reducedMotion ? 0.12 : 0.2, delay: entering && !reducedMotion ? delay : 0, ease: [0.22, 0.8, 0.22, 1] };

  return (
    <m.main
      className={`af-chat af-chat-${transitionState}`}
      data-testid="chat-view"
      initial={entering && transitionProgress === null ? hidden : false}
      animate={rootTarget}
      exit={{ ...hidden, transition: { duration: 0 } }}
      transition={transitionProgress !== null ? { duration: 0 } : { duration, ease: [0.22, 0.8, 0.22, 1] }}
      onAnimationComplete={() => {
        if (exiting && transitionProgress === null) onTransitionComplete?.();
      }}
    >
      <div className="af-chat-backdrop" aria-hidden="true" />
      <m.header className="af-chat-top-controls" initial={entering && transitionProgress === null ? hidden : false} animate={childTarget(0.04)} transition={childTransition(0.06)}>
        <m.button className="af-chat-top-control" type="button" whileTap={{ scale: 0.94 }} onClick={onBack} aria-label="返回首页"><Icon name="arrow-left" size={22} /></m.button>
        <div className="af-chat-title">
          <AIFenshenWordmark size="compact" />
          <span><i aria-hidden="true" /> 在线</span>
        </div>
        <m.button className="af-chat-top-control" type="button" whileTap={{ scale: 0.94 }} onClick={onNewConversation} aria-label="新建对话"><Icon name="edit" size={21} /></m.button>
      </m.header>
      <m.div className="af-chat-message-stage" initial={entering && transitionProgress === null ? hidden : false} animate={childTarget(0.1)} transition={childTransition(0.1)}>
        <ChatMessageList messages={messages} onRetry={onRetry} onDeleteAttachment={onRemoveAttachment} />
      </m.div>
      <m.div className="af-chat-composer" initial={entering && transitionProgress === null ? hidden : false} animate={childTarget(0.18)} transition={childTransition(0.16)}>
        {voiceBar}
        <ChatComposer
          draft={draft}
          attachments={attachments}
          composerState={composerState}
          voiceState={effectiveVoiceState}
          voiceError={voiceError}
          voiceDurationMs={voiceDurationMs}
          voiceLevel={voiceLevel}
          reducedMotion={reducedMotion}
          error={error}
          onDraftChange={onDraftChange}
          onSend={onSend}
          onStop={onStop}
          onAttach={onAttach}
          onSelectImages={onSelectImages}
          onRemoveAttachment={onRemoveAttachment}
          onVoice={onVoice}
          onVoiceChat={onVoiceChat}
          onVoiceCancel={onVoiceCancel}
          onRetry={onRetry}
        />
      </m.div>
    </m.main>
  );
}
