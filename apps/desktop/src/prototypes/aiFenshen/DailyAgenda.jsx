import { useState } from 'react';
import Icon from './Icon.jsx';
import { formatTaskTime } from './homeTasksState.js';

function statusLabel(status) {
  if (status === 'completed') return '已完成';
  if (status === 'cancelled') return '已取消';
  return '待完成';
}

function AgendaGroup({ title, items, expanded, expandedTaskId, busyTaskId, onExpandTask, onTaskToggle }) {
  const visibleItems = expanded ? items : items.slice(0, 2);
  return (
    <section className="af-agenda-group">
      <div className="af-agenda-heading">
        <span className="af-agenda-dot" aria-hidden="true" />
        <h2>{title}</h2>
        <span>{items.length} 项</span>
      </div>
      {visibleItems.length ? (
        <ul>
          {visibleItems.map((item) => {
            const itemExpanded = expandedTaskId === item.id;
            const actionable = item.status !== 'cancelled';
            return (
              <li key={item.id} className={`af-agenda-item is-${item.status || 'pending'}`}>
                <button
                  type="button"
                  className="af-agenda-item-main"
                  onClick={() => onExpandTask(itemExpanded ? null : item.id)}
                  aria-expanded={itemExpanded}
                >
                  <time>{formatTaskTime(item)}</time>
                  <span className="af-agenda-item-title">{item.title}</span>
                  <small>{statusLabel(item.status)}</small>
                </button>
                {itemExpanded ? (
                  <div className="af-agenda-item-detail">
                    {item.description ? <p>{item.description}</p> : null}
                    {actionable ? (
                      <button
                        type="button"
                        disabled={busyTaskId === item.id}
                        onClick={() => onTaskToggle(item)}
                      >
                        {busyTaskId === item.id
                          ? '正在更新…'
                          : item.status === 'completed' ? '恢复未完成' : '标记完成'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : <p className="af-agenda-empty">暂无事项</p>}
    </section>
  );
}

export default function DailyAgenda({
  tasksState,
  showReminderHint = false,
  onRetry,
  onTaskToggle,
  busyTaskId = '',
  actionError = ''
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const today = tasksState?.today || [];
  const tomorrow = tasksState?.tomorrow || [];
  const total = today.length + tomorrow.length;

  return (
    <section className="af-daily-agenda" data-testid="daily-agenda" aria-label="今日和明日事项">
      <div className="af-agenda-title">
        <Icon name="calendar-event" size={18} />
        <span>接下来</span>
      </div>
      {tasksState?.status === 'loading' ? (
        <p className="af-agenda-state" role="status">正在加载事项…</p>
      ) : null}
      {tasksState?.status === 'error' ? (
        <div className="af-agenda-state is-error" role="alert">
          <strong>事项加载失败</strong>
          <span>{tasksState.error}</span>
          <button type="button" onClick={onRetry}>重试</button>
        </div>
      ) : null}
      {tasksState?.status === 'success' ? (
        <>
          <AgendaGroup
            title="今日事项"
            items={today}
            expanded={expanded}
            expandedTaskId={expandedTaskId}
            busyTaskId={busyTaskId}
            onExpandTask={setExpandedTaskId}
            onTaskToggle={onTaskToggle}
          />
          <AgendaGroup
            title="明日事项"
            items={tomorrow}
            expanded={expanded}
            expandedTaskId={expandedTaskId}
            busyTaskId={busyTaskId}
            onExpandTask={setExpandedTaskId}
            onTaskToggle={onTaskToggle}
          />
          {showReminderHint ? <p className="af-agenda-reminder-hint">点击查看提醒与功能</p> : null}
          {total > 2 ? (
            <button className="af-agenda-more" type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
              {expanded ? '收起' : '显示更多'}
              <Icon name="chevron-down" size={16} className={expanded ? 'is-rotated' : ''} />
            </button>
          ) : null}
          {actionError ? <p className="af-agenda-action-error" role="alert">{actionError}</p> : null}
        </>
      ) : null}
    </section>
  );
}
