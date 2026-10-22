import { useEffect, useMemo, useRef, useState } from 'react';

import { createBrowserMeetingPhase1Manager } from '../lib/browserMeetingPhase1.js';
import { exportMeetingAnalysisToWord } from '../lib/meetingAnalysisExport.js';
import { exportMeetingAnalysisToPptx } from '../lib/meetingAnalysisPptxExport.js';
import { createMeetingAnalysisRefinementClient } from '../lib/meetingAnalysisRefinementClient.js';
import { ensureMeetingDiarization } from '../lib/meetingTranscriptionPostProcessor.js';
import { SpeakerManagementPanel } from './meeting/SpeakerManagementPanel.jsx';
import { MeetingRecordingExperience } from './meeting/recording/MeetingRecordingExperience.jsx';
import { MeetingPlaybackPanel } from './meeting/playback/MeetingPlaybackPanel.jsx';
import { MeetingAnalysisPanel } from './meeting/MeetingAnalysisPanel.jsx';
import { MeetingHistoryRow } from './meeting/MeetingHistoryRow.jsx';
import {
  selectCurrentDiarizationJobs,
  selectCurrentTranscriptionJobs
} from './meeting/meetingRevisionSelection.js';
import './meeting/MeetingFuturePunk.css';
import './meeting/MeetingExperience.css';
import {
  createMeetingStage3cRecordingExperience,
  reloadMeetingRecorderSession
} from '../lib/meetingStage3cRecordingExperience.js';
import { persistMeetingRouteRecovery } from '../lib/meetingRouteRecovery.js';
import { handleMeetingTopBack, resolveMeetingPanel } from '../lib/meetingRouteRecoveryUi.js';
import { shouldDismissMeetingOverflowMenu } from '../lib/meetingOverflowMenuUi.js';
import {
  parseSyntheticOwnerBootstrapUsernames,
  shouldInitializeSyntheticOwnerKey
} from '../lib/meetingSyntheticOwnerBootstrap.js';
import {
  AAC_MP4_EXPERIMENT,
  describeRecordingMimeType,
  getMeetingRecordingCodecExperiment,
  isAacMp4MimeType
} from '../lib/meetingRecordingCodecExperiment.js';

const MEETING_STATE_EVIDENCE_BUILD_MARKER = 'stage3b-a-review-generation-224';
const MEETING_STATE_EVIDENCE_SOURCE_BASE = '3c74f7e00f722ef265159d38533ec1485e0bc174';
const MEETING_UI_RC_ENABLED = import.meta.env.VITE_MEETING_UI_RC === '1'
  || import.meta.env.VITE_MEETING_STAGE4_UI_RC === '1';
const meetingAnalysisRefinementClient = createMeetingAnalysisRefinementClient();

function createStateEvidenceTraceId() {
  const bytes = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(12)) : new Uint8Array();
  const suffix = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('') || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `meeting-state-${suffix}`;
}

function createDiarizationBackfillTraceId() {
  return createStateEvidenceTraceId().replace('meeting-state-', 'diarization-backfill-');
}

function stateEvidenceClientMetadata() {
  const locationValue = globalThis.location;
  const pageUrl = locationValue ? `${locationValue.origin}${locationValue.pathname}` : '';
  const navigatorValue = globalThis.navigator;
  const serviceWorkerPresent = Boolean(navigatorValue && 'serviceWorker' in navigatorValue);
  const serviceWorkerController = Boolean(navigatorValue?.serviceWorker?.controller);
  const cacheVersion = String(globalThis.document?.documentElement?.dataset?.cacheVersion || 'none-declared').slice(0, 96);
  return Object.freeze({
    pageUrl,
    buildMarker: MEETING_STATE_EVIDENCE_BUILD_MARKER,
    sourceBaseCommit: MEETING_STATE_EVIDENCE_SOURCE_BASE,
    generation: '224',
    serviceWorkerPresent,
    serviceWorkerController,
    cacheVersion
  });
}

async function recordStateEvidence(transcription, event, { phase = 'state_snapshot' } = {}) {
  const payload = Object.freeze({ ...event, phase });
  try {
    if (typeof transcription?.recordDiagnostic === 'function') {
      await transcription.recordDiagnostic(payload);
      return true;
    }
    if (typeof globalThis.fetch !== 'function') return false;
    const response = await globalThis.fetch('/api/meeting/transcription/diagnostic', {
      method: 'POST',
      credentials: 'include',
      mode: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Meeting-Trace-Id': payload.traceId
      },
      body: JSON.stringify(payload)
    });
    return response.ok;
  } catch {
    return false;
  }
}

const statusLabels = Object.freeze({
  draft: '草稿',
  ready: '可录音',
  recording: '正在录音',
  interrupted: '录音已中断',
  finalization_pending: '已安全保存，待完成封存',
  stopped: '已停止',
  failed_retryable: '需要重试',
  failed_terminal: '无法继续'
});

const audioFormatLabels = Object.freeze({
  recorded: '现场录音',
  m4a: 'M4A',
  aac: 'AAC',
  mp3: 'MP3',
  wav: 'WAV',
  'webm-opus': 'WebM/Opus'
});

const importStateLabels = Object.freeze({
  selected: '已选择',
  validating: '正在预检',
  importing: '正在加密导入',
  committed: '已完成',
  rejected: '已拒绝',
  failed_retryable: '可重试失败',
  cancelled: '已取消',
  deleting: '正在删除',
  deleted: '已删除'
});

const transcriptionStateLabels = Object.freeze({
  queued: '等待处理',
  preparing: '正在准备',
  transcribing: '正在转写',
  stitching: '正在整理',
  ready: '转写完成',
  cancelled: '已取消',
  failed_retryable: '转写失败，可重试',
  paused_retryable: '已暂停，可继续',
  failed_terminal: '转写失败'
});

const diarizationStateLabels = Object.freeze({
  queued: '等待识别说话人',
  preparing: '正在准备说话人识别',
  diarizing: '正在识别说话人',
  stitching: '正在对齐说话人时间轴',
  ready: '说话人时间轴已完成',
  failed: '说话人识别失败',
  blocked: 'Provider 不支持说话人识别',
  cancelled: '说话人识别已取消'
});

const analysisListStateLabels = Object.freeze({
  current: '分析已保存',
  saved: '分析已保存',
  stale: '分析需更新',
  superseded: '已有更新版本',
  revalidation_required: '证据待验证',
  unavailable: '暂无分析',
  invalid: '分析暂不可用'
});

function createMeetingOwnerContext(currentUser) {
  if (!currentUser?.id) return null;
  return Object.freeze({
    trusted: true,
    ownerId: String(currentUser.id),
    sessionId: String(currentUser.sessionId || currentUser.session?.id || `auth-session-${currentUser.id}`),
    spaceId: 'meeting-space'
  });
}

function audioImportMessage(value) {
  const code = value?.errorCode || '';
  const labels = Object.freeze({
    AUDIO_FILE_TOO_LARGE: '文件超过1GB上限。',
    AUDIO_DURATION_TOO_LONG: '音频超过4小时上限。',
    AUDIO_EXTENSION_MISMATCH: '文件扩展名与内容不一致。',
    AUDIO_MIME_MISMATCH: '文件类型与内容不一致。',
    AUDIO_HEADER_INVALID: '无法识别或读取音频文件头。',
    AUDIO_METADATA_INVALID: '音频元数据不完整或损坏。',
    IMPORT_FILE_OBJECT_UNAVAILABLE: 'Safari刷新后无法恢复File对象，请重新选择同一文件。',
    IMPORT_CANCELLED: '导入已取消，未保留可用半成品。'
  });
  return value?.message || labels[code] || (code ? `导入未完成（${code}）。` : '');
}

function meetingOperationErrorMessage(code) {
  const normalized = String(code || '').trim();
  const labels = Object.freeze({
    EVIDENCE_AUDIO_DURATION_MISMATCH: '录音与转写时间轴不一致，会议整理未执行。请基于当前录音重新转写后再试。'
  });
  return labels[normalized] || code;
}

function formatDate(value) {
  if (!value) return '未明确';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '未明确';
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDuration(durationMs = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function formatTranscriptTime(milliseconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours ? `${hours.toString().padStart(2, '0')}:` : ''}${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function transcriptionProgress(job) {
  if (!job) return 0;
  if (job.status === 'ready') return 100;
  if (Number.isFinite(job.progress?.percent)) return Math.min(99, Math.max(0, job.progress.percent));
  if (!job.chunkCount) return 0;
  return Math.min(99, Math.round((job.nextChunkSequence / (job.chunkCount + 1)) * 100));
}

function transcriptionErrorMessage(job) {
  const labels = Object.freeze({
    REAL_MEETING_ASR_PROVIDER_BLOCKED: '转写服务暂时不可用，原音仍可回听；服务恢复后可继续转写。',
    STAGE3B_REAL_DIARIZATION_PROVIDER_BLOCKED: '说话人识别暂时不可用，原始转写仍可使用。',
    XFYUN_PROVIDER_ERROR: '转写服务未完成，请稍后重试。',
    XFYUN_SIGNATURE_GENERATION_FAILED: '转写服务连接未完成，请稍后重试。',
    SOURCE_REVISION_MISMATCH: '音频源版本已变化，旧转写已停止，请从当前音频重新开始。',
    TRANSCRIPTION_CANCELLED: '转写已取消，未保留可读取的半成品。'
  });
  return labels[job?.errorCode] || (job?.errorCode ? `转写未完成（${job.errorCode}）。` : '');
}

function hasExactDiarizationBinding({ transcript, diarization } = {}) {
  const document = transcript?.document;
  const revision = diarization?.revision;
  return document?.status === 'ready'
    && revision?.meetingId === document.meetingId
    && revision?.transcriptId === document.transcriptId
    && revision?.transcriptRevision === document.transcriptRevision
    && Array.isArray(revision?.segments)
    && revision.segments.length > 0;
}

function Section({ title, children, action, className = '' }) {
  return (
    <section className={`rounded-[var(--radius-card)] border border-[color:var(--border-color)] bg-[color:var(--surface-background)] p-4 shadow-[var(--surface-shadow)] ${className}`.trim()}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-[color:var(--primary-text)]">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptyState({ children }) {
  return <div className="rounded-[12px] border border-dashed border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 py-4 text-sm leading-6 text-[color:var(--secondary-text)]">{children}</div>;
}

function meetingListStatus(meeting, analysisState = 'unavailable') {
  const recordingState = meeting?.recordingState || 'draft';
  if (recordingState === 'recording') return { label: '正在记录', tone: 'recording' };
  if (recordingState === 'interrupted') return { label: '需要继续', tone: 'attention' };
  if (recordingState === 'finalization_pending') return { label: '正在保存', tone: 'processing' };
  if (recordingState === 'draft' || recordingState === 'ready') return { label: '可录音', tone: 'listening' };
  if (analysisState === 'current' || analysisState === 'saved') return { label: '已整理', tone: 'completed' };
  if (recordingState === 'stopped' && Number(meeting?.committedSegmentCount || 0) > 0) return { label: '可回听', tone: 'listening' };
  if (recordingState === 'stopped') return { label: '已保存', tone: 'completed' };
  return { label: statusLabels[recordingState] || '待处理', tone: 'attention' };
}

function meetingsThisWeek(meetings = [], now = new Date()) {
  const today = new Date(now);
  const day = today.getDay() || 7;
  const weekStart = new Date(today);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(today.getDate() - day + 1);
  return meetings.filter((meeting) => {
    const createdAt = new Date(meeting?.createdAt || '');
    return !Number.isNaN(createdAt.getTime()) && createdAt >= weekStart && createdAt <= today;
  }).length;
}

function StatusPill({ state }) {
  return <span className="rounded-full bg-[color:var(--accent-soft)] px-3 py-1 text-xs text-[color:var(--accent-color)]">{statusLabels[state] || state}</span>;
}

function MeetingCenter({ onNavigate, currentUser, routeRecovery = null }) {
  const [manager, setManager] = useState(null);
  const [recordingExperience, setRecordingExperience] = useState(null);
  const [snapshot, setSnapshot] = useState({ meetings: [], active: null, recorderStatus: 'idle', recorderInfo: null, audioImport: null, initialized: false });
  const [transcriptionSnapshot, setTranscriptionSnapshot] = useState({ jobs: [], activeJob: null, provider: { available: false, sourceAvailable: false, status: 'blocked' }, initialized: false });
  const [diarizationSnapshot, setDiarizationSnapshot] = useState({ jobs: [], activeJob: null, provider: { available: false, diarizationAvailable: false, status: 'blocked' }, initialized: false });
  const [transcripts, setTranscripts] = useState({});
  const [diarizations, setDiarizations] = useState({});
  const [analysis, setAnalysis] = useState(null);
  const [analysisOperation, setAnalysisOperation] = useState({ status: 'idle', bundle: null, errorCode: '', diagnostics: null });
  const [analysisRefinement, setAnalysisRefinement] = useState({ status: 'idle', request: '', result: '', errorCode: '' });
  const [analysisStates, setAnalysisStates] = useState({});
  const [evidenceTarget, setEvidenceTarget] = useState(null);
  const [transcriptDrafts, setTranscriptDrafts] = useState({});
  const [title, setTitle] = useState('新会议');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [mobilePanel, setMobilePanel] = useState('list');
  const [detailView, setDetailView] = useState('main');
  const [renamePending, setRenamePending] = useState(false);
  const analysisClickLock = useRef(false);
  const meetingViewportRef = useRef(null);
  const showDetailView = (view) => {
    if (meetingViewportRef.current) meetingViewportRef.current.scrollTop = 0;
    setDetailView(view);
  };
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  const [segmentsExpanded, setSegmentsExpanded] = useState(false);
  const [transcriptsExpanded, setTranscriptsExpanded] = useState({});
  const [transcriptionStartingSourceId, setTranscriptionStartingSourceId] = useState(null);
  const [encryptionState, setEncryptionState] = useState('preparing');
  const overflowMenuRef = useRef(null);
  const fileInputRef = useRef(null);
  const autoDiarizationRuns = useRef(new Set());
  const backfillAuditRuns = useRef(new Set());
  const recordingAuditRuns = useRef(new Set());

  useEffect(() => {
    if (!overflowMenuOpen) return undefined;
    const closeFromOutside = (event) => {
      if (shouldDismissMeetingOverflowMenu({ root: overflowMenuRef.current, target: event.target })) {
        setOverflowMenuOpen(false);
      }
    };
    const closeOnKeyDown = (event) => {
      if (event.key === 'Escape') setOverflowMenuOpen(false);
    };
    const closeOnScroll = () => setOverflowMenuOpen(false);
    document.addEventListener('pointerdown', closeFromOutside, true);
    document.addEventListener('keydown', closeOnKeyDown);
    document.addEventListener('scroll', closeOnScroll, true);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside, true);
      document.removeEventListener('keydown', closeOnKeyDown);
      document.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [overflowMenuOpen]);

  useEffect(() => {
    let cancelled = false;
    let currentManager = null;
    let currentRecordingExperience = null;
    let unsubscribeTranscription = () => {};
    let unsubscribeDiarization = () => {};
    let unsubscribeAnalysis = () => {};
    const stateEvidenceTraceId = createStateEvidenceTraceId();
    const stateEvidenceMetadata = stateEvidenceClientMetadata();
    setManager(null);
    setRecordingExperience(null);
    setSnapshot({ meetings: [], active: null, recorderStatus: 'idle', recorderInfo: null, audioImport: null, initialized: false });
    setTranscriptionSnapshot({ jobs: [], activeJob: null, provider: { available: false, sourceAvailable: false, status: 'blocked' }, initialized: false });
    setDiarizationSnapshot({ jobs: [], activeJob: null, provider: { available: false, diarizationAvailable: false, status: 'blocked' }, initialized: false });
    setTranscripts({});
    setDiarizations({});
    setAnalysis(null);
    setAnalysisOperation({ status: 'idle', bundle: null, errorCode: '', diagnostics: null });
    setAnalysisRefinement({ status: 'idle', request: '', result: '', errorCode: '' });
    setAnalysisStates({});
    setEvidenceTarget(null);
    autoDiarizationRuns.current.clear();
    backfillAuditRuns.current.clear();
    recordingAuditRuns.current.clear();
    setTranscriptDrafts({});
    setError('');
    setNotice('');
    setMobilePanel('list');
    setOverflowMenuOpen(false);
    setSegmentsExpanded(false);
    setTranscriptsExpanded({});
    setEncryptionState('preparing');

    if (!currentUser?.id) {
      setEncryptionState('blocked');
      setError('OWNER_SESSION_UNAVAILABLE');
      return () => {};
    }

    const ownerContext = createMeetingOwnerContext(currentUser);
    const syntheticOwnerBootstrapUsernames = parseSyntheticOwnerBootstrapUsernames(
      import.meta.env.VITE_MEETING_SYNTHETIC_OWNER_USERNAMES || 'meeting-phase1a-synthetic'
    );
    const initializeSyntheticOwnerKey = shouldInitializeSyntheticOwnerKey({
      enabled: import.meta.env.VITE_MEETING_SYNTHETIC_OWNER_INIT === '1',
      username: currentUser?.username,
      allowedUsernames: syntheticOwnerBootstrapUsernames
    });

    createBrowserMeetingPhase1Manager({
      ownerContext,
      initializeSyntheticOwnerKey,
      initializeAuthenticatedOwnerKey: true,
      exposeTestHandles: MEETING_UI_RC_ENABLED
    })
      .then(async (createdManager) => {
        currentManager = createdManager;
        if (cancelled) {
          await createdManager.dispose();
          return;
        }
        createdManager.subscribe(setSnapshot);
        unsubscribeTranscription = createdManager.transcription?.subscribe(setTranscriptionSnapshot) || (() => {});
        unsubscribeDiarization = createdManager.diarization?.subscribe(setDiarizationSnapshot) || (() => {});
        unsubscribeAnalysis = createdManager.analysis?.subscribe(setAnalysisOperation) || (() => {});
        await createdManager.initialize();
        let stateEvidence = Object.freeze({ events: Object.freeze([]), nextStateSequence: 1 });
        try {
          const routeMeetingId = createdManager.getSnapshot?.().active?.meeting?.meetingId || '';
          stateEvidence = await createdManager.transcription?.collectStateEvidence?.({ routeMeetingId }) || stateEvidence;
          void Promise.all((stateEvidence.events || []).map((event) => recordStateEvidence(createdManager.transcription, {
            traceId: stateEvidenceTraceId,
            ...stateEvidenceMetadata,
            ...event
          })));
        } catch {
          void recordStateEvidence(createdManager.transcription, {
            traceId: stateEvidenceTraceId,
            ...stateEvidenceMetadata,
            stateSequence: 1,
            stateStep: 'snapshotComplete',
            status: 'FAIL',
            errorCode: 'STATE_EVIDENCE_COLLECTION_FAILED'
          });
        }
        await createdManager.transcription?.initialize?.();
        await createdManager.diarization?.initialize?.();
        if (cancelled) {
          await createdManager.dispose();
          return;
        }
        currentRecordingExperience = createMeetingStage3cRecordingExperience({
          manager: createdManager,
          reloadRecorderSession: () => {
            const recoveryMeetingId = createdManager.getSnapshot?.().active?.meeting?.meetingId;
            persistMeetingRouteRecovery({ ownerId: currentUser?.id, meetingId: recoveryMeetingId });
            return reloadMeetingRecorderSession();
          }
        });
        if (MEETING_UI_RC_ENABLED) {
          globalThis.__meetingStage4UiRc = {
            ownerContext,
            manager: createdManager,
            testOnly: createdManager.testOnly
          };
        }
        setManager(createdManager);
        setRecordingExperience(currentRecordingExperience);
        let restoredSnapshot = createdManager.getSnapshot();
        if (routeRecovery?.meetingId && restoredSnapshot?.active?.meeting?.meetingId !== routeRecovery.meetingId) {
          try {
            await createdManager.openMeeting(routeRecovery.meetingId);
            restoredSnapshot = createdManager.getSnapshot();
          } catch {
            // A missing route target fails closed to the Meeting list.
          }
        }
        setSnapshot(restoredSnapshot);
        setMobilePanel(restoredSnapshot?.active?.meeting?.meetingId === routeRecovery?.meetingId ? 'detail' : 'list');
        setTranscriptionSnapshot(createdManager.transcription?.getSnapshot?.() || { jobs: [], activeJob: null, provider: { available: false, status: 'blocked' }, initialized: true });
        setDiarizationSnapshot(createdManager.diarization?.getSnapshot?.() || { jobs: [], activeJob: null, provider: { available: false, diarizationAvailable: false, status: 'blocked' }, initialized: true });
        setAnalysisOperation(createdManager.analysis?.getSnapshot?.() || { status: 'idle', bundle: null, errorCode: '', diagnostics: null });
        setEncryptionState('ready');
      })
      .catch((nextError) => {
        void recordStateEvidence(currentManager?.transcription, {
          traceId: stateEvidenceTraceId,
          ...stateEvidenceMetadata,
          stateSequence: 64,
          stateStep: 'fatalError',
          status: 'FAIL',
          fatalErrorCode: nextError?.code || 'MEETING_LOCAL_STORAGE_UNAVAILABLE',
          fatalErrorFile: 'apps/desktop/src/components/MeetingCenter.jsx',
          fatalErrorFunction: 'MeetingCenter.initialization.catch'
        });
        if (!cancelled) {
          setEncryptionState('blocked');
          setError(nextError?.code || 'MEETING_LOCAL_STORAGE_UNAVAILABLE');
        }
      });

    return () => {
      cancelled = true;
      unsubscribeTranscription();
      unsubscribeDiarization();
      unsubscribeAnalysis();
      void currentRecordingExperience?.dispose?.();
      void currentManager?.dispose?.();
      if (MEETING_UI_RC_ENABLED && globalThis.__meetingStage4UiRc?.manager === currentManager) {
        delete globalThis.__meetingStage4UiRc;
      }
    };
  }, [currentUser?.id, currentUser?.sessionId, currentUser?.session?.id, routeRecovery?.meetingId]);

  const active = snapshot.active;
  const activeState = active?.meeting?.recordingState || '';
  const effectiveDetailView = ['recording', 'interrupted', 'finalization_pending'].includes(activeState) ? 'main' : detailView;
  useEffect(() => { setDetailView('main'); }, [active?.meeting?.meetingId]);

  useEffect(() => {
    setAnalysisRefinement({ status: 'idle', request: '', result: '', errorCode: '' });
  }, [active?.meeting?.meetingId, analysis?.analysisId, analysis?.analysisRevision]);

  const recordingCodecExperiment = getMeetingRecordingCodecExperiment();
  const aacExperimentActive = recordingCodecExperiment === AAC_MP4_EXPERIMENT;
  const recordedSource = active?.audioSources?.find((source) => source.origin === 'recorded') || null;
  const actualRecorderMimeType = snapshot.recorderInfo?.actualMimeType || recordedSource?.mimeType || '';
  const recordingFormat = describeRecordingMimeType(actualRecorderMimeType);
  const audioImport = snapshot.audioImport || { importState: 'idle', progress: { bytesProcessed: 0, totalBytes: 0, percent: 0 }, requiresReselect: false, message: '' };
  const importBusy = ['validating', 'importing'].includes(audioImport.importState);
  const encryptionStatus = encryptionState === 'ready' ? '本地加密空间已就绪' : '正在准备本地加密空间…';
  const visibleError = error === 'KEY_NOT_FOUND'
    ? '本地加密空间未就绪，当前合成候选已停止。'
    : meetingOperationErrorMessage(error);
  const transcriptJobKey = useMemo(
    () => (transcriptionSnapshot.jobs || []).map((job) => `${job.jobId}:${job.revision}:${job.status}`).join('|'),
    [transcriptionSnapshot.jobs]
  );
  const diarizationJobKey = useMemo(
    () => (diarizationSnapshot.jobs || []).map((job) => `${job.jobId}:${job.revision}:${job.status}`).join('|'),
    [diarizationSnapshot.jobs]
  );
  const activeSourceKey = useMemo(() => (active?.audioSources || []).map((source) => `${source.sourceId}:${source.revision}`).join('|'), [active?.audioSources]);

  useEffect(() => {
    setSegmentsExpanded(false);
    setTranscriptsExpanded({});
  }, [active?.meeting?.meetingId]);

  useEffect(() => {
    if (!manager?.transcription || !active?.meeting || !snapshot.recorderInfo || !recordedSource) return;
    const info = snapshot.recorderInfo;
    const key = [
      active.meeting.meetingId,
      recordedSource.sourceId,
      recordedSource.revision,
      info.actualMimeType,
      recordedSource.chunkCount
    ].join(':');
    if (recordingAuditRuns.current.has(key)) return;
    recordingAuditRuns.current.add(key);
    void recordStateEvidence(manager.transcription, {
      traceId: createStateEvidenceTraceId(),
      ownerId: String(currentUser?.id || ''),
      meetingId: active.meeting.meetingId,
      sourceId: recordedSource.sourceId,
      recordingCodecExperiment: info.recordingCodecExperiment || recordingCodecExperiment,
      selectedMimeType: info.selectedMimeType || '',
      actualMimeType: info.actualMimeType || recordedSource.mimeType,
      container: info.container || recordingFormat.container,
      codec: info.codec || recordingFormat.codec,
      segmentCount: recordedSource.chunkCount,
      audioSourceChunkCount: recordedSource.chunkCount,
      audioSourceFormat: recordedSource.format,
      status: 'PASS'
    });
  }, [active?.meeting?.meetingId, currentUser?.id, manager, recordedSource, recordingCodecExperiment, recordingFormat.codec, recordingFormat.container, snapshot.recorderInfo]);

  useEffect(() => {
    let cancelled = false;
    const readyJobs = selectCurrentTranscriptionJobs({
      jobs: transcriptionSnapshot.jobs,
      meetingId: active?.meeting?.meetingId,
      activeSources: active?.audioSources,
      transcriptOnlyJobIds: transcriptionSnapshot.transcriptOnlyJobIds
    });
    if (!manager?.transcription || typeof manager.transcription.getTranscriptView !== 'function' || !readyJobs.length) return () => {};
    (async () => {
      const loaded = {};
      for (const job of readyJobs) {
        try {
          loaded[job.sourceId] = await manager.transcription.getTranscriptView({
            sourceId: job.sourceId,
            meetingId: job.meetingId,
            transcriptId: job.transcriptId
          });
        } catch {
          // A missing or stale source remains visible through its ready Transcript when the store can open it.
        }
      }
      if (!cancelled && Object.keys(loaded).length) setTranscripts((current) => ({ ...current, ...loaded }));
    })();
    return () => { cancelled = true; };
  }, [manager, active?.meeting?.meetingId, activeSourceKey, transcriptJobKey, transcriptionSnapshot.jobs]);

  useEffect(() => {
    let cancelled = false;
    const readyJobs = selectCurrentDiarizationJobs({
      jobs: diarizationSnapshot.jobs,
      meetingId: active?.meeting?.meetingId,
      currentTranscripts: transcripts
    });
    if (!manager?.diarization || !readyJobs.length) return () => {};
    (async () => {
      const loaded = {};
      for (const job of readyJobs) {
        try {
          const view = await manager.diarization.getDiarizationView({ meetingId: job.meetingId, transcriptId: job.transcriptId });
          if (view.revision) loaded[job.sourceId] = view;
        } catch {
          // A changed Raw Transcript revision intentionally hides a stale speaker mapping.
        }
      }
      if (!cancelled && Object.keys(loaded).length) setDiarizations((current) => ({ ...current, ...loaded }));
    })();
    return () => { cancelled = true; };
  }, [manager, active?.meeting?.meetingId, activeSourceKey, diarizationJobKey, diarizationSnapshot.jobs, transcripts]);

  useEffect(() => {
    if (!manager?.diarization) return () => {};
    const providerReady = diarizationSnapshot.provider?.diarizationAvailable === true;
    for (const source of active?.audioSources || []) {
      const transcript = transcripts[source.sourceId]?.transcript;
      const diarizationJob = [...(diarizationSnapshot.jobs || [])].reverse().find((job) => job.sourceId === source.sourceId && job.sourceRevision === source.revision);
      const diarizationView = diarizations[source.sourceId]?.revision;
      const transcriptRevision = transcript?.document?.transcriptRevision;
      const runKey = `${source.sourceId}:${source.revision}:${transcriptRevision || 0}`;
      const auditKey = `${source.sourceId}:${source.revision}:${transcriptRevision || 0}`;
      if (transcript?.document?.status !== 'ready' || !providerReady || backfillAuditRuns.current.has(auditKey)) continue;
      backfillAuditRuns.current.add(auditKey);
      const traceId = createDiarizationBackfillTraceId();
      const metadata = {
        ...stateEvidenceClientMetadata(),
        traceId,
        ownerId: String(currentUser?.id || ''),
        meetingId: source.meetingId,
        sourceId: source.sourceId,
        transcriptId: transcript.document.transcriptId,
        transcriptRevision: transcript.document.transcriptRevision
      };
      const revisionMissing = !diarizationView;
      const backfillCondition = revisionMissing
        && !diarizationJob
        && !autoDiarizationRuns.current.has(runKey);
      void recordStateEvidence(manager.transcription, {
        ...metadata,
        gate: 'G1',
        transcriptState: 'ready',
        status: 'PASS'
      }, { phase: 'diarization_backfill' });
      void recordStateEvidence(manager.transcription, {
        ...metadata,
        gate: 'G2',
        revisionMissing,
        revisionCount: revisionMissing ? 0 : 1,
        latestRevision: diarizationView?.revision || null,
        latestRevisionDecryptable: Boolean(diarizationView),
        status: revisionMissing ? 'PASS' : 'FAIL'
      }, { phase: 'diarization_backfill' });
      void recordStateEvidence(manager.transcription, {
        ...metadata,
        gate: 'G3',
        backfillCondition,
        diarizationJobFound: Boolean(diarizationJob),
        diarizationJobStatus: diarizationJob?.status || null,
        status: backfillCondition ? 'PASS' : 'FAIL'
      }, { phase: 'diarization_backfill' });
      if (!backfillCondition) continue;
      autoDiarizationRuns.current.add(runKey);
      void ensureMeetingDiarization({
        source,
        transcriptionManager: manager.transcription,
        diarizationManager: manager.diarization,
        diagnosticTraceId: traceId,
        diagnosticMetadata: metadata
      }).then((result) => {
        if (result.view?.revision) {
          setDiarizations((current) => ({ ...current, [source.sourceId]: result.view }));
          void recordStateEvidence(manager.transcription, {
            ...metadata,
            gate: 'G9',
            uiRevisionLoaded: true,
            diarizationRevision: result.view.revision.revision,
            status: 'PASS'
          }, { phase: 'diarization_backfill' });
        }
      }).catch((nextError) => {
        autoDiarizationRuns.current.delete(runKey);
        void recordStateEvidence(manager.transcription, {
          ...metadata,
          gate: 'G9',
          uiRevisionLoaded: false,
          status: 'FAIL',
          errorCode: nextError?.code || 'DIARIZATION_POST_PROCESS_FAILED'
        }, { phase: 'diarization_backfill' });
      });
    }
    return () => {};
  }, [manager, active?.meeting?.meetingId, activeSourceKey, transcriptJobKey, diarizationJobKey, transcripts, diarizations, diarizationSnapshot.jobs, diarizationSnapshot.provider?.diarizationAvailable, currentUser?.id]);

  const run = async (operation, successMessage = '') => {
    if (!manager || busy) return;
    setBusy(true);
    setError('');
    try {
      await operation();
      if (successMessage) setNotice(successMessage);
    } catch (nextError) {
      if (nextError?.code === 'IMPORT_CANCELLED') {
        setError('');
        setNotice('导入已取消，未保留可用半成品。');
      } else {
        setError(nextError?.code || 'MEETING_OPERATION_FAILED');
        setNotice('');
      }
    } finally {
      setBusy(false);
    }
  };

  const createMeeting = () => run(async () => {
    setOverflowMenuOpen(false);
    await manager.createMeeting({ title });
    setMobilePanel('detail');
  }, '会议已创建，可以开始录音。');

  const openMeeting = (meetingId) => run(async () => {
    setOverflowMenuOpen(false);
    await manager.openMeeting(meetingId);
    setMobilePanel('detail');
  }, '会议已打开。');

  const openImportMeeting = () => {
    setOverflowMenuOpen(false);
    setError('');
    setNotice('请选择音频文件，系统会先在本地加密导入，再进入转写流程。');
    setMobilePanel('import');
  };

  const chooseAudioFile = () => fileInputRef.current?.click();

  const handleAudioFile = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !manager) return;
    run(async () => {
      const currentActive = manager.getSnapshot?.().active;
      const shouldCreateImportMeeting = mobilePanel === 'import';
      if (shouldCreateImportMeeting || !currentActive?.meeting) {
        const importedTitle = file.name.replace(/\.[^.]+$/, '').trim() || '导入会议';
        await manager.createMeeting({ title: importedTitle });
      }
      const currentImport = manager.getSnapshot?.().audioImport || audioImport;
      const retryExisting = currentImport.requiresReselect && currentImport.importId && currentImport.sourceId;
      await manager.importAudio(file, retryExisting ? { importId: currentImport.importId, sourceId: currentImport.sourceId } : {});
      setMobilePanel('detail');
    }, '音频已完成加密导入。');
  };

  const cancelAudioImport = async () => {
    if (!manager || !importBusy) return;
    setError('');
    setNotice('');
    try {
      await manager.cancelAudioImport();
      setNotice('导入已取消，未保留可用半成品。');
    } catch (nextError) {
      setError(nextError?.code || 'AUDIO_IMPORT_CANCEL_FAILED');
    }
  };

  const deleteAudioSource = (sourceId) => {
    if (!window.confirm('确定删除这个音频吗？')) return;
    return run(() => manager.deleteAudioSource(sourceId), '音频已删除');
  };

  const deleteOriginalAudio = (sourceId) => {
    if (!window.confirm('删除原录音后仍可查看和编辑转写内容，是否继续？')) return;
    return run(() => manager.deleteAudioSource(sourceId), '原录音已删除，转写内容已保留');
  };

  const deleteMeeting = (meetingId) => {
    if (!window.confirm('确定删除这条会议记录吗？')) return;
    return run(async () => {
      await manager.deleteMeeting(meetingId);
      if (active?.meeting?.meetingId === meetingId) setMobilePanel('list');
    }, '会议记录已删除。');
  };

  const startTranscription = async (sourceId) => {
    setTranscriptionStartingSourceId(sourceId);
    try {
      return await run(() => manager.transcription.startTranscription({ sourceId }), '录音转文字已开始，完成后会显示原始文字。');
    } finally { setTranscriptionStartingSourceId(null); }
  };

  const cancelTranscription = (jobId) => run(
    () => manager.transcription.cancelTranscription({ jobId }),
    '转写已取消，未保留可读取的半成品。'
  );

  const resumeTranscription = (sourceId) => run(
    async () => {
      setNotice('正在恢复转写，请稍候…');
      await manager.transcription.resumeTranscription({ sourceId });
    },
    '转写任务已恢复，正在处理。'
  );

  const runMeetingAnalysis = () => {
    if (!analysisSource || !analysisTranscriptRevision || !manager?.analysis) {
      setError('MEETING_TRANSCRIPT_REQUIRED');
      setNotice('');
      return;
    }
    return run(async () => {
      const result = await manager.analysis.analyze({
        source: analysisSource,
        transcriptRevision: analysisTranscriptRevision,
        currentTranscriptRevision: analysisTranscriptRevision,
        diarizationRevision: analysisDiarizationRevision,
        meetingMetadata: { title: active?.meeting?.title || title }
      });
      const nextBundle = result?.bundle || manager.analysis.getSnapshot?.().bundle || null;
      if (nextBundle) {
        setAnalysis(nextBundle);
        setAnalysisStates((current) => ({ ...current, [active.meeting.meetingId]: 'current' }));
      }
    }, '会议已整理并保存。');
  };

  const runMeetingAnalysisRefinement = async (request) => {
    const normalizedRequest = String(request || '').trim();
    if (!analysis || !normalizedRequest) {
      setAnalysisRefinement({ status: 'failed', request: normalizedRequest, result: '', errorCode: 'MEETING_ANALYSIS_REFINEMENT_REQUEST_INVALID' });
      return false;
    }
    setAnalysisRefinement({ status: 'submitting', request: normalizedRequest, result: '', errorCode: '' });
    setError('');
    setNotice('');
    try {
      const result = await meetingAnalysisRefinementClient({ analysis, request: normalizedRequest });
      setAnalysisRefinement({ status: 'ready', request: normalizedRequest, result: result.content, errorCode: '' });
      setNotice('AI 微调草稿已生成，未写回会议结果。');
      return true;
    } catch (nextError) {
      setAnalysisRefinement({ status: 'failed', request: normalizedRequest, result: '', errorCode: nextError?.code || 'MEETING_ANALYSIS_REFINEMENT_UNAVAILABLE' });
      setNotice('');
      return false;
    }
  };

  const exportMeetingDocument = () => {
    if (!analysis) return;
    try {
      const filename = exportMeetingAnalysisToWord(active?.meeting?.title || title, analysis);
      setError('');
      setNotice(`会议文档已导出：${filename}`);
    } catch (nextError) {
      setError(nextError?.code || 'MEETING_ANALYSIS_EXPORT_FAILED');
      setNotice('');
    }
  };

  const exportMeetingPresentation = () => {
    if (!analysis) return;
    try {
      const filename = exportMeetingAnalysisToPptx(active?.meeting?.title || title, analysis);
      setError('');
      setNotice(`会议 PPT 已导出：${filename}`);
    } catch (nextError) {
      setError(nextError?.code || 'MEETING_ANALYSIS_EXPORT_FAILED');
      setNotice('');
    }
  };

  const startDiarization = (source, transcript) => run(
    () => manager.diarization.startDiarization({
      sourceId: source.sourceId,
      meetingId: source.meetingId,
      transcriptId: transcript.document.transcriptId,
      speakerCount: 0
    }),
    '说话人时间轴任务已开始，结果只显示匿名说话人。'
  );

  const cancelDiarization = (jobId) => run(
    () => manager.diarization.cancelDiarization({ jobId }),
    '说话人识别已取消。'
  );

  const saveTranscriptCorrection = async (sourceId, segment, transcript) => {
    if (!manager?.transcription || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const nextText = transcriptDrafts[segment.segmentId] ?? segment.text;
      const updated = await manager.transcription.saveCorrection({
        sourceId,
        meetingId: transcript.document.meetingId,
        transcriptId: transcript.document.transcriptId,
        actorId: String(currentUser?.id || ''),
        edits: [{ segmentId: segment.segmentId, text: nextText }]
      });
      setTranscripts((current) => ({ ...current, [sourceId]: { ...current[sourceId], transcript: updated } }));
      setNotice(`已保存第 ${updated.document.transcriptRevision} 版校正。`);
    } catch (nextError) {
      setError(nextError?.code || 'TRANSCRIPT_CORRECTION_FAILED');
    } finally {
      setBusy(false);
    }
  };

  const activeDuration = useMemo(() => formatDuration(active?.meeting?.committedDurationMs), [active?.meeting?.committedDurationMs]);
  const activeSourcesById = new Map((active?.audioSources || []).map((source) => [source.sourceId, source]));
  const activeTranscriptionJobs = selectCurrentTranscriptionJobs({
    jobs: transcriptionSnapshot.jobs,
    meetingId: active?.meeting?.meetingId,
    activeSources: active?.audioSources,
    transcriptOnlyJobIds: transcriptionSnapshot.transcriptOnlyJobIds
  });
  const activeTranscripts = activeTranscriptionJobs
    .map((job) => {
      const view = transcripts[job.sourceId];
      if (!view?.transcript?.currentRevision?.segments?.length) return null;
      return {
        source: activeSourcesById.get(job.sourceId) || {
          sourceId: job.sourceId,
          meetingId: job.meetingId,
          revision: job.sourceRevision,
          originalFileName: '原始音频已不可用',
          origin: 'unavailable'
        },
        transcript: view.transcript,
        mode: view.mode
      };
    })
    .filter(Boolean);
  const activeDiarizedTranscripts = activeTranscripts
    .map((item) => ({ ...item, diarization: diarizations[item.source.sourceId] }))
    .filter(hasExactDiarizationBinding);

  const analysisTranscriptEntry = activeTranscripts.find((item) => item.source.origin === 'recorded') || activeTranscripts[0] || null;
  const analysisSource = analysisTranscriptEntry
    ? active?.audioSources?.find((source) => source.sourceId === analysisTranscriptEntry.source.sourceId) || null
    : null;
  const analysisTranscriptRevision = analysisTranscriptEntry?.transcript?.currentRevision || null;
  const analysisDiarizationRevision = activeDiarizedTranscripts.find(
    (item) => item.source.sourceId === analysisTranscriptEntry?.source.sourceId
  )?.diarization?.revision || null;
  const analysisRevisionKey = [
    active?.meeting?.meetingId || '',
    analysisSource?.sourceId || '',
    analysisSource?.revision || 0,
    analysisTranscriptRevision?.transcriptId || '',
    analysisTranscriptRevision?.transcriptRevision || 0,
    analysisDiarizationRevision?.diarizationRevisionId || ''
  ].join(':');

  useEffect(() => {
    let cancelled = false;
    const ownerContext = createMeetingOwnerContext(currentUser);
    if (!manager?.analysisBundles || !ownerContext || !active?.meeting?.meetingId) {
      setAnalysis(null);
      return () => {};
    }
    const currentContext = {
      source: analysisSource,
      currentTranscriptRevision: analysisTranscriptRevision,
      currentDiarizationRevision: analysisDiarizationRevision
    };
    (async () => {
      try {
        const current = await manager.analysisBundles.getCurrent(ownerContext, {
          meetingId: active.meeting.meetingId,
          currentContext
        });
        if (!cancelled) setAnalysis(current || null);
      } catch {
        if (!cancelled) setAnalysis(null);
      }
    })();
    return () => { cancelled = true; };
  }, [active?.meeting?.meetingId, analysisRevisionKey, analysisDiarizationRevision, analysisSource, analysisTranscriptRevision, currentUser?.id, currentUser?.sessionId, currentUser?.session?.id, manager]);

  useEffect(() => {
    let cancelled = false;
    const ownerContext = createMeetingOwnerContext(currentUser);
    const meetings = snapshot.meetings || [];
    if (!manager?.analysisBundles || !ownerContext || !meetings.length) {
      setAnalysisStates({});
      return () => {};
    }
    (async () => {
      const nextStates = {};
      await Promise.all(meetings.map(async (meeting) => {
        try {
          const values = await manager.analysisBundles.list(ownerContext, { meetingId: meeting.meetingId });
          if (values.length) nextStates[meeting.meetingId] = values.some((value) => value.status === 'CURRENT') ? 'current' : 'saved';
          else nextStates[meeting.meetingId] = 'unavailable';
        } catch {
          nextStates[meeting.meetingId] = 'invalid';
        }
      }));
      if (!cancelled) setAnalysisStates(nextStates);
    })();
    return () => { cancelled = true; };
  }, [currentUser?.id, currentUser?.sessionId, currentUser?.session?.id, manager, snapshot.meetings]);

  const selectEvidence = ({ evidenceRef } = {}) => {
    if (!evidenceRef) return;
    const selectionKey = `${evidenceRef.evidenceRefId}:${evidenceRef.startMs}:${Date.now()}`;
    setDetailView('materials');
    setEvidenceTarget({ selectionKey, evidenceRef });
    setNotice(`已定位到原话 ${formatTranscriptTime(evidenceRef.startMs)}，可在下方回听。`);
  };

  const activeAnalysisState = analysis?.status === 'CURRENT' && analysis?.groundingStatus === 'GROUNDING_SUPPORTED'
    ? 'current'
    : analysis?.status ? String(analysis.status).toLowerCase() : 'unavailable';
  const preferredPlaybackTranscript = activeTranscripts.find((item) => item.source.origin === 'recorded') || activeTranscripts[0] || null;
  const playbackSource = active?.audioSources?.find((source) => source.origin === 'recorded')
    || active?.audioSources?.find((source) => source.sourceId === preferredPlaybackTranscript?.source?.sourceId)
    || active?.audioSources?.[0]
    || null;
  const playbackTranscript = playbackSource
    ? activeTranscripts.find((item) => item.source.sourceId === playbackSource.sourceId) || preferredPlaybackTranscript
    : preferredPlaybackTranscript;
  const playbackPanelSource = playbackSource || playbackTranscript?.source || null;
  const playbackDiarizationRevision = activeDiarizedTranscripts.find(
    (item) => item.source.sourceId === playbackTranscript?.source.sourceId
  )?.diarization?.revision || null;
  const effectiveMobilePanel = resolveMeetingPanel({
    mobilePanel,
    activeMeetingId: active?.meeting?.meetingId
  });
  const isMeetingHome = effectiveMobilePanel === 'list';
  const isMeetingLightSurface = isMeetingHome || effectiveMobilePanel === 'import' || Boolean(active);

  if (error && !manager) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-3 py-4 sm:px-6 sm:py-6">
        <header className="rounded-[var(--radius-card)] border border-[color:var(--border-color)] bg-[color:var(--surface-background)] p-4 shadow-[var(--surface-shadow)]">
          <button type="button" className="mb-2 text-xs font-medium text-[color:var(--accent-color)]" onClick={() => onNavigate?.('工作秘书')}>← 返回首页</button>
          <h2 className="text-2xl font-semibold text-[color:var(--primary-text)]">会议记录</h2>
          <p className="mt-2 text-sm leading-6 text-[color:var(--secondary-text)]">本地加密录音不可用，系统已停止，不会退回明文存储。</p>
        </header>
        <div className="rounded-[12px] border border-[#eed6d1] bg-[#fff8f6] px-4 py-3 text-sm text-[#8a3d32]" role="alert">{visibleError}</div>
      </div>
    );
  }

  const startAnalysisFromUi = async () => {
    if (analysisClickLock.current || busy || analysisOperation.status === 'analyzing') return;
    analysisClickLock.current = true;
    showDetailView('results');
    try { await runMeetingAnalysis(); } finally { analysisClickLock.current = false; }
  };
  const renameHistoricalMeeting = async (meetingId, nextTitle, expectedTitle) => {
    if (!manager?.renameMeeting || busy || importBusy) throw new Error('MEETING_RENAME_BUSY');
    setRenamePending(true);
    setBusy(true);
    try {
      await manager.renameMeeting(meetingId, nextTitle, expectedTitle);
      setNotice('会议名称已保存。');
    } finally { setRenamePending(false); setBusy(false); }
  };

  const analysisPanel = (
    <div className="meeting-v2-result-slot" hidden={effectiveDetailView !== 'results'}>
    <MeetingAnalysisPanel
                analysis={analysis}
                sourceReady={Boolean(analysisSource || playbackPanelSource)}
                transcriptReady={Boolean(analysisTranscriptRevision)}
                onEvidenceSelect={selectEvidence}
                analysisStatus={analysisOperation.status}
                analysisError={analysisOperation.errorCode}
                onAnalyze={startAnalysisFromUi}
                canAnalyze={Boolean(analysisSource && analysisTranscriptRevision && manager?.analysis && !busy)}
                refinementStatus={analysisRefinement.status}
                refinementError={analysisRefinement.errorCode}
                refinementRequest={analysisRefinement.request}
                refinementResult={analysisRefinement.result}
                onRefine={runMeetingAnalysisRefinement}
                onExportDocument={exportMeetingDocument}
                onExportPptx={exportMeetingPresentation}
              />
    </div>
  );

  return (
    <div ref={meetingViewportRef} data-testid="meeting-scroll-container" data-meeting-view={effectiveDetailView} data-meeting-state={activeState} className={`meeting-future-punk meeting-v1-app-shell meeting-experience ${isMeetingLightSurface ? 'meeting-v1-app-shell--light' : ''} ${isMeetingHome ? 'meeting-v1-app-shell--home' : ''} box-border mx-auto flex h-full max-h-full min-h-0 w-full min-w-0 max-w-6xl flex-col gap-4 overflow-x-hidden overflow-y-auto overscroll-y-contain px-3 py-4 sm:px-6 sm:py-6`}>
      <header className={`meeting-v1-topbar${active ? ' meeting-v1-topbar--detail' : ''}`}>
        <button
          type="button"
          className="meeting-v1-top-action meeting-v1-top-action--back"
          disabled={renamePending}
          onClick={() => handleMeetingTopBack({ mobilePanel: effectiveMobilePanel, setMobilePanel, onNavigate })}
          aria-label={effectiveMobilePanel === 'detail' || effectiveMobilePanel === 'import' ? '返回会议列表' : '返回首页'}
          title={effectiveMobilePanel === 'detail' || effectiveMobilePanel === 'import' ? '回到会议列表' : '回到首页'}
        >
          <span className="meeting-v1-top-action__icon" aria-hidden="true">←</span>
          <span className="meeting-v1-top-action__label">{effectiveMobilePanel === 'detail' || effectiveMobilePanel === 'import' ? '会议列表' : 'AI分身'}</span>
        </button>
        <div ref={overflowMenuRef} className="meeting-v1-topbar__menu-wrap">
          <button
            type="button"
            className="meeting-v1-top-action meeting-v1-top-action--more"
            disabled={renamePending}
            onClick={() => setOverflowMenuOpen((current) => !current)}
            aria-label="会议操作菜单"
            aria-expanded={overflowMenuOpen}
            aria-haspopup="menu"
          >更多</button>
          {overflowMenuOpen ? (
            <div className="meeting-v1-overflow-menu" role="menu" aria-label="会议操作">
              <button type="button" role="menuitem" onClick={createMeeting} disabled={busy || !manager || encryptionState !== 'ready'}>＋ 新建会议</button>
              <button type="button" role="menuitem" onClick={openImportMeeting} disabled={busy || !manager}>⇧ 导入会议</button>
              <button type="button" role="menuitem" onClick={() => { setOverflowMenuOpen(false); setNotice('会议内容默认保存在你的本地加密空间。'); }}>本地保存说明</button>
            </div>
          ) : null}
        </div>
        <input
          className="sr-only"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-label="会议标题"
          disabled={busy || !manager}
        />
        <input
          ref={fileInputRef}
          className="sr-only"
          type="file"
          accept=".m4a,.aac,.mp3,.wav,.webm,.opus,audio/m4a,audio/mp4,audio/aac,audio/mpeg,audio/wav,audio/webm,audio/ogg"
          onChange={handleAudioFile}
          disabled={busy || !manager || importBusy}
          aria-label="选择要导入的音频文件"
        />
      </header>

      {aacExperimentActive ? (
        <div className="meeting-v1-technical-status sr-only" data-testid="meeting-aac-experiment-status" role="status">
          <div>实验AAC模式：已启用</div>
          <div>选择的MediaRecorder MIME：{snapshot.recorderInfo?.selectedMimeType || '待开始录音'}</div>
          <div>实际MediaRecorder.mimeType：{actualRecorderMimeType || '待开始录音'}</div>
          <div>container：{recordingFormat.container}</div>
          <div>codec：{recordingFormat.codec}</div>
          {actualRecorderMimeType && !isAacMp4MimeType(actualRecorderMimeType) ? <div>AAC_EXPERIMENT_NOT_ACTIVE</div> : null}
          <div>AudioSource format：{recordedSource?.format || '待停止录音'}</div>
          <div>chunk count：{recordedSource?.chunkCount ?? active?.meeting?.committedSegmentCount ?? 0}</div>
        </div>
      ) : null}

      {notice ? <div className={`meeting-success-notice rounded-[12px] px-4 py-3 text-sm${active ? ' meeting-v1-detail-notice' : ''}`} role="status">{notice}</div> : null}
      {error ? <div className="rounded-[12px] border border-[#eed6d1] bg-[#fff8f6] px-4 py-3 text-sm text-[#8a3d32]" role="alert">操作未完成：{visibleError}</div> : null}

      {effectiveMobilePanel === 'import' ? (
        <section className="meeting-v1-import-page" data-testid="meeting-import-page" aria-label="导入会议">
          <div className="meeting-v1-import-page__eyebrow">MEETING INPUT</div>
          <h1>导入会议</h1>
          <p>把已有录音放进本地会议空间。导入完成后，可在会议详情中完成转写、文字修改，并查看已经保存的 AI 会议整理。</p>
          <button type="button" className="meeting-v1-import-button" onClick={chooseAudioFile} disabled={busy || !manager || importBusy}>选择音频文件</button>
          <div className="meeting-v1-import-page__steps" role="status">
            <span><b>01</b> 本地加密导入</span>
            <span><b>02</b> 完成转写</span>
            <span><b>03</b> 查看原话与已保存整理</span>
          </div>
          {audioImport.importState !== 'idle' ? <div className="meeting-v1-import-page__state">{audioImport.fileName || '音频文件'} · {importStateLabels[audioImport.importState] || audioImport.importState}</div> : null}
          <button type="button" className="meeting-v1-import-page__back" onClick={() => setMobilePanel('list')}>回到会议列表</button>
        </section>
      ) : (
      <div className="meeting-future-punk__workspace grid min-w-0 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <div className={`meeting-future-punk__list-panel min-w-0 ${effectiveMobilePanel === 'detail' ? 'max-[768px]:hidden' : ''}`}>
          <section className="meeting-v1-list-page meeting-v1-list-page--home" aria-label="会议列表">
            <div className="meeting-v1-home-hero">
              <div className="meeting-v1-home-hero__copy">
                <p className="meeting-v1-eyebrow">记录 · 整理 · 回顾</p>
                <h1>会议</h1>
                <p>让讨论有记录，让下一步更清楚。</p>
              </div>
              <div className="meeting-v1-home-hero__metric" aria-label={`已保存 ${snapshot.meetings.length} 场会议`}>
                <span>会议记录</span>
                <strong>{snapshot.meetings.length}</strong>
                <small>已保存</small>
              </div>
            </div>

            <div className="meeting-v1-home-actions" aria-label="会议快捷操作">
              <button
                type="button"
                className="meeting-v1-home-action meeting-v1-home-action--primary"
                onClick={createMeeting}
                disabled={busy || !manager || encryptionState !== 'ready'}
              >
                <span className="meeting-v1-home-action__index" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 10v2a6 6 0 0 0 12 0v-2M12 18v3M8 21h8"/></svg></span>
                <span className="meeting-v1-home-action__copy"><strong>开始新会议</strong><small>记录现场讨论</small></span>
                <span className="meeting-v1-home-action__arrow" aria-hidden="true">进入</span>
              </button>
              <button
                type="button"
                className="meeting-v1-home-action meeting-v1-home-action--secondary"
                onClick={openImportMeeting}
                disabled={busy || !manager}
              >
                <span className="meeting-v1-home-action__index" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 16V3m-4 4 4-4 4 4M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/></svg></span>
                <span className="meeting-v1-home-action__copy"><strong>导入已有录音</strong><small>选择已有音频</small></span>
                <span className="meeting-v1-home-action__arrow" aria-hidden="true">打开</span>
              </button>
            </div>

            <section className="meeting-v1-recent-section" aria-labelledby="meeting-recent-heading">
              <div className="meeting-v1-list-heading">
                <h2 id="meeting-recent-heading">最近会议</h2>
                <span>本周 · {meetingsThisWeek(snapshot.meetings)} 场</span>
              </div>

              {snapshot.meetings.length ? (
                <div className="meeting-v1-meeting-list">
                  {snapshot.meetings.map((meeting) => {
                    const isActive = active?.meeting?.meetingId === meeting.meetingId;
                    const meetingView = isActive ? active.meeting : meeting;
                    const meetingAnalysisState = isActive ? activeAnalysisState : analysisStates[meeting.meetingId] || 'unavailable';
                    const listStatus = meetingListStatus(meetingView, meetingAnalysisState);
                    return (
                      <MeetingHistoryRow
                        key={meeting.meetingId}
                        meetingView={meetingView}
                        listStatus={listStatus}
                        isActive={isActive}
                        busy={busy}
                        formatDate={formatDate}
                        formatDuration={formatDuration}
                        analysisLabel={analysisListStateLabels[meetingAnalysisState] || '暂无分析'}
                        onOpen={openMeeting}
                        onDelete={deleteMeeting}
                        onRename={renameHistoricalMeeting}
                      />
                    );
                  })}
                </div>
              ) : <EmptyState>{snapshot.initialized ? '暂无历史会议，开始一场新的记录吧。' : '正在打开本地加密会议空间…'}</EmptyState>}
            </section>
          </section>
        </div>

        <div inert={renamePending} className={`meeting-future-punk__detail-panel min-w-0 grid gap-4 ${effectiveMobilePanel === 'list' ? 'max-[768px]:hidden' : ''} ${['draft', 'ready', 'recording', 'interrupted', 'finalization_pending'].includes(activeState) ? 'meeting-v1-detail-panel--recording' : ''}`}>
          {active ? (
            <>
              <section className="meeting-v2-detail-heading">
                <p className="meeting-v2-eyebrow">{formatDate(active.meeting.createdAt)} · {activeDuration}</p>
                <h2>{active.meeting.title}</h2>
                <div className="meeting-v2-view-switch" aria-label="会议内容">
                  {[['main', '录音与回听'], ['results', '整理结果'], ['materials', '原始资料']].map(([view, label]) => <button key={view} type="button" aria-pressed={effectiveDetailView === view} disabled={['recording', 'interrupted', 'finalization_pending'].includes(activeState) && view !== 'main'} onClick={() => showDetailView(view)}>{label}</button>)}
                </div>
              </section>
              <section className="meeting-v2-next-step" hidden={effectiveDetailView !== 'main' || !playbackPanelSource}>
                <div><h3>{analysisOperation.status === 'analyzing' ? '正在整理会议' : analysis ? '会议结果已保存' : analysisTranscriptRevision ? '录音已就绪，可以整理会议' : '原音已保存，先转成文字'}</h3><p>{analysisTranscriptRevision ? '先看摘要、决定和待办；随时可以回到原话。' : '在原始资料中完成转写后，再点击整理。'}</p></div>
                {analysisOperation.status === 'analyzing' || analysis ? <button type="button" onClick={() => showDetailView('results')}>查看整理结果</button> : analysisTranscriptRevision ? <button type="button" onClick={startAnalysisFromUi} disabled={busy || !manager?.analysis}>一键整理会议</button> : <button type="button" onClick={() => showDetailView('materials')}>录音转文字</button>}
              </section>
              <div className="meeting-future-punk__detail-layout">
                <div className="meeting-future-punk__main-slot">
              <Section title="会议会话" action={<StatusPill state={activeState} />} className="meeting-v1-session-section">
                <div className="meeting-v1-session-meta grid gap-3 text-sm text-[color:var(--secondary-text)] sm:grid-cols-3">
                  <div>创建：{formatDate(active.meeting.createdAt)}</div>
                  <div>已保存时长：{activeDuration}</div>
                  <div>已提交分段：{active.meeting.committedSegmentCount}</div>
                </div>
                <div className="meeting-v1-session-explainer mt-4 rounded-[12px] bg-[color:var(--input-background)] px-3 py-3 text-sm leading-6 text-[color:var(--secondary-text)]">
                  {activeState === 'recording' ? '正在使用设备麦克风。页面失活、来电或Safari挂起后会先保存已完成分段，再标记为中断。' : null}
                  {activeState === 'interrupted' ? '录音已中断，已完成分段仍保存在本地。请明确点击“继续录音”，系统不会自动恢复。' : null}
                  {activeState === 'finalization_pending' ? `已安全保存至 ${activeDuration}，最后尾段待封存；可再次点击“结束并保存”完成封存。` : null}
                  {activeState === 'stopped' ? '本场会议已停止，不能继续向原会话写入。' : null}
                  {activeState === 'failed_retryable' ? `上次操作未完成（${active.meeting.errorCode || '可重试错误'}），可重试或重新打开会议。` : null}
                  {['draft', 'ready'].includes(activeState) ? '点击开始后，只有真实MediaRecorder启动成功才会显示正在录音。' : null}
                </div>
                {recordingExperience ? <div className="mt-4 meeting-v1-recording-mount"><MeetingRecordingExperience experience={recordingExperience} /></div> : null}
              </Section>

              <Section
                title="音频来源"
                className="meeting-v2-materials"
              >
                <div className="grid min-w-0 gap-3">
                  <div className="rounded-[12px] bg-[color:var(--input-background)] px-3 py-3 text-xs leading-5 text-[color:var(--secondary-text)]" role="status">
                    {transcriptionSnapshot.provider?.sourceAvailable === true ? '转写服务已就绪；只有点击“录音转文字”后才会上传当前音频。' : '转写服务暂时不可用；原音仍可回听，服务恢复后可继续转写。'}
                  </div>
                  {audioImport.importState !== 'idle' && audioImport.importState !== 'committed' ? (
                    <div className="min-w-0 rounded-[12px] border border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 py-3" role="status">
                      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 truncate text-[color:var(--primary-text)]">{audioImport.fileName || '音频文件'}</span>
                        <span className="text-xs text-[color:var(--accent-color)]">{importStateLabels[audioImport.importState] || audioImport.importState}</span>
                      </div>
                      {['validating', 'importing'].includes(audioImport.importState) ? (
                        <>
                          <div className="mt-3 h-2 overflow-hidden rounded-full bg-[color:var(--border-color)]" aria-label="导入进度"><div className="h-full rounded-full bg-[color:var(--accent-color)] transition-all" style={{ width: `${audioImport.progress?.percent || 0}%` }} /></div>
                          <div className="mt-2 text-xs text-[color:var(--secondary-text)]">{audioImport.importState === 'validating' ? '正在检查格式、文件头和时长…' : `已完成 ${audioImport.progress?.percent || 0}%`}</div>
                          <button type="button" className="mt-3 min-h-11 rounded-[12px] border border-[color:var(--border-color)] px-3 text-sm font-medium text-[color:var(--primary-text)] disabled:opacity-50" onClick={cancelAudioImport} disabled={!importBusy}>取消导入</button>
                        </>
                      ) : null}
                      {audioImport.requiresReselect ? <p className="mt-2 text-sm leading-6 text-[#8a3d32]">{audioImportMessage(audioImport) || '请重新选择同一文件。'}</p> : null}
                      {audioImportMessage(audioImport) && !audioImport.requiresReselect ? <p className="mt-2 text-sm leading-6 text-[#8a3d32]">{audioImportMessage(audioImport)}</p> : null}
                      {['failed_retryable', 'cancelled', 'rejected'].includes(audioImport.importState) ? <button type="button" className="mt-3 min-h-11 rounded-[12px] border border-[color:var(--border-color)] px-3 text-sm font-medium text-[color:var(--primary-text)]" onClick={chooseAudioFile} disabled={busy}>重新选择同一文件并重试</button> : null}
                    </div>
                  ) : null}

                  {active.audioSources?.length ? active.audioSources.map((source) => {
                    const job = [...(transcriptionSnapshot.jobs || [])].reverse().find((item) => item.sourceId === source.sourceId && item.sourceRevision === source.revision);
                    const transcriptReady = transcripts[source.sourceId]?.transcript?.document?.status === 'ready';
                    const sourceTranscript = transcripts[source.sourceId]?.transcript;
                    const diarizationJob = [...(diarizationSnapshot.jobs || [])].reverse().find((item) => item.sourceId === source.sourceId && item.sourceRevision === source.revision);
                    const diarizationView = diarizations[source.sourceId]?.revision;
                    const starting = transcriptionStartingSourceId === source.sourceId;
                    const running = ['queued', 'preparing', 'transcribing', 'stitching'].includes(job?.status);
                    const progressActive = starting || running;
                    const percent = starting ? 0 : transcriptionProgress(job);
                    const progressLabel = starting ? '正在准备' : ({uploading:'正在上传录音',recognizing:'正在识别文字',saving:'正在保存文字',ready:'录音转文字完成'})[job?.progress?.phase] || transcriptionStateLabels[job?.status] || '正在准备';
                    const diarizationRunning = ['queued', 'preparing', 'diarizing', 'stitching'].includes(diarizationJob?.status);
                    const resumable = ['failed_retryable', 'paused_retryable', 'failed_terminal'].includes(job?.status);
                    const transcriptionSourceReady = transcriptionSnapshot.provider?.sourceAvailable === true;
                    return (
                      <div key={source.sourceId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-[12px] border border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 py-3">
                        <div className="min-w-0 flex-1 text-sm">
                          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[color:var(--primary-text)]"><span>{source.origin === 'recorded' ? '现场录音' : '导入音频'}</span><span className="text-xs text-[color:var(--accent-color)]">{audioFormatLabels[source.format] || source.format}</span></div>
                          <div className="mt-1 min-w-0 truncate text-xs text-[color:var(--secondary-text)]">{source.originalFileName || '本地音频'} · {formatDuration(source.durationMs)} · {source.byteLength} bytes · 保留至 {formatDate(source.retentionExpiresAt)}</div>
                          {progressActive || job?.status === 'ready' ? (
                            <div className={`meeting-transcription-progress${progressActive ? ' meeting-transcription-progress--active' : ''}`} aria-busy={progressActive}>
                              <div role="status"><span>{progressLabel}</span> <strong className="meeting-transcription-progress__percent">{percent}%</strong></div>
                              <div className="meeting-transcription-progress__track" role="progressbar" aria-label="录音转文字进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${progressLabel} ${percent}%`}><div style={{width:`${percent}%`}} /></div>
                            </div>
                          ) : <div className="mt-2 text-xs text-[color:var(--secondary-text)]">{job ? transcriptionStateLabels[job.status] || job.status : '尚未转成文字'}</div>}
                          {job?.errorCode ? <div className="mt-1 text-xs leading-5 text-[#8a3d32]">{transcriptionErrorMessage(job)}</div> : null}
                          {diarizationJob ? <div className="mt-2 text-xs text-[color:var(--accent-color)]">{diarizationStateLabels[diarizationJob.status] || diarizationJob.status}</div> : null}
                          {diarizationJob?.errorCode ? <div className="mt-1 text-xs leading-5 text-[#8a3d32]">{transcriptionErrorMessage(diarizationJob)}</div> : null}
                        </div>
                        <div className="flex min-w-0 flex-wrap justify-end gap-2">
                          {running ? <button type="button" className="min-h-11 whitespace-nowrap rounded-[12px] border border-[color:var(--border-color)] px-3 text-sm font-medium text-[color:var(--primary-text)] disabled:cursor-not-allowed disabled:opacity-50" onClick={() => cancelTranscription(job.jobId)} disabled={busy || importBusy}>取消转写</button> : null}
                          {resumable ? <button type="button" className="meeting-transcription-resume-button min-h-11 whitespace-nowrap rounded-[12px] border border-[color:var(--accent-color)] px-3 text-sm font-semibold text-[color:var(--accent-color)] disabled:cursor-not-allowed disabled:opacity-50" onClick={() => resumeTranscription(source.sourceId)} disabled={busy || importBusy || !transcriptionSourceReady} aria-busy={busy || importBusy} aria-disabled={!transcriptionSourceReady}>{busy || importBusy ? '正在恢复…' : '继续转写'}</button> : null}
                          {!running && !resumable && job?.status !== 'ready' ? <button type="button" className="meeting-transcription-start-button min-h-11 whitespace-nowrap rounded-[12px] px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50" onClick={() => startTranscription(source.sourceId)} disabled={busy || importBusy || !manager?.transcription || !transcriptionSourceReady} aria-disabled={!transcriptionSourceReady}>{transcriptionSourceReady ? '录音转文字' : '转写暂不可用'}</button> : null}
                          {diarizationRunning ? <button type="button" className="min-h-11 whitespace-nowrap rounded-[12px] border border-[color:var(--border-color)] px-3 text-sm font-medium text-[color:var(--primary-text)] disabled:cursor-not-allowed disabled:opacity-50" onClick={() => cancelDiarization(diarizationJob.jobId)} disabled={busy || importBusy}>取消说话人识别</button> : null}
                          {!diarizationRunning && !diarizationJob && transcriptReady && !diarizationView && diarizationSnapshot.provider?.diarizationAvailable === true ? <button type="button" className="min-h-11 whitespace-nowrap rounded-[12px] border border-[color:var(--accent-color)] px-3 text-sm font-semibold text-[color:var(--accent-color)] disabled:cursor-not-allowed disabled:opacity-50" onClick={() => startDiarization(source, sourceTranscript)} disabled={busy || importBusy || !manager?.diarization}>识别匿名说话人</button> : null}
                          {source.origin === 'imported' && !transcriptReady ? <button type="button" className="min-h-11 min-w-[88px] whitespace-nowrap rounded-[12px] border border-[color:var(--danger-color)] bg-[color:var(--surface-background)] px-3 text-sm font-semibold text-[color:var(--danger-color)] shadow-sm transition-colors hover:bg-[color:var(--accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent-color)] disabled:cursor-not-allowed disabled:opacity-50" style={{ color: 'var(--danger-color)' }} onClick={() => deleteAudioSource(source.sourceId)} aria-label="删除音频" disabled={busy || importBusy}>删除音频</button> : null}
                          {transcriptReady ? <button type="button" className="meeting-transcript-delete-original-button min-h-11 min-w-[112px] whitespace-nowrap rounded-[12px] border border-[color:var(--danger-color)] bg-[color:var(--surface-background)] px-3 text-sm font-semibold text-[color:var(--danger-color)] shadow-sm transition-colors hover:bg-[color:var(--accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent-color)] disabled:cursor-not-allowed disabled:opacity-50" onClick={() => deleteOriginalAudio(source.sourceId)} aria-label="删除原录音" disabled={busy || importBusy}>删除原录音</button> : null}
                        </div>
                      </div>
                    );
                  }) : <EmptyState>还没有音频来源。可导入 M4A、AAC、MP3、WAV 或 WebM/Opus；原始音频默认保留30天。</EmptyState>}
                </div>
              </Section>

              {playbackPanelSource ? (
                <MeetingPlaybackPanel
                  source={playbackPanelSource}
                  transcript={playbackTranscript?.transcript || null}
                  diarizationRevision={playbackDiarizationRevision}
                  speakerCorrectionManager={manager?.speakerCorrection}
                  playback={manager?.playback}
                  evidenceTarget={evidenceTarget}
                  afterPlayback={analysisPanel}
                />
              ) : null}

              {!playbackPanelSource ? analysisPanel : null}

              {activeTranscripts.length ? (
                <Section title="原始文字校正" className="meeting-v2-materials">
                  <div className="grid min-w-0 gap-4">
                    {activeTranscripts.map(({ source, transcript, mode }) => (
                      <div key={source.sourceId} className="grid min-w-0 gap-3">
                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 text-xs text-[color:var(--secondary-text)]">
                              <span>{source.originalFileName || '本地音频'} · 当前 revision {transcript.document.transcriptRevision}</span>
                              <span>原始内容已保留，可继续校正</span>
                            </div>
                            {mode === 'transcript_only' ? <div className="meeting-transcript-only-notice rounded-[12px] px-3 py-2 text-sm leading-6" role="status">原始音频已不可用，已保存的转写内容仍可继续查看和编辑。</div> : null}
                            <div className="grid min-w-0 gap-2">
                          {(transcriptsExpanded[source.sourceId] ? transcript.currentRevision.segments : transcript.currentRevision.segments.slice(0, 3)).map((segment) => (
                            <div key={segment.segmentId} className="grid min-w-0 gap-2 rounded-[12px] border border-[color:var(--border-color)] bg-[color:var(--input-background)] p-3 sm:grid-cols-[96px_minmax(0,1fr)_auto] sm:items-start">
                              <span className="text-xs font-medium text-[color:var(--accent-color)]" aria-label={`时间戳 ${formatTranscriptTime(segment.startMs)}`}>[{formatTranscriptTime(segment.startMs)}]</span>
                              <textarea
                                className="min-h-11 min-w-0 resize-y rounded-[10px] border border-[color:var(--border-color)] bg-[color:var(--surface-background)] px-2 py-2 text-sm leading-6 text-[color:var(--primary-text)] outline-none focus:border-[color:var(--accent-color)]"
                                value={transcriptDrafts[segment.segmentId] ?? segment.text}
                                onChange={(event) => setTranscriptDrafts((current) => ({ ...current, [segment.segmentId]: event.target.value }))}
                                aria-label={`编辑 ${formatTranscriptTime(segment.startMs)} 的转写`}
                                disabled={busy}
                              />
                              <button type="button" className="meeting-transcript-save-button min-h-11 whitespace-nowrap rounded-[12px] border border-[color:var(--accent-color)] px-3 text-sm font-semibold text-[color:var(--accent-color)] disabled:cursor-not-allowed disabled:opacity-50" onClick={() => saveTranscriptCorrection(source.sourceId, segment, transcript)} disabled={busy}>保存修改</button>
                            </div>
                          ))}
                        </div>
                        {transcript.currentRevision.segments.length > 3 ? <button type="button" className="meeting-transcript-expand-button meeting-playback-panel__button" aria-expanded={Boolean(transcriptsExpanded[source.sourceId])} onClick={() => setTranscriptsExpanded(current => ({...current, [source.sourceId]: !current[source.sourceId]}))}>{transcriptsExpanded[source.sourceId] ? '收起原始文字' : `展开全部原始文字（${transcript.currentRevision.segments.length}）`}</button> : null}
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}

                </div>

                <div className="meeting-future-punk__context-slot">

              {activeDiarizedTranscripts.length ? (
                <Section title="说话人管理">
                  <div className="grid min-w-0 gap-4">
                    {activeDiarizedTranscripts.map(({ source, transcript, diarization }) => (
                      <div
                        key={`${transcript.document.meetingId}:${transcript.document.transcriptId}:${transcript.document.transcriptRevision}:${diarization.revision.diarizationRevisionId}`}
                        className="grid min-w-0 gap-2"
                      >
                        <div className="text-xs text-[color:var(--secondary-text)]">{source.originalFileName || '本地音频'}</div>
                        <SpeakerManagementPanel
                          speakerCorrectionManager={manager.speakerCorrection}
                          meetingId={transcript.document.meetingId}
                          transcriptId={transcript.document.transcriptId}
                        />
                      </div>
                    ))}
                  </div>
                </Section>
              ) : null}

              <Section title="本地录音分段">
                {active.segments.length ? (
                  <>
                  <div className="grid gap-2">
                    {(segmentsExpanded ? active.segments : active.segments.slice(0, 3)).map((segment) => (
                      <div key={segment.segmentId} className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-[color:var(--border-color)] bg-[color:var(--input-background)] px-3 py-3 text-sm">
                        <span className="text-[color:var(--primary-text)]">第 {segment.sequence + 1} 段</span>
                        <span className="text-xs text-[color:var(--secondary-text)]">{formatDuration(segment.durationMs)} · {segment.byteLength} bytes · 已加密提交</span>
                      </div>
                    ))}
                  </div>
                  {active.segments.length > 3 ? (
                    <button
                      type="button"
                      className="meeting-v1-segment-toggle"
                      aria-expanded={segmentsExpanded}
                      onClick={() => setSegmentsExpanded((current) => !current)}
                    >
                      {segmentsExpanded ? '收起分段' : `展开全部分段（${active.segments.length}）`}
                    </button>
                  ) : null}
                  </>
                ) : <EmptyState>还没有已提交分段。音频不会以明文写入本地存储。</EmptyState>}
              </Section>
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
      )}

    </div>
  );
}

export default MeetingCenter;
