import { AnimatePresence } from 'motion/react';
import * as m from 'motion/react-m';
import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { featureIntroItems } from './homeFeatureIntro.js';
import { advanceReminder } from './prototypeState.js';

export function resolveReminderItems(items) {
  return items?.length ? items : featureIntroItems;
}

export default function ReminderBubbleSequence({
  items,
  onComplete,
  onSkip,
  onReopen,
  compact = false,
  reducedMotion,
  initialPhase = 'blurred',
  freeze = false
}) {
  const displayItems = useMemo(() => resolveReminderItems(items), [items]);
  const [reminder, setReminder] = useState({ index: 0, phase: initialPhase, complete: false });
  const [direction, setDirection] = useState(0);
  const pointerStart = useRef(null);
  const swiped = useRef(false);

  useEffect(() => {
    if (freeze || reminder.phase !== 'shattering') return undefined;
    const timer = window.setTimeout(() => {
      setReminder((current) => {
        const next = advanceReminder(current, displayItems.length);
        if (next.complete) queueMicrotask(() => onComplete?.());
        return next;
      });
    }, reducedMotion ? 120 : 360);
    return () => window.clearTimeout(timer);
  }, [displayItems.length, freeze, onComplete, reducedMotion, reminder.phase]);

  const resetAndReopen = () => {
    setDirection(0);
    setReminder({ index: 0, phase: 'blurred', complete: false });
    onReopen?.();
  };
  if (compact) {
    return (
      <div className="af-reminder-overlay is-compact" data-testid="reminder-sequence">
        <div className="af-bubble-float is-compact">
          <m.button
            type="button"
            className="af-reminder-bubble is-compact"
            whileTap={{ scale: 0.96 }}
            onClick={resetAndReopen}
            aria-label="重新打开功能介绍"
          >
            <m.span
              className="af-bubble-visual"
              animate={reducedMotion ? { y: 0, scale: 1 } : { y: [0, -4, 0, 4, 0], scale: [1, 1.02, 1, 0.98, 1] }}
              transition={reducedMotion ? { duration: 0.12 } : { duration: 4.2, repeat: Infinity, ease: 'easeInOut' }}
            >
              <m.span
                className="af-bubble-halo"
                aria-hidden="true"
                animate={reducedMotion ? { opacity: 0.72 } : { opacity: [0.62, 0.9, 0.62] }}
                transition={reducedMotion ? { duration: 0.12 } : { duration: 4.2, repeat: Infinity, ease: 'easeInOut' }}
              />
              <Icon name="brain" size={20} />
            </m.span>
          </m.button>
        </div>
      </div>
    );
  }

  if (reminder.complete || !displayItems[reminder.index]) return null;
  const item = displayItems[reminder.index];
  const handleAdvance = () => {
    if (swiped.current) {
      swiped.current = false;
      return;
    }
    if (reminder.phase === 'shattering') return;
    setReminder((current) => advanceReminder(current, displayItems.length));
  };
  const selectIndex = (index) => {
    if (index < 0 || index >= displayItems.length || index === reminder.index) return;
    setDirection(index > reminder.index ? 1 : -1);
    setReminder({ index, phase: 'clear', complete: false });
  };
  const handleDragEnd = (_event, info) => {
    if (Math.abs(info.offset.x) < 36 && Math.abs(info.velocity.x) < 280) return;
    const delta = info.offset.x < 0 ? 1 : -1;
    selectIndex(Math.max(0, Math.min(displayItems.length - 1, reminder.index + delta)));
  };
  const handlePointerDown = (event) => {
    pointerStart.current = event.clientX;
  };
  const handlePointerUp = (event) => {
    if (!Number.isFinite(pointerStart.current)) return;
    const offset = event.clientX - pointerStart.current;
    pointerStart.current = null;
    if (Math.abs(offset) < 36) return;
    swiped.current = true;
    const delta = offset < 0 ? 1 : -1;
    selectIndex(Math.max(0, Math.min(displayItems.length - 1, reminder.index + delta)));
  };
  const handleSkip = () => {
    setReminder((current) => ({ ...current, phase: 'complete', complete: true }));
    queueMicrotask(() => onSkip?.());
  };
  const shattering = reminder.phase === 'shattering';
  const contentTarget = { opacity: reminder.phase === 'blurred' ? 0.68 : 1 };

  return (
    <m.div className={`af-reminder-overlay is-${reminder.phase} ${freeze ? 'is-frozen' : ''}`} data-testid="reminder-sequence" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: reducedMotion ? 0.12 : 0.18 }}>
      <m.button type="button" className="af-reminder-skip" whileTap={{ scale: 0.94 }} onClick={handleSkip}>跳过</m.button>
      <AnimatePresence mode="wait" initial={!freeze}>
        <m.div
          key={`${reminder.index}-${item.title}`}
          className="af-bubble-float"
          initial={{ opacity: 0, x: reducedMotion ? 0 : direction * 18 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: reducedMotion ? 0 : direction * -18 }}
          transition={{ duration: reducedMotion ? 0.12 : 0.24 }}
        >
          <m.button
            type="button"
            className="af-reminder-bubble"
            whileTap={shattering ? undefined : { scale: 0.96 }}
            onClick={handleAdvance}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            aria-label={`${item.time || ''} ${item.title}，${reminder.phase === 'blurred' ? '点击查看' : '再次点击完成'}`}
          >
            <m.span
              className="af-bubble-enter"
              initial={freeze ? false : reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.42, y: 30 }}
              animate={shattering
                ? { opacity: freeze ? 0.72 : 0, scale: reducedMotion ? 1 : 0.92, y: 0 }
                : { opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: shattering ? (reducedMotion ? 0.12 : 0.36) : (reducedMotion ? 0.14 : 0.65), ease: [0.16, 0.8, 0.24, 1] }}
              drag={displayItems.length > 1 ? 'x' : false}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.16}
              onDragEnd={handleDragEnd}
            >
              <m.span
                className="af-bubble-visual"
                animate={reducedMotion || shattering ? { y: 0, scale: 1 } : { y: [0, -6, 0, 5, 0], scale: [1, 1.02, 1, 0.98, 1] }}
                transition={reducedMotion || shattering ? { duration: 0.12 } : { duration: 4.2, delay: 0.65, repeat: Infinity, ease: 'easeInOut' }}
              >
                <m.span
                  className="af-bubble-halo"
                  aria-hidden="true"
                  animate={reducedMotion ? { opacity: 0.72 } : { opacity: [0.62, 0.92, 0.62] }}
                  transition={reducedMotion ? { duration: 0.12 } : { duration: 4.2, repeat: Infinity, ease: 'easeInOut' }}
                />
                <m.span className="af-bubble-content" animate={contentTarget} transition={{ duration: reducedMotion ? 0.12 : 0.2 }}>
                  <Icon name={item.icon || 'calendar-event'} size={22} />
                  {item.time ? <time>{item.time}</time> : null}
                  <strong>{item.title}</strong>
                  <small>{item.note}</small>
                  <span className="af-bubble-hint">{reminder.phase === 'blurred' ? '轻触看清' : '再次轻触完成'}</span>
                </m.span>
              </m.span>
            </m.span>
          </m.button>
        </m.div>
      </AnimatePresence>
      <div className="af-reminder-progress" aria-label={`第 ${reminder.index + 1} 项，共 ${displayItems.length} 项`}>
        {displayItems.map((entry, index) => (
          <button
            type="button"
            key={entry.id || entry.title || index}
            onClick={() => selectIndex(index)}
            aria-label={`查看第 ${index + 1} 项`}
          >
            <span className={index === reminder.index ? 'is-current' : ''} />
          </button>
        ))}
      </div>
    </m.div>
  );
}
