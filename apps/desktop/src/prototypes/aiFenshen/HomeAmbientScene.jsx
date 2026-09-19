import * as m from 'motion/react-m';
import AIBrainAvatar from './AIBrainAvatar.jsx';
import AIFenshenWordmark from './AIFenshenWordmark.jsx';
import ChatComposer from './ChatComposer.jsx';
import DualTaskBubbles from './DualTaskBubbles.jsx';
import ReminderBubbleSequence from './ReminderBubbleSequence.jsx';
import { featureIntroItems } from './homeFeatureIntro.js';

export default function HomeAmbientScene({
  homeState,
  draft,
  attachments,
  composerState,
  voiceState,
  voiceError,
  voiceDurationMs,
  voiceLevel,
  onDraftChange,
  onEnterChat,
  onToggleBrain,
  onCloseBrain,
  onSelectFunction,
  onRemindersComplete,
  onAttach,
  onSelectImages,
  onRemoveAttachment,
  onVoice,
  onVoiceChat,
  onVoiceCancel,
  onTransitionComplete,
  reducedMotion,
  tasksState,
  onTasksRetry,
  onTaskToggle,
  busyTaskId,
  taskActionError,
  bubbleIdentity,
  featureIntroPresentation = 'expanded',
  onFeatureIntroSkip,
  onFeatureIntroComplete,
  onFeatureIntroReopen,
  reminderItemsOverride,
  reminderScenario,
  transitionProgress,
  transitionState
}) {
  const leaving = transitionState === 'entering';
  const returning = transitionState === 'exiting';
  const brainOpen = homeState === 'brainOpen';
  const showManualFeatureIntro = featureIntroPresentation === 'manual';
  const bubbleItems = reminderItemsOverride ?? featureIntroItems;
  const duration = reducedMotion ? 0.14 : 0.4;
  const rootVisible = { filter: 'blur(0px)', scale: 1, y: 0 };
  const rootHidden = reducedMotion
    ? { filter: 'blur(0px)', scale: 1, y: 0 }
    : { filter: 'blur(12px)', scale: 0.985, y: -8 };
  const progress = transitionProgress ?? (leaving ? 1 : 0);
  const effectiveVoiceState = voiceState ?? composerState;
  const rootTarget = transitionProgress === null
    ? (leaving ? rootHidden : rootVisible)
    : {
        filter: reducedMotion ? 'blur(0px)' : `blur(${Math.round(12 * progress)}px)`,
        scale: reducedMotion ? 1 : 1 - (0.015 * progress),
        y: reducedMotion ? 0 : -8 * progress
      };
  const layerTarget = (start, distance = 10) => {
    const layerProgress = Math.max(0, Math.min(1, (progress - start) / (1 - start)));
    return {
      opacity: 1 - layerProgress,
      filter: reducedMotion ? 'blur(0px)' : `blur(${Math.round(9 * layerProgress)}px)`,
      scale: reducedMotion ? 1 : 1 - (0.018 * layerProgress),
      y: reducedMotion ? 0 : -distance * layerProgress
    };
  };
  const layerTransition = (delay = 0) => transitionProgress !== null
    ? { duration: 0 }
    : { duration: reducedMotion ? 0.14 : 0.24, delay: leaving && !reducedMotion ? delay : 0, ease: [0.22, 0.8, 0.22, 1] };

  return (
    <m.main
      className={`af-home af-home-layer ${leaving ? 'is-leaving' : ''} ${returning ? 'is-returning' : ''}`}
      data-testid="home-view"
      aria-hidden={leaving}
      inert={leaving}
      initial={returning ? rootHidden : false}
      animate={rootTarget}
      exit={{ ...rootHidden, transition: { duration: 0 } }}
      transition={transitionProgress !== null ? { duration: 0 } : { duration, ease: [0.22, 0.8, 0.22, 1] }}
      onAnimationComplete={() => {
        if (leaving && transitionProgress === null) onTransitionComplete?.();
      }}
      onClick={(event) => {
        const interactiveTarget = event.target.closest?.('button, input, textarea, a');
        if (brainOpen && !interactiveTarget) onCloseBrain();
      }}
    >
      <m.div className="af-home-motion-layer af-home-decoration-layer" initial={returning ? layerTarget(0.38) : false} animate={layerTarget(0.38)} transition={layerTransition(0.12)}>
        <div className="af-home-ambient-glow" aria-hidden="true" />
      </m.div>
      <m.div className="af-home-motion-layer af-home-identity-layer" initial={returning ? layerTarget(0.16) : false} animate={layerTarget(0.16)} transition={layerTransition(0.06)}>
        <div className="af-home-hero-visual">
          <div className="af-home-avatar" aria-hidden="true" />
          <AIBrainAvatar open={brainOpen} onToggle={onToggleBrain} onSelect={onSelectFunction} reducedMotion={reducedMotion} />
        </div>
        <div className="af-home-vignette" aria-hidden="true" />
        <header className="af-home-header">
          <AIFenshenWordmark size="small" reducedMotion={reducedMotion} />
          <span className="af-online"><i aria-hidden="true" /> 在线</span>
        </header>
      </m.div>
      <m.div className="af-home-motion-layer af-home-reminder-layer" initial={returning ? layerTarget(0) : false} animate={layerTarget(0)} transition={layerTransition(0)}>
        <DualTaskBubbles
          tasksState={tasksState}
          userId={bubbleIdentity}
          reducedMotion={reducedMotion}
          onRetry={onTasksRetry}
        />
        {showManualFeatureIntro ? (
          <ReminderBubbleSequence
            key={bubbleItems.map((item) => item.id || item.title).join('|')}
            items={bubbleItems}
            compact={false}
            onSkip={onFeatureIntroSkip}
            onComplete={onFeatureIntroComplete}
            onReopen={onFeatureIntroReopen}
            reducedMotion={reducedMotion}
            initialPhase={reminderScenario?.phase || 'blurred'}
            freeze={Boolean(reminderScenario?.freeze)}
          />
        ) : null}
      </m.div>
      <m.div className="af-home-composer" initial={returning ? layerTarget(0.46, 5) : false} animate={layerTarget(0.46, 5)} transition={layerTransition(0.14)}>
        <ChatComposer
          draft={draft}
          attachments={attachments}
          composerState={composerState}
          voiceState={effectiveVoiceState}
          voiceError={voiceError}
          voiceDurationMs={voiceDurationMs}
          voiceLevel={voiceLevel}
          reducedMotion={reducedMotion}
          onDraftChange={onDraftChange}
          onFocus={() => onEnterChat()}
          onAttach={onAttach}
          onSelectImages={onSelectImages}
          onRemoveAttachment={onRemoveAttachment}
          onVoice={onVoice}
          onVoiceChat={onVoiceChat}
          onVoiceCancel={onVoiceCancel}
          onSend={(value, selectedAttachments) => onEnterChat(value, selectedAttachments)}
        />
      </m.div>
    </m.main>
  );
}
