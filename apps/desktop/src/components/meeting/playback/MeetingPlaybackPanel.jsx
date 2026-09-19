import { useEffect, useMemo, useRef, useState } from 'react';
import {
  classifyStage3cSpeakerCorrectionBinding,
  createStage3cTranscriptPlaybackSync
} from '../../../lib/meetingStage3cTranscriptPlaybackSync.js';
import {
  resolveStage3cPlaybackDependency,
  hasTranscriptSegments
} from '../../../lib/meetingStage3cPlaybackDependency.js';
import {
  clampStage3cPlaybackTime,
  formatStage3cPlaybackTime,
  stage3cPlaybackErrorMessage,
  stage3cSpeakerLabel
} from '../../../lib/meetingStage3cPlaybackUiModel.js';
import { createMeetingPlaybackActionQueue } from '../../../lib/meetingPlaybackActionQueue.js';
import { isTerminalPlaybackActionError } from '../../../lib/meetingPlaybackActionPolicy.js';
import './MeetingPlaybackPanel.css';

function normalizedTranscript(transcript) {
  const candidate = transcript?.currentRevision ? transcript : transcript?.transcript || null;
  return hasTranscriptSegments(candidate) ? candidate : null;
}

function errorCode(error) {
  return String(error?.code || error?.message || 'PLAYBACK_UNSUPPORTED');
}

export function MeetingPlaybackPanel({
  source,
  transcript,
  diarizationRevision = null,
  speakerCorrectionManager = null,
  playback = null,
  evidenceTarget = null,
  title = '原音回放',
  afterPlayback = null
} = {}) {
  const currentTranscript = normalizedTranscript(transcript);
  const dependency = resolveStage3cPlaybackDependency({ source, transcript: currentTranscript, playback });
  const [phase, setPhase] = useState('loading');
  const [error, setError] = useState(null);
  const [sync, setSync] = useState(null);
  const [session, setSession] = useState(null);
  const [snapshot, setSnapshot] = useState({ currentTimeMs: 0, activeSegmentId: null, showReturnToCurrent: false, autoFollowEnabled: true });
  const [playing, setPlaying] = useState(false);
  const [requiresUserGesture, setRequiresUserGesture] = useState(false);
  const [speakerProjection, setSpeakerProjection] = useState(null);
  const [transcriptNotice, setTranscriptNotice] = useState(null);
  const [speakerCorrectionNotice, setSpeakerCorrectionNotice] = useState(null);
  const [seekDraftMs, setSeekDraftMs] = useState(null);
  const [transcriptExpanded, setTranscriptExpanded] = useState(false);
  useEffect(() => { setTranscriptExpanded(false); }, [source?.sourceId]);
  const transcriptRef = useRef(null);
  const rowRefs = useRef(new Map());
  const mountedRef = useRef(false);
  const attachAudioRef = useRef(() => {});
  const seekDraftRef = useRef(null);
  const seekDraggingRef = useRef(false);
  const playbackActionQueueRef = useRef(null);
  if (!playbackActionQueueRef.current) playbackActionQueueRef.current = createMeetingPlaybackActionQueue();

  const binding = useMemo(() => ({
    meetingId: source?.meetingId,
    sourceId: source?.sourceId,
    sourceRevision: source?.revision,
    durationMs: source?.committedDurationMs ?? source?.durationMs,
    sourceChecksum: source?.checksum,
    transcriptId: currentTranscript?.document?.transcriptId,
    transcriptRevision: currentTranscript?.document?.transcriptRevision ?? currentTranscript?.currentRevision?.transcriptRevision
  }), [currentTranscript, source]);

  const durationMs = Number(source?.committedDurationMs ?? source?.durationMs ?? 0);
  const evidenceTargetKey = evidenceTarget?.selectionKey || evidenceTarget?.evidenceRef?.evidenceRefId || '';
  const evidenceTargetStartMs = Number(evidenceTarget?.evidenceRef ? evidenceTarget.evidenceRef.startMs : NaN);
  const evidenceTargetSegmentId = evidenceTarget?.evidenceRef?.segmentId || '';

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let activeSession = null;
    let resolveSessionCleanup = null;
    let removeAudioListeners = () => {};
    setPhase('loading');
    setError(null);
    setSync(null);
    setSession(null);
    setSpeakerProjection(null);
    setTranscriptNotice(null);
    setSpeakerCorrectionNotice(null);
    setPlaying(false);
    setRequiresUserGesture(false);
    setSeekDraftMs(null);
    seekDraftRef.current = null;
    seekDraggingRef.current = false;
    setSnapshot({ currentTimeMs: 0, activeSegmentId: null, showReturnToCurrent: false, autoFollowEnabled: true });
    if (dependency.mode !== 'playback-ready') {
      setPhase('readable-only');
      setError({ code: dependency.reason });
      return () => {};
    }
    (async () => {
      try {
        activeSession = playback.createSession();
        await activeSession.open({ meetingId: source.meetingId, sourceId: source.sourceId });
        let nextSync = null;
        const attachAudio = () => {
          removeAudioListeners();
          const audio = activeSession?.getAudioElement?.();
          if (!audio) return;
          const onTime = () => {
            if (!mountedRef.current || cancelled) return;
            try {
              const currentTimeMs = Number(audio.currentTime || 0) * 1_000;
              if (nextSync) {
                try {
                  setSnapshot(nextSync.updateCurrentTime(currentTimeMs));
                } catch {
                  nextSync.dispose?.();
                  nextSync = null;
                  setSync(null);
                  setTranscriptNotice('文字联动暂不可用，原音仍可播放。');
                }
              } else setSnapshot((current) => ({ ...current, currentTimeMs }));
            } catch (nextError) {
              setTranscriptNotice('文字联动暂不可用，原音仍可播放。');
            }
          };
          const onPlay = () => {
            if (!cancelled) {
              setPlaying(true);
              setRequiresUserGesture(false);
            }
          };
          const onPause = () => { if (!cancelled) setPlaying(false); };
          audio.addEventListener?.('timeupdate', onTime);
          audio.addEventListener?.('play', onPlay);
          audio.addEventListener?.('pause', onPause);
          removeAudioListeners = () => {
            audio.removeEventListener?.('timeupdate', onTime);
            audio.removeEventListener?.('play', onPlay);
            audio.removeEventListener?.('pause', onPause);
          };
        };
        attachAudioRef.current = attachAudio;
        attachAudio();
        if (cancelled) return;
        if (!cancelled) {
          setSession(activeSession);
          setPhase('ready');
          setSnapshot({
            currentTimeMs: Number(activeSession?.getAudioElement?.()?.currentTime || 0) * 1_000,
            activeSegmentId: null,
            showReturnToCurrent: false,
            autoFollowEnabled: true
          });
        }

        let projection = null;
        if (currentTranscript && speakerCorrectionManager?.getSpeakerProjection) {
          try {
            const candidate = await speakerCorrectionManager.getSpeakerProjection({
              meetingId: binding.meetingId,
              transcriptId: binding.transcriptId
            });
            const projectionStatus = classifyStage3cSpeakerCorrectionBinding(candidate, binding);
            if (projectionStatus === 'valid') projection = candidate;
            else if (!cancelled) setSpeakerCorrectionNotice('说话人修正暂不可用，原音与转写仍可使用。');
          } catch {
            if (!cancelled) setSpeakerCorrectionNotice('说话人修正暂不可用，原音与转写仍可使用。');
          }
        }

        if (!cancelled && currentTranscript) {
          try {
            nextSync = createStage3cTranscriptPlaybackSync({
              binding,
              transcript: currentTranscript,
              diarizationRevision,
              speakerCorrectionRevision: projection,
              speakerProjection: projection,
              playbackManager: activeSession,
              maxDomSegments: 200
            });
          } catch {
            try {
              nextSync = createStage3cTranscriptPlaybackSync({
                binding,
                transcript: currentTranscript,
                playbackManager: activeSession,
                maxDomSegments: 200
              });
              if (!cancelled) setSpeakerCorrectionNotice('说话人修正暂不可用，原音与转写仍可使用。');
            } catch {
              nextSync = null;
              if (!cancelled) setTranscriptNotice('文字联动暂不可用，原音仍可播放。');
            }
          }
        }
        if (!cancelled) {
          setSync(nextSync);
          setSpeakerProjection(projection);
          if (nextSync) setSnapshot(nextSync.getSnapshot());
        }
        await new Promise((resolve) => {
          resolveSessionCleanup = resolve;
          if (cancelled) resolve();
        });
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError);
          setPhase('readable-only');
        }
      }
    })();
    return () => {
      cancelled = true;
      attachAudioRef.current = () => {};
      removeAudioListeners();
      resolveSessionCleanup?.();
      activeSession?.dispose?.().catch?.(() => {});
    };
  }, [binding, currentTranscript, dependency.mode, dependency.reason, diarizationRevision, playback, source, speakerCorrectionManager]);

  // Presentation-only seam: EvidenceRef navigation reuses the existing session
  // and transcript synchronizer. It does not retarget or mutate stored evidence.
  useEffect(() => {
    if (!session || phase !== 'ready' || !evidenceTargetKey || !Number.isFinite(evidenceTargetStartMs)) return () => {};
    let cancelled = false;
    void seekTo(evidenceTargetStartMs, false).then(() => {
      if (cancelled) return;
      const row = evidenceTargetSegmentId ? rowRefs.current.get(evidenceTargetSegmentId) : null;
      row?.scrollIntoView?.({ block: 'center' });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [evidenceTargetKey, evidenceTargetSegmentId, evidenceTargetStartMs, phase, session, sync]);

  useEffect(() => { if (evidenceTargetKey) setTranscriptExpanded(true); }, [evidenceTargetKey]);

  const virtualWindow = useMemo(() => {
    if (!sync) return { segments: [], domCount: 0 };
    try {
      return sync.getVirtualizedWindow({ viewportSize: 80, overscan: 40 });
    } catch {
      return { segments: [], domCount: 0 };
    }
  }, [snapshot.activeSegmentId, sync]);

  const allSegments = currentTranscript?.currentRevision?.segments || [];
  const visibleSegments = useMemo(() => {
    const selected = transcriptExpanded ? allSegments : allSegments.slice(0, 3);
    const presentations = new Map();
    if (sync) {
      // Explicit expansion reveals every paragraph, including long meetings.
      // Reuse bounded projections to retain speaker labels without truncating the list.
      for (let index = 0; index < selected.length; index += 160) {
        try {
          const window = sync.getVirtualizedWindow({ centerIndex: index + 80, viewportSize: 160, overscan: 0 });
          for (const row of window.segments) presentations.set(row.segmentId, row);
        } catch { break; }
      }
    }
    return selected.map(segment => presentations.get(segment.segmentId) || segment);
  }, [currentTranscript, sync, transcriptExpanded]);

  useEffect(() => {
    if (!sync || !transcriptRef.current || typeof IntersectionObserver !== 'function') return () => {};
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const segmentId = entry.target.getAttribute('data-segment-id');
        if (!segmentId) continue;
        try {
          const next = sync.setSegmentVisibility(segmentId, entry.isIntersecting);
          setSnapshot(next);
        } catch {
          // Disposal/binding failures are handled by the owning effect.
        }
      }
    }, { root: transcriptRef.current, threshold: 0.4 });
    for (const element of rowRefs.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [sync, virtualWindow.domCount, virtualWindow.startIndex, transcriptExpanded]);

  useEffect(() => {
    if (!transcriptExpanded || !snapshot.autoFollowEnabled || !snapshot.activeSegmentId) return;
    const row = rowRefs.current.get(snapshot.activeSegmentId);
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [snapshot.activeSegmentId, snapshot.autoFollowEnabled, virtualWindow.startIndex, transcriptExpanded]);

  function setRowRef(segmentId, element) {
    if (element) rowRefs.current.set(segmentId, element);
    else rowRefs.current.delete(segmentId);
  }

  async function runPlayback(action, { autoplayRequested = false, isolatedEnhancement = false } = {}) {
    return playbackActionQueueRef.current.enqueue(async () => {
      if (!session || phase !== 'ready') return;
      try {
        const result = await action();
        attachAudioRef.current?.();
        const managerSnapshot = session.getSnapshot?.() || {};
        const pendingGesture = Boolean(result?.requiresUserGesture || managerSnapshot.requiresUserGesture || managerSnapshot.resources?.requiresUserGesture);
        setRequiresUserGesture(pendingGesture);
        if (pendingGesture) setPlaying(false);
        else {
          const audio = session.getAudioElement?.();
          if (typeof audio?.paused === 'boolean') setPlaying(!audio.paused);
          else if (autoplayRequested) setPlaying(true);
        }
        setSnapshot(sync?.getSnapshot?.() || snapshot);
        return result || managerSnapshot;
      } catch (nextError) {
        attachAudioRef.current?.();
        if (nextError?.code === 'PLAYBACK_USER_GESTURE_REQUIRED') {
          setError(null);
          setPhase('ready');
          setPlaying(false);
          setRequiresUserGesture(true);
          setSnapshot(sync?.getSnapshot?.() || snapshot);
          return { requiresUserGesture: true };
        }
        if (isolatedEnhancement && String(nextError?.code || '').startsWith('TRANSCRIPT_')) {
          setTranscriptNotice('文字联动暂不可用，原音仍可播放。');
          return;
        }
        if (isTerminalPlaybackActionError(nextError)) {
          setError(nextError);
          setPhase('readable-only');
          return;
        }
        try {
          const currentTargetMs = clampStage3cPlaybackTime(
            Number(session.getSnapshot?.()?.currentTargetMs ?? snapshot.currentTimeMs ?? 0),
            durationMs
          );
          await session.open({
            meetingId: binding.meetingId,
            sourceId: binding.sourceId,
            initialTimeMs: currentTargetMs
          });
          let recoveredPlaying = false;
          let recoveredRequiresUserGesture = false;
          if (autoplayRequested) {
            try {
              await session.play();
              recoveredPlaying = true;
            } catch (recoveryPlayError) {
              if (recoveryPlayError?.code !== 'PLAYBACK_USER_GESTURE_REQUIRED') throw recoveryPlayError;
              recoveredRequiresUserGesture = true;
            }
          }
          attachAudioRef.current?.();
          setError(null);
          setPhase('ready');
          setPlaying(recoveredPlaying);
          setRequiresUserGesture(recoveredRequiresUserGesture);
          const recoveredSnapshot = sync?.getSnapshot?.();
          if (recoveredSnapshot) setSnapshot(recoveredSnapshot);
          else setSnapshot((current) => ({ ...current, currentTimeMs: currentTargetMs }));
          setTranscriptNotice('这次定位没有完成，原音仍可继续操作，请再试一次。');
        } catch (recoveryError) {
          setError(recoveryError);
          setPhase('readable-only');
        }
      }
    });
  }

  async function togglePlayback() {
    if (playing) return runPlayback(() => session.pause());
    return runPlayback(() => session.play(), { autoplayRequested: true });
  }

  async function seekTo(value, autoplay = playing) {
    const target = clampStage3cPlaybackTime(value, durationMs);
    return runPlayback(async () => {
      const result = await session.seekTo(target, { autoplay });
      const resolvedTargetMs = Number.isFinite(Number(result?.currentTargetMs)) ? Number(result.currentTargetMs) : target;
      if (sync) setSnapshot(sync.updateCurrentTime(resolvedTargetMs));
      else setSnapshot((current) => ({ ...current, currentTimeMs: resolvedTargetMs }));
      return result;
    }, { autoplayRequested: autoplay });
  }

  async function skip(deltaMs) {
    return runPlayback(async () => {
      const result = await session.skipBy(deltaMs, { autoplay: playing });
      const audio = session.getAudioElement?.();
      const resolvedTargetMs = Number.isFinite(Number(result?.currentTargetMs))
        ? Number(result.currentTargetMs)
        : Number(audio?.currentTime || 0) * 1_000;
      if (audio || Number.isFinite(resolvedTargetMs)) {
        const currentTimeMs = resolvedTargetMs;
        if (sync) setSnapshot(sync.updateCurrentTime(currentTimeMs));
        else setSnapshot((current) => ({ ...current, currentTimeMs }));
      }
      return result;
    }, { autoplayRequested: playing });
  }

  async function clickSegment(segmentId) {
    if (!sync) return;
    return runPlayback(async () => {
      const result = await sync.clickSegment(segmentId, { autoplay: true });
      const resolvedTargetMs = Number(result?.seekResult?.currentTargetMs);
      setSnapshot(Number.isFinite(resolvedTargetMs) ? sync.updateCurrentTime(resolvedTargetMs) : result.snapshot);
      return result;
    }, { autoplayRequested: true, isolatedEnhancement: true });
  }

  function beginSeekDraft(event) {
    seekDraggingRef.current = true;
    updateSeekDraft(event);
  }

  function updateSeekDraft(event) {
    const target = clampStage3cPlaybackTime(Number(event.currentTarget.value), durationMs);
    seekDraggingRef.current = true;
    seekDraftRef.current = target;
    setSeekDraftMs(target);
  }

  function commitSeekDraft() {
    if (!seekDraggingRef.current) return;
    const target = seekDraftRef.current;
    seekDraggingRef.current = false;
    seekDraftRef.current = null;
    setSeekDraftMs(null);
    if (Number.isFinite(target)) return seekTo(target);
  }

  function cancelSeekDraft() {
    seekDraggingRef.current = false;
    seekDraftRef.current = null;
    setSeekDraftMs(null);
  }

  function handleTranscriptScroll() {
    if (!sync) return;
    try { setSnapshot(sync.onUserScroll()); } catch { setTranscriptNotice('文字联动暂不可用，原音仍可播放。'); }
  }

  function returnToCurrent() {
    if (!sync) return;
    setTranscriptExpanded(true);
    try { setSnapshot(sync.returnToCurrent()); } catch { setTranscriptNotice('文字联动暂不可用，原音仍可播放。'); }
  }

  const showUnsupported = phase === 'readable-only' || phase === 'error';
  const activeSpeaker = stage3cSpeakerLabel(snapshot.activeSegment);
  const errorCodeValue = errorCode(error);
  const errorCopy = stage3cPlaybackErrorMessage(error);

  return (
    <>
    <section className="meeting-playback-panel" data-testid="meeting-playback-panel" aria-label="原音回放与连续转写">
      <div className="meeting-playback-panel__header">
        <div>
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="mt-1 text-xs text-[color:var(--secondary-text)]">播放原音并跟随当前发言</p>
        </div>
        {snapshot.activeSegment ? <span className="rounded-full bg-[color:var(--accent-soft)] px-3 py-1 text-xs text-[color:var(--accent-color)]">{activeSpeaker}</span> : null}
      </div>

      {showUnsupported ? <div className="meeting-playback-panel__notice" role="status">{errorCopy}<br />原始转写仍可阅读。</div> : null}

      {transcriptNotice ? <div className="meeting-playback-panel__notice" role="status">{transcriptNotice}</div> : null}

      {speakerCorrectionNotice ? <div className="meeting-playback-panel__notice" role="status">{speakerCorrectionNotice}</div> : null}

      <div className="meeting-playback-panel__controls" aria-label="播放控制">
        <div className="flex flex-wrap gap-2">
          <button type="button" className="meeting-playback-panel__button meeting-playback-panel__button--primary meeting-playback-panel__button--play" onClick={togglePlayback} disabled={phase !== 'ready'}>{playing ? '暂停' : requiresUserGesture ? '点击继续播放' : '播放'}</button>
          <button type="button" className="meeting-playback-panel__button meeting-playback-panel__button--skip" onClick={() => skip(-15_000)} disabled={phase !== 'ready'}>前15秒</button>
          <button type="button" className="meeting-playback-panel__button meeting-playback-panel__button--skip" onClick={() => skip(15_000)} disabled={phase !== 'ready'}>后15秒</button>
        </div>
        <input
          className="meeting-playback-panel__range"
          type="range"
          min="0"
          max={durationMs}
          step="100"
          value={clampStage3cPlaybackTime(seekDraftMs ?? snapshot.currentTimeMs, durationMs)}
          onPointerDown={beginSeekDraft}
          onTouchStart={beginSeekDraft}
          onKeyDown={beginSeekDraft}
          onChange={updateSeekDraft}
          onPointerUp={commitSeekDraft}
          onTouchEnd={commitSeekDraft}
          onKeyUp={commitSeekDraft}
          onBlur={commitSeekDraft}
          onPointerCancel={cancelSeekDraft}
          disabled={phase !== 'ready'}
          aria-label="播放进度"
        />
        <div className="meeting-playback-panel__time"><span aria-label="当前时间">当前时间 {formatStage3cPlaybackTime(snapshot.currentTimeMs)}</span><span aria-label="总时长">总时长 {formatStage3cPlaybackTime(durationMs)}</span></div>
      </div>

      {phase === 'ready' && !currentTranscript ? <div className="meeting-playback-panel__notice" role="status">转写尚未完成，原音仍可播放。</div> : null}

      {requiresUserGesture ? <div className="meeting-playback-panel__notice" role="status">音频已定位，点击继续播放</div> : null}

      {errorCodeValue === 'PLAYBACK_SOURCE_BOUNDARY_UNVERIFIED' ? <div className="meeting-playback-panel__notice" role="alert">PLAYBACK_SOURCE_BOUNDARY_UNVERIFIED</div> : null}

    </section>
    {afterPlayback}
    {currentTranscript ? <section className="meeting-playback-panel meeting-playback-panel--transcript" aria-label="原始文字回看">
      <div className="meeting-playback-panel__transcript" ref={transcriptRef} onScroll={handleTranscriptScroll} aria-label="连续转写">
        <div className="mb-3 flex items-center justify-between gap-2 text-xs text-[color:var(--secondary-text)]"><span>原始文字</span><span>{visibleSegments.length} / {allSegments.length} 条</span></div>
        {visibleSegments.map((segment) => (
          <button
            key={segment.segmentId}
            ref={(element) => setRowRef(segment.segmentId, element)}
            type="button"
            data-segment-id={segment.segmentId}
            className={`meeting-playback-panel__segment${snapshot.activeSegmentId === segment.segmentId ? ' meeting-playback-panel__segment--active' : ''}`}
            onClick={() => clickSegment(segment.segmentId)}
          >
            <span className="meeting-playback-panel__segment-time">{formatStage3cPlaybackTime(segment.startMs)}</span>
            <span className="meeting-playback-panel__segment-body"><span className="meeting-playback-panel__speaker">{stage3cSpeakerLabel(segment)}</span>{segment.text}</span>
          </button>
        ))}
        {snapshot.showReturnToCurrent ? <button type="button" className="meeting-playback-panel__button meeting-playback-panel__button--primary meeting-playback-panel__return" onClick={returnToCurrent}>回到当前发言</button> : null}
      </div>
      {allSegments.length > 3 ? <button type="button" className="meeting-playback-panel__button meeting-playback-panel__expand" aria-expanded={transcriptExpanded} onClick={() => setTranscriptExpanded(current => !current)}>{transcriptExpanded ? '收起文字段落' : `展开全部文字段落（${allSegments.length}）`}</button> : null}
    </section> : null}
    </>
  );
}

export default MeetingPlaybackPanel;
