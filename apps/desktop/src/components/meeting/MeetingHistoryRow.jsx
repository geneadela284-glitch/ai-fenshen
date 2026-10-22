import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

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
  onRename,
  onDelete
}) {
  const [offset, setOffset] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [originalTitle, setOriginalTitle] = useState('');
  const [renameError, setRenameError] = useState('');
  const [savingName, setSavingName] = useState(false);
  const renameLock = useRef(false);
  const optionsButton = useRef(null);
  const optionsMenu = useRef(null);
  const renameDialog = useRef(null);
  useEffect(() => {
    if (renaming && !renameDialog.current?.open) renameDialog.current?.showModal();
  }, [renaming]);
  const closeRename = () => {
    if (renameLock.current) return;
    setRenaming(false);
    optionsButton.current?.focus();
  };
  const showOptions = () => {
    const rect = optionsButton.current.getBoundingClientRect();
    const menu = optionsMenu.current;
    menu.style.left = `${Math.max(12, Math.min(rect.right - 156, window.innerWidth - 168))}px`;
    menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 68)}px`;
    menu.togglePopover();
  };
  const canRename = typeof onRename === 'function' && ['draft', 'ready', 'stopped'].includes(meetingView.recordingState);
  const beginRename = () => {
    optionsMenu.current?.hidePopover();
    setOffset(0);
    setDraftTitle(meetingView.title);
    setOriginalTitle(meetingView.title);
    setRenameError('');
    setRenaming(true);
  };
  const saveName = async (event) => {
    event.preventDefault();
    if (renameLock.current) return;
    const title = draftTitle.trim();
    if (!title || [...title].length > 80) { setRenameError('请输入1至80个字的会议名称。'); return; }
    if (title === originalTitle) { setRenaming(false); return; }
    renameLock.current = true;
    setSavingName(true);
    setRenameError('');
    try {
      await onRename(meetingView.meetingId, title, originalTitle);
      setRenaming(false);
    } catch (error) {
      setRenameError(error?.code === 'MEETING_RENAME_CONFLICT'
        ? '名称未保存：这条会议已发生变化，请取消后重新打开改名。'
        : error?.code === 'MEETING_RENAME_BUSY'
          ? '名称未保存：请等待录音和保存结束后再试。'
          : '名称未保存，原名称仍保留。请重试。');
    } finally { renameLock.current = false; setSavingName(false); }
  };
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
      {canRename && !revealed ? <button ref={optionsButton} type="button" className="meeting-v3-options" onClick={showOptions} disabled={busy || savingName} aria-label="会议选项" aria-haspopup="menu">⋯</button> : null}
      {canRename && createPortal(<div ref={optionsMenu} popover="auto" className="meeting-v3-menu" role="menu"><button type="button" role="menuitem" onClick={beginRename}>重命名</button></div>, document.body)}
      {renaming && createPortal(<dialog ref={renameDialog} className="meeting-v3-rename-dialog" aria-label="重命名会议" onCancel={(event) => { event.preventDefault(); closeRename(); }} onClick={(event) => { const rect = renameDialog.current.getBoundingClientRect(); if (event.target === renameDialog.current && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeRename(); }}>
        <form onSubmit={saveName}>
          <h2>重命名会议</h2>
          <label htmlFor={`meeting-title-${meetingId}`}>会议名称</label>
          <input id={`meeting-title-${meetingId}`} autoFocus value={draftTitle} onChange={(event) => setDraftTitle(event.target.value)} aria-label="新的会议名称" disabled={savingName} maxLength={160} />
          {renameError ? <p role="alert">{renameError}</p> : null}
          <div className="meeting-v3-rename-actions"><button type="button" disabled={savingName} onClick={closeRename}>取消</button><button type="submit" disabled={savingName || !draftTitle.trim()}>{savingName ? '正在保存…' : '保存'}</button></div>
        </form>
      </dialog>, document.body)}
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
