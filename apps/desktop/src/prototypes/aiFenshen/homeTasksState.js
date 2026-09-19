export function createHomeTasksState() {
  return {
    status: 'loading',
    dataState: null,
    today: [],
    tomorrow: [],
    range: null,
    error: ''
  };
}

export function reduceHomeTasksState(state, action) {
  switch (action.type) {
    case 'loading':
      return createHomeTasksState();
    case 'loaded':
      return {
        status: 'success',
        dataState: action.payload?.state === 'empty' ? 'empty' : 'ready',
        today: Array.isArray(action.payload?.today) ? action.payload.today : [],
        tomorrow: Array.isArray(action.payload?.tomorrow) ? action.payload.tomorrow : [],
        range: action.payload?.range || null,
        error: ''
      };
    case 'failed':
      return {
        ...state,
        status: 'error',
        error: String(action.error || '事项暂时无法读取，请稍后重试。')
      };
    case 'task-updated': {
      const replace = (task) => task.id === action.task?.id ? action.task : task;
      return {
        ...state,
        today: state.today.map(replace),
        tomorrow: state.tomorrow.map(replace)
      };
    }
    default:
      return state;
  }
}

export function selectHomeBubbleMode(tasksState, {
  featureIntroVisible = true,
  featureIntroPresentation = featureIntroVisible ? 'expanded' : 'hidden'
} = {}) {
  if (tasksState?.status !== 'success') return 'none';
  if (featureIntroPresentation === 'manual') return 'feature-intro';
  if (tasksState.today.length || tasksState.tomorrow.length) return 'reminders';
  if (featureIntroPresentation === 'compact') return 'feature-intro-compact';
  return featureIntroPresentation === 'expanded' ? 'feature-intro' : 'none';
}

export function formatTaskTime(task) {
  if (task?.time) return task.time;
  const instant = new Date(task?.scheduledAt);
  if (!Number.isFinite(instant.getTime())) return '--:--';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: task.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(instant);
  } catch {
    return '--:--';
  }
}

function statusLabel(status) {
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  return '待完成';
}

export function toReminderItems({ today = [], tomorrow = [] } = {}) {
  return [
    ...today.map((task) => ({
      id: task.id,
      time: formatTaskTime(task),
      title: task.title,
      note: `今日 · ${statusLabel(task.status)}`,
      icon: 'calendar-event'
    })),
    ...tomorrow.map((task) => ({
      id: task.id,
      time: formatTaskTime(task),
      title: task.title,
      note: `明日 · ${statusLabel(task.status)}`,
      icon: 'calendar-event'
    }))
  ];
}

export function taskListSignature(tasks = []) {
  return tasks
    .filter((task) => task?.status === 'pending')
    .map((task) => `${task.id}:${task.updatedAt || task.createdAt || ''}:${task.status}`)
    .sort()
    .join('|');
}

export function taskBubbleStorageKey({ userId, dateKey, bubbleType }) {
  return `ai-fenshen:task-bubble:v1:${encodeURIComponent(String(userId || 'anonymous'))}:${dateKey}:${bubbleType}`;
}

export function createTaskBubbleState(signature = '') {
  return {
    signature,
    currentIndex: 0,
    highlighted: false,
    poppedAt: null
  };
}

export function advanceTaskBubbleState(state, total, now = new Date().toISOString()) {
  if (!state || state.poppedAt || total <= 0) return state;
  if (!state.highlighted) return { ...state, highlighted: true };
  if (state.currentIndex < total - 1) {
    return { ...state, currentIndex: state.currentIndex + 1, highlighted: true };
  }
  return { ...state, poppedAt: now };
}
