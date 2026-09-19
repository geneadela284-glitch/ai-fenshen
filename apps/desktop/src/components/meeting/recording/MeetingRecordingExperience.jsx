import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import './MeetingRecordingExperience.css';
import { FuturePunkOrb } from '../FuturePunkPrimitives.jsx';

const SAFE_ACTION_ERROR = '操作未能完成，请稍后重试。';
const CLIENT_ASSET_VERSION_MISMATCH = 'CLIENT_ASSET_VERSION_MISMATCH';
const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');
const modalCoordinators = new WeakMap();

export function reloadCurrentClientAssets({
  locationImpl = globalThis.location,
  now = () => Date.now()
} = {}) {
  if (typeof locationImpl?.replace !== 'function') return false;
  const href = String(locationImpl?.href || '');
  if (!href) return false;
  let nextUrl;
  try {
    nextUrl = new URL(href);
    const timestamp = Number(now());
    nextUrl.searchParams.set('__meeting_asset_refresh', String(Number.isFinite(timestamp) ? timestamp : Date.now()));
    locationImpl.replace(nextUrl.toString());
    return true;
  } catch {
    return false;
  }
}

function focusableElements(dialog) {
  return Array.from(dialog?.querySelectorAll?.(FOCUSABLE_SELECTOR) || [])
    .filter((element) => element?.disabled !== true && element?.getAttribute?.('aria-hidden') !== 'true');
}

export function focusInitialDialog(dialog) {
  const first = focusableElements(dialog)[0];
  (first || dialog)?.focus?.();
}

export function restoreDialogFocus(element) {
  if (element?.isConnected !== false) element?.focus?.();
}

export function containDialogFocus(event, dialog) {
  if (dialog && !dialog.contains?.(event?.target)) dialog.focus?.();
}

export function trapDialogTabKey(event, dialog, documentImpl = globalThis.document) {
  if (event?.key !== 'Tab' || !dialog) return false;
  const controls = focusableElements(dialog);
  if (controls.length === 0) {
    event.preventDefault?.();
    dialog.focus?.();
    return true;
  }
  if (controls.length === 1) {
    event.preventDefault?.();
    controls[0].focus?.();
    return true;
  }
  const active = documentImpl?.activeElement;
  const first = controls[0];
  const last = controls.at(-1);
  if (event.shiftKey && active === first) {
    event.preventDefault?.();
    last.focus?.();
    return true;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault?.();
    first.focus?.();
    return true;
  }
  return false;
}

export function closeFromDialogEscape(event, isBusy, onClose) {
  if (event?.key !== 'Escape' || isBusy) return false;
  event.preventDefault?.();
  event.stopPropagation?.();
  onClose?.();
  return true;
}

export function closeFromDialogBackdrop(event, isBusy, onClose) {
  if (isBusy || event?.target !== event?.currentTarget) return false;
  onClose?.();
  return true;
}

function registerRecordingDialogModal(documentImpl, dialogRef, priorFocus) {
  let coordinator = modalCoordinators.get(documentImpl);
  if (!coordinator) {
    coordinator = {
      entries: [],
      originalOverflow: documentImpl.body.style.overflow,
      onFocusIn: null
    };
    coordinator.onFocusIn = (event) => {
      const topmost = coordinator.entries.at(-1);
      containDialogFocus(event, topmost?.dialogRef?.current);
    };
    modalCoordinators.set(documentImpl, coordinator);
    documentImpl.body.style.overflow = 'hidden';
    documentImpl.addEventListener('focusin', coordinator.onFocusIn);
  }

  const entry = { dialogRef, priorFocus };
  coordinator.entries.push(entry);
  dialogRef.current?.focus?.();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const index = coordinator.entries.indexOf(entry);
    const wasTopmost = index === coordinator.entries.length - 1;
    if (index >= 0) coordinator.entries.splice(index, 1);

    if (coordinator.entries.length === 0) {
      documentImpl.removeEventListener('focusin', coordinator.onFocusIn);
      documentImpl.body.style.overflow = coordinator.originalOverflow;
      modalCoordinators.delete(documentImpl);
      restoreDialogFocus(priorFocus);
    } else if (wasTopmost) {
      focusInitialDialog(coordinator.entries.at(-1).dialogRef.current);
    }
  };
}

export function subscribeToRecordingExperience(experience, onSnapshot) {
  let active = true;
  let cleaned = false;
  const unsubscribe = experience.subscribe((snapshot) => {
    if (active) onSnapshot(snapshot);
  });
  return () => {
    if (cleaned) return;
    cleaned = true;
    active = false;
    unsubscribe?.();
  };
}

export function createRecordingActionController(experience, {
  onPendingChange = () => {},
  onSafeError = () => {},
  onErrorCode = () => {},
  onEndComplete = () => {}
} = {}) {
  let active = true;
  let inFlight = null;
  const capability = {
    start: 'canStart',
    pause: 'canPause',
    resume: 'canResume',
    end: 'canEnd'
  };

  function canRun(kind) {
    if (!active || inFlight || !capability[kind]) return false;
    try {
      const snapshot = experience.getSnapshot();
      return snapshot?.isBusy !== true && snapshot?.[capability[kind]] === true;
    } catch {
      return false;
    }
  }

  function run(kind) {
    if (!canRun(kind)) return inFlight || Promise.resolve(false);

    let settle;
    const pending = new Promise((resolve) => { settle = resolve; });
    inFlight = pending;
    if (active) onPendingChange(true);

    let operation;
    try {
      operation = experience[kind]();
    } catch {
      operation = Promise.reject(new Error('recording action failed'));
    }

    void (async () => {
      let succeeded = false;
      try {
        const result = await operation;
        succeeded = true;
        const resultMeeting = result?.meeting || result?.active?.meeting;
        const finalizationPending = resultMeeting?.recordingState === 'finalization_pending'
          || result?.finalizationPending === true;
        if (active && kind === 'end' && !finalizationPending) onEndComplete();
      } catch (error) {
        if (active) {
          onErrorCode(error?.code || '');
          onSafeError(SAFE_ACTION_ERROR);
        }
      } finally {
        inFlight = null;
        if (active) onPendingChange(false);
        settle(succeeded);
      }
    })();
    return pending;
  }

  return Object.freeze({
    activate() {
      active = true;
    },
    run,
    requestEnd() {
      return canRun('end');
    },
    confirmEnd() {
      return run('end');
    },
    dispose() {
      active = false;
    }
  });
}

function measuredHeight(value) {
  const normalized = Math.min(1, Math.max(0, Number(value) || 0));
  return `${Math.round(20 + (normalized * 68))}%`;
}

function EndRecordingDialog({ dialogRef, isBusy, onCancel, onConfirm, safeError }) {
  const titleId = useId();

  useEffect(() => {
    focusInitialDialog(dialogRef.current);
  }, []);

  useEffect(() => {
    if (isBusy) dialogRef.current?.focus?.();
  }, [isBusy]);

  return createPortal(
    <div
      className="meeting-stage3c-recording-dialog-backdrop"
      onMouseDown={(event) => closeFromDialogBackdrop(event, isBusy, onCancel)}
    >
      <section
        ref={dialogRef}
        className="meeting-stage3c-recording-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          trapDialogTabKey(event, dialogRef.current);
          closeFromDialogEscape(event, isBusy, onCancel);
        }}
        onFocus={(event) => containDialogFocus(event, dialogRef.current)}
      >
        <p className="meeting-stage3c-recording-dialog-eyebrow">保存录音</p>
        <h2 id={titleId}>结束本次录音？</h2>
        <p>确认后将结束录音，最后一段内容也会安全保存。</p>
        {safeError && <p className="meeting-stage3c-recording-error" role="alert">{safeError}</p>}
        <div className="meeting-stage3c-recording-dialog-actions">
          <button
            className="meeting-stage3c-recording-button meeting-stage3c-recording-button--secondary"
            type="button"
            disabled={isBusy}
            onClick={onCancel}
          >
            继续录音
          </button>
          <button
            className="meeting-stage3c-recording-button meeting-stage3c-recording-confirm"
            type="button"
            disabled={isBusy}
            onClick={onConfirm}
          >
            {isBusy ? '正在安全保存…' : '结束并安全保存'}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}

export function MeetingRecordingExperience({ experience }) {
  const [snapshot, setSnapshot] = useState(() => experience.getSnapshot());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [safeError, setSafeError] = useState('');
  const [assetMismatch, setAssetMismatch] = useState(false);
  const [isEndDialogOpen, setIsEndDialogOpen] = useState(false);
  const mountedRef = useRef(true);
  const priorFocusRef = useRef(null);
  const endDialogRef = useRef(null);

  const actionController = useMemo(() => createRecordingActionController(experience, {
    onPendingChange(value) {
      if (!mountedRef.current) return;
      setIsSubmitting(value);
      if (value) {
        setSafeError('');
        setAssetMismatch(false);
      }
    },
    onSafeError(message) {
      if (mountedRef.current) setSafeError(message);
    },
    onErrorCode(code) {
      if (mountedRef.current) setAssetMismatch(code === CLIENT_ASSET_VERSION_MISMATCH);
    },
    onEndComplete() {
      if (mountedRef.current) setIsEndDialogOpen(false);
    }
  }), [experience]);

  useEffect(() => {
    mountedRef.current = true;
    actionController.activate();
    setSnapshot(experience.getSnapshot());
    const unsubscribe = subscribeToRecordingExperience(experience, setSnapshot);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      actionController.dispose();
    };
  }, [actionController, experience]);

  useEffect(() => {
    if (!isEndDialogOpen || typeof document === 'undefined') return undefined;
    const releaseModal = registerRecordingDialogModal(document, endDialogRef, priorFocusRef.current);
    return () => {
      releaseModal();
      priorFocusRef.current = null;
    };
  }, [isEndDialogOpen]);

  const busy = snapshot.isBusy === true || isSubmitting;
  const measuredBars = snapshot.isRecording === true
    && snapshot.microphone?.available === true
    && Array.isArray(snapshot.microphone?.bars)
    ? snapshot.microphone.bars
    : [];
  const signalText = snapshot.isRecording
    ? (measuredBars.length > 0 ? '音量反馈正常' : '录音仍在进行，音量反馈暂不可用')
    : '开始录音后将显示音量反馈';
  const visualState = snapshot.isRecording
    ? 'recording'
    : snapshot.isPaused || snapshot.status === '已暂停'
      ? 'paused'
      : snapshot.isInterrupted || snapshot.status === '已中断' || snapshot.status === '录音已中断'
        ? 'interrupted'
        : snapshot.isStopped || snapshot.status === '已结束' || snapshot.status === '录音已结束'
          ? 'completed'
          : 'idle';
  const visualTitle = visualState === 'recording'
    ? 'AI分身 Meeting'
    : visualState === 'paused'
      ? '录音已暂停'
      : visualState === 'interrupted'
        ? '录音已中断'
        : visualState === 'completed'
          ? '会议已保存'
          : 'AI分身 Meeting';
  const visualSubtitle = visualState === 'recording'
    ? 'AI 正在陪你记录这场会议'
    : visualState === 'paused'
      ? '确认后可以从当前位置继续记录'
      : visualState === 'interrupted'
        ? '已保存的内容仍在这里，请明确选择下一步'
        : visualState === 'completed'
          ? '这场对话已安全留存，可继续查看会议内容'
          : '准备好后，AI 会陪你记录这场会议';

  function runAction(kind) {
    void actionController.run(kind);
  }

  function openEndDialog() {
    if (!actionController.requestEnd()) return;
    priorFocusRef.current = typeof document === 'undefined' ? null : document.activeElement;
    setSafeError('');
    setIsEndDialogOpen(true);
  }

  function closeEndDialog() {
    if (!busy) setIsEndDialogOpen(false);
  }

  return (
    <section
      className="meeting-stage3c-recording-root"
      data-recording={snapshot.isRecording === true ? 'true' : 'false'}
      data-recording-state={visualState}
      aria-label="会议录音"
    >
      <div className="meeting-stage3c-recording-card meeting-stage3c-recording-card--future">
        <div className="meeting-stage3c-recording-hero">
          <div className="meeting-stage3c-recording-hero-copy">
            <p className="meeting-stage3c-recording-eyebrow">AI分身 · MEETING</p>
            <h2>{visualTitle}</h2>
            <p>{visualSubtitle}</p>
          </div>
          <FuturePunkOrb size="large" state={visualState} className="meeting-stage3c-recording-orb" />
        </div>

        <header className="meeting-stage3c-recording-header">
          <div className="meeting-stage3c-recording-status-copy" aria-live="polite" aria-atomic="true">
            <div className={`meeting-stage3c-recording-status${snapshot.isRecording ? ' meeting-stage3c-recording-status--recording' : ''}`}>
              {snapshot.isRecording && <span className="meeting-stage3c-recording-dot" aria-hidden="true" />}
              <strong>{snapshot.status}</strong>
            </div>
            <p>{snapshot.message}</p>
          </div>
          <time className="meeting-stage3c-recording-timer" aria-label={`录音时长 ${snapshot.durationText}`}>
            {snapshot.durationText}
          </time>
        </header>

        <div className="meeting-stage3c-recording-signal" role="group" aria-label="麦克风音量反馈">
          {measuredBars.length > 0 && (
            <div className="meeting-stage3c-recording-waveform" aria-hidden="true">
              {measuredBars.map((value, index) => (
                <span
                  className="meeting-stage3c-recording-waveform-bar"
                  style={{ '--meeting-stage3c-measured-height': measuredHeight(value) }}
                  key={index}
                />
              ))}
            </div>
          )}
          <p className="meeting-stage3c-recording-signal-text">{signalText}</p>
        </div>

        {safeError && !isEndDialogOpen && <p className="meeting-stage3c-recording-error" role="alert">{safeError}</p>}
        {assetMismatch && !isEndDialogOpen && (
          <div className="meeting-stage3c-recording-error meeting-stage3c-recording-error--asset" data-testid="meeting-asset-version-mismatch" role="alert">
            <p>版本已更新，请重新加载后再开始录音。</p>
            <button
              className="meeting-stage3c-recording-button meeting-stage3c-recording-button--secondary"
              type="button"
              onClick={() => reloadCurrentClientAssets()}
            >
              版本已更新，点击重新加载
            </button>
          </div>
        )}

          <div className="meeting-stage3c-recording-controls" role="group" aria-label="录音操作">
            {snapshot.canStart && (
              <button className="meeting-stage3c-recording-button meeting-stage3c-recording-button--primary meeting-stage3c-recording-button--start" type="button" disabled={busy} onClick={() => runAction('start')}>
                开始录音
              </button>
            )}
            {snapshot.canPause && (
              <button className="meeting-stage3c-recording-button meeting-stage3c-recording-button--secondary meeting-stage3c-recording-button--pause meeting-stage3c-recording-button--icon" type="button" disabled={busy} onClick={() => runAction('pause')}>
                暂停录音
              </button>
            )}
            {snapshot.canResume && (
              <button className="meeting-stage3c-recording-button meeting-stage3c-recording-button--primary meeting-stage3c-recording-button--pause meeting-stage3c-recording-button--icon" type="button" disabled={busy} onClick={() => runAction('resume')}>
                继续录音
              </button>
            )}
            {snapshot.canEnd && (
              <button className="meeting-stage3c-recording-button meeting-stage3c-recording-button--quiet meeting-stage3c-recording-button--end meeting-stage3c-recording-button--icon" type="button" disabled={busy} onClick={openEndDialog}>
                结束并保存
              </button>
            )}
        </div>

        <p className="meeting-stage3c-recording-save-line" role="status">
          <span aria-hidden="true">✓</span> {snapshot.isRecording ? '正在安全保存 · 已完成的内容会持续留在本地' : snapshot.message}
        </p>
      </div>

      {isEndDialogOpen && typeof document !== 'undefined' && (
        <EndRecordingDialog
          dialogRef={endDialogRef}
          isBusy={busy}
          onCancel={closeEndDialog}
          onConfirm={() => { void actionController.confirmEnd(); }}
          safeError={safeError}
        />
      )}
    </section>
  );
}
