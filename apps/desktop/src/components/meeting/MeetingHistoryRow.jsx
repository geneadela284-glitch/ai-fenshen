import { useRef, useState } from 'react';

import {
  MEETING_ROW_DELETE_REVEAL_OFFSET,
  resolveMeetingRowSwipe
} from './meetingRowSwipe.js';

export function MeetingHistoryRow({
  meetingView,
  listStatus,
  isActive = false,
  busy = false,
  formatDate,
  formatDuration,
  analysisLabel,
  onOpen,
  onDelete
}) {
  const [offset, setOffset] = useState(0);
  const gesture = useRef(null);
  const suppressClick = useRef(false);
  const meetingId = meetingView.meetingId;
  const revealed = offset === MEETING_ROW_DELETE_REVEAL_OFFSET;

  const handleTouchStart = (event) => {
    const touch = event.changedTouches?.[0];
    if (!touch) return;
    suppressClick.current = false;
    gesture.current = { startX: touch.clientX, startY: touch.clientY };
  };

  const handleTouchEnd = (event) => {
    const touch = event.changedTouches?.[0];
    const start = gesture.current;
    gesture.current = null;
    if (!touch || !start) return;
    const nextOffset = resolveMeetingRowSwipe({
      ...start,
      endX: touch.clientX,
      endY: touch.clientY
    });
    suppressClick.current = nextOffset !== 0;
    if (nextOffset !== 0) event.preventDefault?.();
    setOffset(nextOffset);
  };

  const handleTouchCancel = () => {
    gesture.current = null;
    suppressClick.current = false;
  };

  const handleOpen = (event) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault?.();
      return;
    }
    if (revealed) {
      setOffset(0);
      return;
    }
    onOpen(meetingId);
  };

  const handleDelete = () => {
    setOffset(0);
    onDelete(meetingId);
  };

  return (
    <div className={`meeting-v1-meeting-row-swipe${revealed ? ' meeting-v1-meeting-row-swipe--revealed' : ''}`}>
      <button
        type="button"
        className={`meeting-future-punk__meeting-item meeting-v1-meeting-row meeting-v1-meeting-row--${listStatus.tone} ${isActive ? 'meeting-v1-meeting-row--active' : ''}`}
        onClick={handleOpen}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        disabled={busy}
        aria-current={isActive ? 'true' : undefined}
        style={{ '--meeting-row-swipe-offset': `${offset}px` }}
      >
        <span className="meeting-v1-meeting-row__dot" aria-hidden="true" />
        <span className="meeting-v1-meeting-row__body">
          <span className="meeting-v1-meeting-row__title">{meetingView.title}</span>
          <span className="meeting-v1-meeting-row__meta">◷ {formatDate(meetingView.createdAt)} · {formatDuration(meetingView.committedDurationMs)}</span>
          <span className="meeting-v1-meeting-row__analysis">⌁ {analysisLabel}</span>
        </span>
        <span className={`meeting-future-punk__state-pill meeting-v1-state-pill meeting-v1-state-pill--${listStatus.tone}`}>{listStatus.label}</span>
        <span className="meeting-v1-meeting-row__technical sr-only">已提交 {meetingView.committedSegmentCount} 个加密分段</span>
      </button>
      <button
        type="button"
        className="meeting-v1-meeting-row-delete"
        onClick={handleDelete}
        disabled={busy}
        tabIndex={revealed ? 0 : -1}
        aria-hidden={!revealed}
        aria-label="删除会议记录"
      >删除</button>
    </div>
  );
}
