import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createMeetingSpeakerManagementUiFacade } from '../../lib/meetingSpeakerManagementUiFacade.js';
import { SpeakerRevisionHistory } from './SpeakerRevisionHistory.jsx';
import { SpeakerTimeline } from './SpeakerTimeline.jsx';
import { SpeakerManagementSheet } from './SpeakerManagementSheet.jsx';
import { SpeakerOperationPanel } from './SpeakerOperationPanel.jsx';
import './SpeakerManagement.css';

const LOAD_FAILURE_GUIDANCE = '说话人内容加载失败，已停止显示可能不一致的结果。请重新加载。';
const UNAVAILABLE_GUIDANCE = '说话人管理暂时不可用，请稍后再试。';

export function advanceAuthoritativeSnapshot(current, snapshot) {
  return {
    ...current,
    snapshot,
    snapshotEpoch: (Number(current?.snapshotEpoch) || 0) + 1
  };
}

export function acquireSubmitLock(lock) {
  if (lock.current) return false;
  lock.current = true;
  return true;
}

export function releaseSubmitLock(lock) {
  lock.current = false;
}

export function isCurrentAsyncGeneration(mountedRef, bindingVersion, expectedVersion) {
  return mountedRef.current && bindingVersion.current === expectedVersion;
}

export function SpeakerManagementPanel({ speakerCorrectionManager, meetingId, transcriptId }) {
  const facadeState = useMemo(() => {
    try {
      return { facade: createMeetingSpeakerManagementUiFacade({ manager: speakerCorrectionManager }) };
    } catch {
      return { facade: null };
    }
  }, [speakerCorrectionManager]);
  const facade = facadeState.facade;
  const bindingVersion = useRef(0);
  const mountedRef = useRef(false);
  const submitLock = useRef(false);
  const speakerTabRef = useRef(null);
  const historyTabRef = useRef(null);
  const tabIdPrefix = useId().replace(/:/g, '');
  const [phase, setPhase] = useState('loading');
  const [authoritativeState, setAuthoritativeState] = useState({ snapshot: null, snapshotEpoch: 0, isSubmitting: false });
  const [activeTab, setActiveTab] = useState('speakers');
  const [isOpen, setIsOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failureKind, setFailureKind] = useState(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const { snapshot, snapshotEpoch, isSubmitting } = authoritativeState;
  const speakerTabId = `meeting-speaker-tab-${tabIdPrefix}`;
  const historyTabId = `meeting-speaker-history-tab-${tabIdPrefix}`;
  const speakerPanelId = `meeting-speaker-panel-${tabIdPrefix}`;
  const historyPanelId = `meeting-speaker-history-panel-${tabIdPrefix}`;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      bindingVersion.current += 1;
      releaseSubmitLock(submitLock);
    };
  }, []);

  useEffect(() => {
    const version = ++bindingVersion.current;
    let active = true;
    releaseSubmitLock(submitLock);
    setAuthoritativeState((current) => advanceAuthoritativeSnapshot({ ...current, isSubmitting: false }, null));
    setFeedback('');
    setFailureKind(null);
    setActiveTab('speakers');
    setIsOpen(false);

    if (!facade) {
      setFailureKind('unavailable');
      setPhase('fail-closed');
      return () => { active = false; };
    }

    setPhase('loading');
    facade.load({ meetingId, transcriptId }).then((loadedSnapshot) => {
      if (!active || !isCurrentAsyncGeneration(mountedRef, bindingVersion, version)) return;
      setAuthoritativeState((current) => advanceAuthoritativeSnapshot(current, loadedSnapshot));
      setPhase('ready');
    }).catch(() => {
      if (!active || !isCurrentAsyncGeneration(mountedRef, bindingVersion, version)) return;
      setFailureKind('load');
      setPhase('fail-closed');
    });

    return () => {
      active = false;
    };
  }, [facade, meetingId, transcriptId, loadAttempt]);

  async function applyIntent(intent) {
    if (!mountedRef.current || phase !== 'ready' || !snapshot || !facade || !acquireSubmitLock(submitLock)) return;
    setAuthoritativeState((current) => ({ ...current, isSubmitting: true }));
    const version = bindingVersion.current;

    try {
      const result = await facade.apply(snapshot, intent);
      if (!isCurrentAsyncGeneration(mountedRef, bindingVersion, version)) return;
      if (result?.error) {
        if (result.error.requiresRefresh) {
          const refreshedSnapshot = await facade.load({ meetingId, transcriptId });
          if (!isCurrentAsyncGeneration(mountedRef, bindingVersion, version)) return;
          setAuthoritativeState((current) => advanceAuthoritativeSnapshot(current, refreshedSnapshot));
        }
        setFeedback(result.error.message || '当前修改未能完成，请稍后重试。');
      } else {
        setAuthoritativeState((current) => advanceAuthoritativeSnapshot(current, result));
        setFeedback('说话人修改已保存。');
      }
    } catch {
      if (!isCurrentAsyncGeneration(mountedRef, bindingVersion, version)) return;
      setFailureKind('integrity');
      setPhase('fail-closed');
      setFeedback('');
    } finally {
      if (isCurrentAsyncGeneration(mountedRef, bindingVersion, version)) {
        releaseSubmitLock(submitLock);
        setAuthoritativeState((current) => ({ ...current, isSubmitting: false }));
      }
    }
  }

  function handleTabKeyDown(event) {
    if (isSubmitting || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    const nextTab = activeTab === 'speakers' ? 'history' : 'speakers';
    setActiveTab(nextTab);
    if (nextTab === 'speakers') speakerTabRef.current?.focus();
    else historyTabRef.current?.focus();
  }

  const managementDisabled = phase !== 'ready' || !snapshot;

  return (
    <section className="meeting-speaker-management" aria-busy={phase === 'loading' || isSubmitting}>
      <button className="meeting-speaker-button meeting-speaker-open" type="button" onClick={() => setIsOpen(true)} disabled={managementDisabled}>
        管理说话人
      </button>

      {phase === 'loading' ? <p className="meeting-speaker-state" role="status">正在准备说话人内容…</p> : null}
      {phase === 'fail-closed' ? <p className="meeting-speaker-alert" role="alert">{failureKind === 'load' ? LOAD_FAILURE_GUIDANCE : UNAVAILABLE_GUIDANCE}</p> : null}
      {phase === 'fail-closed' && failureKind === 'load' && facade ? (
        <button className="meeting-speaker-button" type="button" onClick={() => setLoadAttempt((current) => current + 1)}>
          重新加载
        </button>
      ) : null}
      {feedback ? <p className="meeting-speaker-status" role="status">{feedback}</p> : null}

      <SpeakerManagementSheet open={isOpen && phase === 'ready'} onClose={() => setIsOpen(false)} busy={isSubmitting}>
        <div className="meeting-speaker-tabs" role="tablist" aria-label="说话人管理内容" onKeyDown={handleTabKeyDown}>
          <button className="meeting-speaker-tab" ref={speakerTabRef} id={speakerTabId} role="tab" type="button" aria-controls={speakerPanelId} aria-selected={activeTab === 'speakers'} tabIndex={activeTab === 'speakers' ? 0 : -1} onClick={() => setActiveTab('speakers')} disabled={isSubmitting}>说话人</button>
          <button className="meeting-speaker-tab" ref={historyTabRef} id={historyTabId} role="tab" type="button" aria-controls={historyPanelId} aria-selected={activeTab === 'history'} tabIndex={activeTab === 'history' ? 0 : -1} onClick={() => setActiveTab('history')} disabled={isSubmitting}>修改记录</button>
        </div>

        {activeTab === 'speakers' && snapshot ? (
          <div className="meeting-speaker-tab-content" id={speakerPanelId} role="tabpanel" aria-labelledby={speakerTabId}>
            <SpeakerOperationPanel key={snapshotEpoch} snapshot={snapshot} isSubmitting={isSubmitting} onSubmit={applyIntent} />
            <SpeakerTimeline segments={snapshot.segments} selectedSegmentIds={[]} />
          </div>
        ) : null}
        {activeTab === 'history' && snapshot ? (
          <div className="meeting-speaker-tab-content" id={historyPanelId} role="tabpanel" aria-labelledby={historyTabId}>
            <SpeakerRevisionHistory history={snapshot.history} />
          </div>
        ) : null}
      </SpeakerManagementSheet>
    </section>
  );
}

export default SpeakerManagementPanel;
