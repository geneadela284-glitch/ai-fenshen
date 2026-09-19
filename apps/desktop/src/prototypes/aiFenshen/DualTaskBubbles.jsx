import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from './Icon.jsx';
import {
  advanceTaskBubbleState,
  createTaskBubbleState,
  formatTaskTime,
  taskBubbleStorageKey,
  taskListSignature
} from './homeTasksState.js';

const TRANSITION_MS = 340;
const POP_MS = 380;

function readBubbleState(storageKey, signature) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) || 'null');
    if (stored?.signature === signature) {
      return {
        signature,
        currentIndex: Number.isInteger(stored.currentIndex) ? stored.currentIndex : 0,
        highlighted: stored.highlighted === true,
        poppedAt: stored.poppedAt || null
      };
    }
  } catch {
    // A browser storage failure must not hide current server Tasks.
  }
  return createTaskBubbleState(signature);
}

function writeBubbleState(storageKey, state) {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // The interaction remains usable for the current view when storage is unavailable.
  }
}

function TaskBubble({ type, label, dateKey, items, userId, reducedMotion }) {
  const pendingItems = useMemo(
    () => items.filter((task) => task?.status === 'pending'),
    [items]
  );
  const signature = useMemo(() => taskListSignature(pendingItems), [pendingItems]);
  const storageKey = useMemo(() => taskBubbleStorageKey({
    userId,
    dateKey,
    bubbleType: type
  }), [dateKey, type, userId]);
  const hasDiary = pendingItems.some(item=>item.diaryId || item.healthId);
  const restoreBubble = () => hasDiary ? createTaskBubbleState(signature) : readBubbleState(storageKey, signature);
  const [bubbleState, setBubbleState] = useState(restoreBubble);
  const [transitioning, setTransitioning] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setTransitioning(false);
    setBubbleState(restoreBubble());
  }, [signature, storageKey]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  if (!pendingItems.length || bubbleState.poppedAt) return null;

  const currentIndex = Math.min(bubbleState.currentIndex, pendingItems.length - 1);
  const currentTask = pendingItems[currentIndex];
  const shownTime = formatTaskTime(currentTask);
  const time = shownTime === '--:--' ? '待安排' : shownTime;
  const highlighted = bubbleState.highlighted;
  const poppedAt = bubbleState.poppedAt;
  const typeClass = type === 'today' ? 'is-today' : 'is-tomorrow';
  const willPop = transitioning && highlighted && currentIndex === pendingItems.length - 1;

  const handleClick = () => {
    if (transitioning) return;
    const nextState = advanceTaskBubbleState(bubbleState, pendingItems.length);
    if (!bubbleState.highlighted) {
      setBubbleState(nextState);
      writeBubbleState(storageKey, nextState);
      return;
    }
    setTransitioning(true);
    const delay = reducedMotion ? 140 : nextState.poppedAt ? POP_MS : TRANSITION_MS;
    timerRef.current = window.setTimeout(() => {
      setBubbleState(nextState);
      writeBubbleState(storageKey, nextState);
      setTransitioning(false);
    }, delay);
  };

  return (
    <section
      className={`af-task-bubble ${typeClass} ${highlighted ? 'is-highlighted' : ''} ${transitioning ? (willPop ? 'is-popping' : 'is-transitioning') : ''}`}
      data-testid={`${type}-task-bubble`}
      aria-label={`${label}提醒`}
    >
      <button
        type="button"
        className="af-task-bubble-card"
        onClick={handleClick}
        disabled={transitioning}
        aria-label={`${label}：${currentTask.title}，${time}，第${currentIndex + 1}项，共${pendingItems.length}项`}
      >
        <span className="af-task-bubble-highlight" aria-hidden="true" />
        <span className="af-task-bubble-heading">
          <strong>{label}</strong>
          <Icon name="calendar-event" size={19} />
        </span>
        <span className="af-task-bubble-divider" aria-hidden="true" />
        <span className="af-task-bubble-item">
          <time>{time}</time>
          <b>{currentTask.title}</b>
        </span>
        <span className="af-task-bubble-status">{currentTask.overdue ? '逾期待处理' : '待完成'} · {currentIndex + 1}/{pendingItems.length}</span>
        <span className="af-task-bubble-dots" aria-hidden="true">
          {pendingItems.slice(0, 5).map((task, index) => (
            <i key={task.id} className={index === currentIndex ? 'is-current' : ''} />
          ))}
        </span>
      </button>
      {currentTask.healthId ? <a className="af-diary-bubble-link" href={`/#health=${currentTask.healthId}`}>查看健康提醒 →</a> : null}
      {currentTask.diaryId ? <a className="af-diary-bubble-link" href={`/#diary=${currentTask.diaryId}`}>查看原记录与提醒 →</a> : null}
    </section>
  );
}

export default function DualTaskBubbles({
  tasksState,
  userId,
  reducedMotion = false,
  onRetry
}) {
  if (tasksState?.status === 'loading') {
    return <p className="af-task-bubbles-state" role="status">正在加载事项…</p>;
  }
  if (tasksState?.status === 'error') {
    return (
      <div className="af-task-bubbles-state is-error" role="alert">
        <strong>事项加载失败</strong>
        <button type="button" onClick={onRetry}>重试</button>
      </div>
    );
  }
  if (tasksState?.status !== 'success') return null;

  return (
    <div className="af-task-bubbles" aria-label="今日和明日事项">
      <TaskBubble
        type="tomorrow"
        label="明日事项"
        dateKey={tasksState.range?.tomorrow || 'tomorrow'}
        items={tasksState.tomorrow || []}
        userId={userId}
        reducedMotion={reducedMotion}
      />
      <TaskBubble
        type="today"
        label="今日事项"
        dateKey={tasksState.range?.today || 'today'}
        items={tasksState.today || []}
        userId={userId}
        reducedMotion={reducedMotion}
      />
    </div>
  );
}
