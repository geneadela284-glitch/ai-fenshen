import GameBoundary from './games/GameBoundary.jsx';
import { useVoiceChat } from './voiceChat/useVoiceChat.js';
import VoiceChatPanel from './voiceChat/VoiceChatPanel.jsx';
import { GAMES_ENABLED } from './games/feature.js';
import { gameIntent } from './games/intent.js';
import LearningView from './learning/LearningView.jsx';
import { LEARNING_ENABLED } from './learning/learningFeature.js';
import { learningIntent } from './learning/client.js';
import './responsiveNavigation.css';
import HealthView from './HealthView.jsx';
import { HEALTH_ENABLED } from './healthFeature.js';
import DiaryView from './DiaryView.jsx';
import { DIARY_ENABLED } from './diaryFeature.js';
import { useDocumentQa, DocumentQaContext, documentErrorText } from './useDocumentQa.js';
import { decodeDocumentMessage } from '../../../../../core/documentQa/contract.js';
import { collectMeetingEvidence } from '../../lib/meetingQueryReader.js';
import { lazy, Suspense, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, LazyMotion, domAnimation, useReducedMotion } from 'motion/react';
import { fetchCurrentSession, loginSession as loginAccount, logout as logoutAccount } from '../../lib/authClient.js';
import { acceptPrivacyConsent, fetchPrivacyConsent } from '../../lib/privacyClient.js';
import { createTasksClient, SAFE_TASKS_ERROR } from '../../lib/tasksClient.js';
import HomeAmbientScene from './HomeAmbientScene.jsx';
import ImmersiveChatView from './ImmersiveChatView.jsx';
import RealAccountLogin from './RealAccountLogin.jsx';
import RealSettingsView from './RealSettingsView.jsx';
import PrivacyConsentView from './PrivacyConsentView.jsx';
import FeaturePlaceholderView from './FeaturePlaceholderView.jsx';
import MemoryFeatureView from './MemoryFeatureView.jsx';
import FinanceView from './FinanceView.jsx';
import MeetingCenter from '../../components/MeetingCenter.jsx';
import ThemeProvider from './ThemeProvider.jsx';
import { createRealConversationClient } from './realConversationClient.js';
import { createAccountWorkspaceTransition } from './accountSessionBoundary.js';
import { createAttachmentClient } from './attachmentClient.js';
import { readMeetingRouteRecoveryForOwner } from '../../lib/meetingRouteRecoveryUi.js';
import {
  addSelectedImages,
  attachmentSelectionErrorMessage,
  releaseAttachmentPreviews,
  removeSelectedImage
} from './imageAttachmentSelection.js';
import { applyRealConversationEvent, createOptimisticExchange, findRetryExchange, restoreConversationMessages } from './realConversationState.js';
import { NEW_CONVERSATION_MARKER, selectRestorableConversation } from './realConversationSelection.js';
import {
  createInitialPrototypeState,
  getMotionDuration,
  prototypeReducer,
  resolveThemeMode,
  themeIdForMode
} from './prototypeState.js';
import useStableVisualViewport from './useStableVisualViewport.js';
import { getFeature } from './featureRegistry.js';
import { createHomeTasksState, reduceHomeTasksState } from './homeTasksState.js';
import {
  markFeatureIntroVersionSkipped,
  markFeatureIntroVersionCompleted,
  markDailyFeatureIntroHandled,
  resolveFeatureIntroPresentation
} from './homeBubbleExperience.js';
import { FEATURE_INTRO_VERSION } from './homeFeatureIntro.js';
import { useDictation } from './useDictation.js';
import './aiFenshenPrototype.css';

const GamesView = lazy(() => import('./games/GamesView.jsx'));

const SAFE_ERROR = 'AI服务暂时不可用，请稍后重试。';
const BUSY_STATES = new Set(['sending', 'streaming', 'stopping']);
const THEME_PREFERENCES = new Set(['auto', 'day', 'night']);

function requiresAccountReset(error) {
  return error?.code === 'AUTH_REQUIRED' || error?.code === 'ACCOUNT_CONTEXT_MISMATCH';
}

function readThemePreferenceForUser(identity) {
  if (!identity) return 'auto';
  const stored = window.localStorage.getItem(`ai-fenshen:theme:v1:${identity}`);
  return THEME_PREFERENCES.has(stored) ? stored : 'auto';
}

function initialUiState() {
  return {
    ...createInitialPrototypeState('deep-blue'),
    appView: 'home',
    loginState: 'success',
    homeState: 'idle'
  };
}

function requestId() {
  return globalThis.crypto?.randomUUID?.() || `client_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export default function AIFenshenRealApp() {
  const accountResetRef = useRef(() => {});
  const [accountWorkspace] = useState(() => createAccountWorkspaceTransition({
    onReset: (change) => accountResetRef.current(change)
  }));
  const client = useMemo(() => createRealConversationClient({
    expectedAccountId: () => accountWorkspace.currentOwnerId()
  }), [accountWorkspace]);
  const attachmentClient = useMemo(() => createAttachmentClient(), []);
  const tasksClient = useMemo(() => createTasksClient(), []);
  const [state, dispatch] = useReducer(prototypeReducer, undefined, initialUiState);
  const [tasksState, dispatchTasks] = useReducer(reduceHomeTasksState, undefined, createHomeTasksState);
  const [tasksReloadKey, setTasksReloadKey] = useState(0);
  const [featureIntroPresentation, setFeatureIntroPresentation] = useState('hidden');
  const [themePreference, setThemePreference] = useState('auto');
  const [themeClock, setThemeClock] = useState(() => new Date());
  const [busyTaskId, setBusyTaskId] = useState('');
  const [taskActionError, setTaskActionError] = useState('');
  const [session, setSession] = useState({
    loading: true,
    user: null,
    featureFlags: { financeF201Enabled: false },
    error: ''
  });
  const [privacyConsent, setPrivacyConsent] = useState(null);
  const [attachmentCapability, setAttachmentCapability] = useState({ loading: true, enabled: false });
  const [selectedAttachments, setSelectedAttachments] = useState([]);
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState([]);
  const [conversationId, setConversationId] = useState(null);
  const meetingQueryOwnerRef = useRef(null);
  meetingQueryOwnerRef.current = session.user?.id || null;
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [featureView, setFeatureView] = useState('home');
  const [initialGame, setInitialGame] = useState('lobby');
  const [diaryEntryId, setDiaryEntryId] = useState(null);
  const [healthRecordId, setHealthRecordId] = useState(null);
  useEffect(() => {
    if (!HEALTH_ENABLED || !session.user || privacyConsent?.consent?.current !== true) return;
    const openHealth = () => {
      const match=window.location.hash.match(/^#health=([A-Za-z0-9_-]+)$/);
      if (!match) return;
      setHealthRecordId(match[1]); setFeatureView('health');
      dispatch({type:'EXIT_CHAT'}); dispatch({type:'CHAT_EXITED'}); dispatch({type:'CLOSE_BRAIN'});
    };
    openHealth();window.addEventListener('hashchange',openHealth);
    return ()=>window.removeEventListener('hashchange',openHealth);
  },[session.user?.id,privacyConsent?.consent?.current]);
  useEffect(() => {
    if (!DIARY_ENABLED || !session.user || privacyConsent?.consent?.current !== true) return;
    const openDiary = () => {
      const match = window.location.hash.match(/^#diary=([A-Za-z0-9_-]+)$/);
      if (!match) return;
      setDiaryEntryId(match[1]); setFeatureView('memory');
      dispatch({type:'EXIT_CHAT'});
      dispatch({type:'CHAT_EXITED'});
      dispatch({type:'CLOSE_BRAIN'});
    };
    openDiary(); window.addEventListener('hashchange', openDiary);
    return () => window.removeEventListener('hashchange',openDiary);
  },[session.user?.id,privacyConsent?.consent?.current]);
  useEffect(() => {
    if (!DIARY_ENABLED || !session.user) return;
    const refresh = () => { if (document.visibilityState !== 'hidden') setTasksReloadKey(value=>value+1); };
    const timer = window.setInterval(refresh,60000);
    window.addEventListener('focus',refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus',refresh); };
  },[session.user?.id]);
  const [meetingRouteRecovery, setMeetingRouteRecovery] = useState(null);
  const canvasRef = useRef(null);
  const activeRequestRef = useRef(null);
  const submissionLockRef = useRef(null);
  const pendingSendRef = useRef(null);
  const selectedAttachmentsRef = useRef([]);
  const toastTimerRef = useRef(null);
  const reducedMotion = Boolean(useReducedMotion());
  const duration = getMotionDuration(reducedMotion);
  const browserTimezone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone || '', []);
  const userTimezone = browserTimezone || 'Asia/Shanghai';
  const documentRequestRefs = useRef(new Map());
  const documentQa = useDocumentQa({ ownerId: session.user?.id || null, conversationId,
    onInvalidate: () => { if (activeRequestRef.current?.documentToken) void stopGeneration(); },
    onSelected: () => { setDraft(current => current || '请概括这份文件的主要内容。'); }
  });
  useStableVisualViewport(canvasRef);

  const storageKey = session.user?.id ? `ai-fenshen-real-current:${session.user.id}` : '';
  const themeStorageKey = session.user?.id ? `ai-fenshen:theme:v1:${session.user.id}` : '';
  const themeMode = useMemo(() => resolveThemeMode({
    preference: themePreference,
    now: themeClock,
    timeZone: browserTimezone,
    systemPrefersDark: window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  }), [browserTimezone, themeClock, themePreference]);
  const themeId = themeIdForMode(themeMode);

  useEffect(() => {
    selectedAttachmentsRef.current = selectedAttachments;
  }, [selectedAttachments]);

  useEffect(() => () => {
    releaseAttachmentPreviews(selectedAttachmentsRef.current);
  }, []);

  useEffect(() => {
    if (!themeStorageKey) {
      setThemePreference('auto');
      return;
    }
    setThemePreference(readThemePreferenceForUser(session.user?.id));
  }, [session.user?.id, themeStorageKey]);

  useEffect(() => {
    if (themePreference !== 'auto') return undefined;
    const current = new Date();
    const nextMinute = 60_000 - ((current.getSeconds() * 1_000) + current.getMilliseconds());
    const timer = window.setTimeout(() => setThemeClock(new Date()), nextMinute);
    return () => window.clearTimeout(timer);
  }, [themeClock, themePreference]);

  useEffect(() => {
    let cancelled = false;
    fetchCurrentSession().then(async ({ user, featureFlags }) => {
      const privacy = user ? await fetchPrivacyConsent() : null;
      if (!cancelled) {
        accountWorkspace.transitionTo(user?.id || null);
        setThemePreference(readThemePreferenceForUser(user?.id));
        setPrivacyConsent(privacy);
        setSession({ loading: false, user, featureFlags, error: '' });
      }
    }).catch(() => {
      if (!cancelled) {
        accountWorkspace.transitionTo(null);
        setSession({ loading: false, user: null, error: '请使用现有账号登录。' });
      }
    });
    return () => { cancelled = true; };
  }, [accountWorkspace]);

  useEffect(() => {
    if (!session.user?.id) return undefined;
    const recovery = readMeetingRouteRecoveryForOwner(session.user.id);
    if (!recovery) return undefined;
    setMeetingRouteRecovery(recovery);
    setFeatureView('meeting');
    dispatch({ type: 'CLOSE_BRAIN' });
    return undefined;
  }, [session.user?.id]);

  useEffect(() => {
    if (!session.user || privacyConsent?.consent?.current !== true) {
      setAttachmentCapability({ loading: false, enabled: false });
      return undefined;
    }
    let cancelled = false;
    const accountToken = accountWorkspace.capture();
    setAttachmentCapability({ loading: true, enabled: false });
    attachmentClient.getCapabilities()
      .then((capability) => {
        if (!cancelled) accountWorkspace.commit(accountToken, () => {
          setAttachmentCapability({ loading: false, enabled: capability.enabled === true });
        });
      })
      .catch((caught) => {
        if (cancelled || !accountWorkspace.isCurrent(accountToken)) return;
        if (requiresAccountReset(caught)) expireSession();
        else setAttachmentCapability({ loading: false, enabled: false });
      });
    return () => { cancelled = true; };
  }, [accountWorkspace, attachmentClient, privacyConsent?.consent?.current, session.user]);

  useEffect(() => {
    if (!session.user || privacyConsent?.consent?.current !== true) {
      dispatchTasks({ type: 'loading' });
      return undefined;
    }
    let cancelled = false;
    const controller = new AbortController();
    const accountToken = accountWorkspace.capture();
    dispatchTasks({ type: 'loading' });
    setTaskActionError('');
    tasksClient.getTodayTomorrow({ timezone: userTimezone, signal: controller.signal })
      .then((payload) => {
        if (!cancelled) accountWorkspace.commit(accountToken, () => dispatchTasks({ type: 'loaded', payload }));
      })
      .catch((caught) => {
        if (cancelled || caught?.name === 'AbortError' || !accountWorkspace.isCurrent(accountToken)) return;
        if (requiresAccountReset(caught)) {
          expireSession();
          return;
        }
        accountWorkspace.commit(accountToken, () => {
          dispatchTasks({ type: 'failed', error: caught?.message || SAFE_TASKS_ERROR });
        });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    accountWorkspace,
    privacyConsent?.consent?.current,
    session.user,
    tasksClient,
    tasksReloadKey,
    userTimezone
  ]);

  useEffect(() => {
    if (!session.user || !storageKey || privacyConsent?.consent?.current !== true) return undefined;
    let cancelled = false;
    const accountToken = accountWorkspace.capture();
    const restore = async () => {
      try {
        const conversations = await client.listConversations();
        const remembered = window.localStorage.getItem(storageKey);
        const selected = selectRestorableConversation(conversations, remembered);
        if (!selected || cancelled || !accountWorkspace.isCurrent(accountToken)) return;
        const restored = await client.loadMessages(selected.id);
        if (cancelled) return;
        accountWorkspace.commit(accountToken, () => {
          setConversationId(selected.id);
          setMessages(restoreConversationMessages(restored));
          window.localStorage.setItem(storageKey, selected.id);
        });
      } catch (caught) {
        if (cancelled || !accountWorkspace.isCurrent(accountToken)) return;
        if (requiresAccountReset(caught)) expireSession();
        else setError(SAFE_ERROR);
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, [accountWorkspace, client, privacyConsent?.consent?.current, session.user, storageKey]);

  useEffect(() => {
    if (!conversationId || !session.user || privacyConsent?.consent?.current !== true) return undefined;
    const terminalAttachmentStates = new Set([
      'processed',
      'processed_partial',
      'processing_failed',
      'failed',
      'expired',
      'deleted'
    ]);
    const needsRefresh = messages.some((message) => (
      message.status === 'streaming' ||
      (message.attachments || []).some((attachment) => (
        !terminalAttachmentStates.has(attachment.processingState)
      ))
    ));
    if (!needsRefresh || activeRequestRef.current) return undefined;
    let cancelled = false;
    let timer = null;
    const accountToken = accountWorkspace.capture();
    const refresh = async () => {
      try {
        const restored = await client.loadMessages(conversationId);
        if (!cancelled) accountWorkspace.commit(accountToken, () => setMessages(restoreConversationMessages(restored)));
      } catch (caught) {
        if (!cancelled && accountWorkspace.isCurrent(accountToken) && requiresAccountReset(caught)) expireSession();
      } finally {
        if (!cancelled && accountWorkspace.isCurrent(accountToken)) timer = window.setTimeout(refresh, 1500);
      }
    };
    timer = window.setTimeout(refresh, 1500);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [
    accountWorkspace,
    client,
    conversationId,
    messages,
    privacyConsent?.consent?.current,
    session.user
  ]);

  useEffect(() => () => {
    const active = activeRequestRef.current;
    if (!active) return;
    active.intentional = true;
    if (active.requestId) void client.cancelRequest(active.requestId).catch(() => {});
    active.controller.abort();
  }, [client]);

  useEffect(() => () => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
  }, []);

  const showToast = (message) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast(String(message || ''));
    toastTimerRef.current = window.setTimeout(() => {
      setToast('');
      toastTimerRef.current = null;
    }, 2000);
  };

  const {
    voiceState,
    voiceError,
    voiceDurationMs,
    voiceLevel,
    onVoice,
    onVoiceCancel
  } = useDictation({
    draft,
    onDraftChange: setDraft,
    busy: BUSY_STATES.has(state.composerState),
    showToast
  });

  const voiceChat = useVoiceChat({
    ownerId: session.user?.id, conversationId, featureView,
    enabled: Boolean(session.user?.id && accountWorkspace.isOwner(session.user.id)) && privacyConsent?.consent?.current === true && session.featureFlags?.voiceChatEnabled === true,
    onConversation: id => {
      if (!accountWorkspace.isOwner(session.user?.id)) return;
      setConversationId(id);
      if (storageKey) window.localStorage.setItem(storageKey, id);
    },
    onEvent: event => {
      if (!accountWorkspace.isOwner(session.user?.id)) return;
      const data = event.data || {};
      if (event.type === 'messages') setMessages(current => {
        const incoming = restoreConversationMessages(data.messages);
        const ids = new Set(incoming.map(m => m.id));
        return [...current.filter(m => !ids.has(m.id)), ...incoming];
      });
      if (event.type === 'delta') setMessages(current => current.map(m => m.id === data.messageId ? { ...m, content: m.content + data.text, status: 'streaming' } : m));
      if (event.type === 'completed') setMessages(current => current.map(m => m.id === data.messageId ? { ...m, content: data.content, status: data.status === 'completed' ? 'complete' : data.status } : m));
      if (event.type === 'interrupted') setMessages(current => current.map(m => m.id === data.messageId ? { ...m, status: m.status === 'streaming' ? 'stopped' : m.status, voiceDelivery: { status: 'interrupted' } } : m));
    }
  });
  const openVoiceChat = session.featureFlags?.voiceChatEnabled === true ? () => {
    if (BUSY_STATES.has(state.composerState) || selectedAttachmentsRef.current.length || documentQa.session.current) return;
    onVoiceCancel();
    voiceChat.open();
  } : undefined;

  const resetAccountWorkspace = () => {
    voiceChat.end();
    onVoiceCancel();
    const active = activeRequestRef.current;
    if (active) {
      active.intentional = true;
      active.controller.abort();
      activeRequestRef.current = null;
    }
    submissionLockRef.current = null;
    pendingSendRef.current = null;
    documentRequestRefs.current.clear();
    documentQa.clear();
    releaseAttachmentPreviews(selectedAttachmentsRef.current);
    selectedAttachmentsRef.current = [];
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = null;
    setSelectedAttachments([]);
    setDraft('');
    setMessages([]);
    setConversationId(null);
    setError('');
    setToast('');
    setPrivacyConsent(null);
    setAttachmentCapability({ loading: false, enabled: false });
    setMeetingRouteRecovery(null);
    setFeatureView('home');
    setFeatureIntroPresentation('hidden');
    setThemePreference('auto');
    setBusyTaskId('');
    setTaskActionError('');
    dispatchTasks({ type: 'loading' });
    dispatch({ type: 'RESET_ACCOUNT_CONTEXT' });
  };
  accountResetRef.current = resetAccountWorkspace;

  const expireSession = () => {
    accountWorkspace.transitionTo(null);
    setSession({ loading: false, user: null, error: '登录已过期，请重新登录。' });
  };

  const runStream = async ({ content, clientRequestId, attachmentIds = [], retry = false }) => {
    const accountToken = accountWorkspace.capture();
    const controller = new AbortController();
    const active = { controller, clientRequestId, requestId: '', intentional: false, accountToken };
    activeRequestRef.current = active;
    dispatch({ type: 'SET_COMPOSER_STATE', value: 'sending' });
    setError('');
    let terminalEvent = false;
    try {
      const queryOwner = session.user;
      let targetConversationId = conversationId;
      let documentQuery = null;
      const currentDocument = documentQa.session.current;
      const previousDocument = documentRequestRefs.current.get(clientRequestId);
      if (retry && previousDocument && (!currentDocument || previousDocument.documentId !== currentDocument.record.documentId || previousDocument.revision !== currentDocument.record.revision)) {
        throw Object.assign(new Error('DOCUMENT_CONTEXT_INVALID'), { code: 'DOCUMENT_CONTEXT_INVALID' });
      }
      if (currentDocument && !attachmentIds.length) {
        active.documentToken = documentQa.session.token();
        if (!targetConversationId) {
          const created = await client.createConversation();
          if (controller.signal.aborted || !accountWorkspace.isCurrent(accountToken) || !documentQa.session.isCurrent(active.documentToken)) throw new DOMException('Cancelled', 'AbortError');
          targetConversationId = created.id; documentQa.session.bindConversation(created.id); setConversationId(created.id);
        }
        documentQuery = await documentQa.forQuery({ conversationId: targetConversationId, question: content });
        if (!retry) documentRequestRefs.current.set(clientRequestId, { documentId: currentDocument.record.documentId, revision: currentDocument.record.revision });
      }
      const meetingQuery = attachmentIds.length || documentQuery ? null : await collectMeetingEvidence({
        user: queryOwner, question: content, timezone: userTimezone, signal: controller.signal
      });
      if (controller.signal.aborted || activeRequestRef.current !== active || !accountWorkspace.isCurrent(accountToken) || meetingQueryOwnerRef.current !== queryOwner?.id) {
        throw new DOMException('Request cancelled', 'AbortError');
      }
      await client.streamMessage({
        conversationId: targetConversationId,
        documentQuery,
        message: content,
        meetingQuery,
        clientRequestId,
        attachmentIds,
        retry,
        timezone: userTimezone,
        signal: controller.signal,
        onEvent: (event) => {
          if (active.intentional || controller.signal.aborted || activeRequestRef.current !== active || !accountWorkspace.isCurrent(accountToken) || meetingQueryOwnerRef.current !== queryOwner?.id || (active.documentToken && !documentQa.session.isCurrent(active.documentToken))) return;
          if (event.type === 'started') {
            active.requestId = event.data.requestId;
            setConversationId(event.data.conversationId);
            if (storageKey) window.localStorage.setItem(storageKey, event.data.conversationId);
            dispatch({ type: 'SET_COMPOSER_STATE', value: 'streaming' });
          }
          setMessages((current) => applyRealConversationEvent(current, event, clientRequestId));
          if (event.type === 'completed') {
            terminalEvent = true;
            dispatch({ type: 'SET_COMPOSER_STATE', value: 'completed' });
          } else if (event.type === 'stopped') {
            terminalEvent = true;
            dispatch({ type: 'SET_COMPOSER_STATE', value: 'stopped' });
          } else if (event.type === 'error') {
            terminalEvent = true;
            setError(documentQuery ? '文件回答未完成，请重试。' : SAFE_ERROR);
            dispatch({ type: 'SET_COMPOSER_STATE', value: 'error' });
          }
        }
      });
      if (!terminalEvent && !active.intentional) throw new Error('STREAM_ENDED_WITHOUT_TERMINAL_EVENT');
    } catch (caught) {
      if (active.intentional || caught?.name === 'AbortError') return;
      if (requiresAccountReset(caught)) {
        expireSession();
        return;
      }
      accountWorkspace.commit(accountToken, () => {
        setMessages((current) => applyRealConversationEvent(current, {
          type: 'error', data: { requestId: active.requestId, code: caught?.code || 'NETWORK_ERROR' }
        }, clientRequestId));
        setError(String(caught?.code || '').startsWith('DOCUMENT_') ? documentErrorText(caught.code) : SAFE_ERROR);
        dispatch({ type: 'SET_COMPOSER_STATE', value: 'error' });
      });
    } finally {
      if (activeRequestRef.current === active) activeRequestRef.current = null;
    }
  };

  const uploadAttachments = async (queue, clientRequestId, accountToken) => {
    if (!queue.length) return [];
    if (!attachmentCapability.enabled) {
      const unavailable = new Error('图片功能当前未启用。');
      unavailable.code = 'ATTACHMENT_FEATURE_DISABLED';
      throw unavailable;
    }
    if (!accountWorkspace.commit(accountToken, () => {
      setSelectedAttachments((current) => current.map((item) => (
        queue.some((queued) => queued.id === item.id)
          ? { ...item, status: 'uploading', error: '' }
          : item
      )));
    })) throw new DOMException('Account changed', 'AbortError');
    const result = await attachmentClient.upload({
      files: queue.map((item) => item.file),
      conversationId,
      clientRequestId: `${clientRequestId}:upload`
    });
    if (!accountWorkspace.isCurrent(accountToken)) throw new DOMException('Account changed', 'AbortError');
    const uploaded = (result.attachments || []).map((attachment, index) => {
      const original = queue[index];
      return {
        ...original,
        attachmentId: attachment.attachmentId,
        originalFilename: attachment.originalFilename || original.name,
        mimeType: attachment.mimeType || original.mimeType,
        size: attachment.byteSize || original.size,
        processingState: attachment.processingState || 'ready_for_processing',
        status: attachment.processingState || 'ready_for_processing',
        previewUrl: attachmentClient.contentUrl(attachment.attachmentId)
      };
    });
    if (uploaded.length !== queue.length) {
      const incomplete = new Error('图片上传未完整完成，请重试。');
      incomplete.code = 'UPLOAD_FAILED';
      throw incomplete;
    }
    releaseAttachmentPreviews(queue);
    accountWorkspace.commit(accountToken, () => setSelectedAttachments([]));
    return uploaded;
  };

  const startGeneration = async (value, requestedAttachments = selectedAttachmentsRef.current) => {
    const content = String(value || '').trim();
    const accountToken = accountWorkspace.capture();
    if (documentQa.state.state === 'parsing') { showToast('文件正在读取，请稍候'); return; }
    if (!accountWorkspace.isOwner(session.user?.id) || !content || BUSY_STATES.has(state.composerState) || submissionLockRef.current) return;
    if (GAMES_ENABLED && gameIntent(content) && !requestedAttachments?.length && !documentQa.session.current) { setInitialGame(gameIntent(content)); setFeatureView('games'); dispatch({ type: 'CLOSE_BRAIN' }); return; }
    if (LEARNING_ENABLED && learningIntent(content) && !requestedAttachments?.length && !documentQa.session.current) { setFeatureView('learning'); dispatch({ type: 'CLOSE_BRAIN' }); return; }
    const queue = Array.isArray(requestedAttachments) ? requestedAttachments : [];
    const clientRequestId = queue.find((item) => item.clientRequestId)?.clientRequestId || requestId();
    const submissionLock = { accountToken, clientRequestId };
    submissionLockRef.current = submissionLock;
    if (queue.length) {
      setSelectedAttachments((current) => current.map((item) => (
        queue.some((queued) => queued.id === item.id)
          ? { ...item, clientRequestId }
          : item
      )));
    }
    dispatch({ type: 'SET_COMPOSER_STATE', value: 'sending' });
    setError('');
    try {
      const uploaded = await uploadAttachments(queue, clientRequestId, accountToken);
      if (!accountWorkspace.isCurrent(accountToken)) throw new DOMException('Account changed', 'AbortError');
      const attachmentIds = uploaded.map((item) => item.attachmentId);
      setMessages((current) => createOptimisticExchange(current, {
        content,
        clientRequestId,
        attachments: uploaded
      }));
      await runStream({ content, clientRequestId, attachmentIds });
    } catch (caught) {
      if (caught?.name === 'AbortError' || !accountWorkspace.isCurrent(accountToken)) return;
      if (requiresAccountReset(caught)) {
        expireSession();
        return;
      }
      setSelectedAttachments((current) => current.map((item) => (
        queue.some((queued) => queued.id === item.id)
          ? {
              ...item,
              clientRequestId,
              status: 'failed',
              error: caught?.code || 'UPLOAD_FAILED'
            }
          : item
      )));
      setDraft(content);
      setError(caught?.message || '图片暂时无法上传，请重试。');
      dispatch({ type: 'SET_COMPOSER_STATE', value: 'error' });
    } finally {
      if (submissionLockRef.current === submissionLock) submissionLockRef.current = null;
    }
  };

  useEffect(() => {
    if (state.chatTransitionState === 'active' && pendingSendRef.current) {
      const pending = pendingSendRef.current;
      pendingSendRef.current = null;
      void startGeneration(pending.content, pending.attachments);
    }
  }, [state.chatTransitionState]);

  const enterChat = (value = '', attachments = selectedAttachmentsRef.current) => {
    setFeatureIntroPresentation('hidden');
    if (String(value || '').trim()) {
      pendingSendRef.current = {
        content: String(value).trim(),
        attachments: Array.isArray(attachments) ? attachments : []
      };
    }
    if (state.appView !== 'immersiveChat' || state.chatTransitionState === 'exiting') dispatch({ type: 'ENTER_CHAT' });
  };

  const featureIntroScope = () => ({
    storage: window.localStorage,
    identity: session.user?.id,
    dateKey: tasksState.range?.today,
    introVersion: FEATURE_INTRO_VERSION
  });

  const handleFeatureIntroSkip = () => {
    const scope = featureIntroScope();
    const alreadyCompleted = resolveFeatureIntroPresentation(scope) === 'hidden';
    markFeatureIntroVersionSkipped(scope);
    markDailyFeatureIntroHandled(scope);
    setFeatureIntroPresentation(alreadyCompleted ? 'hidden' : 'compact');
  };

  const handleFeatureIntroComplete = () => {
    markFeatureIntroVersionCompleted(featureIntroScope());
    setFeatureIntroPresentation('hidden');
  };

  const openFeatureIntroFromSettings = () => {
    setFeatureView('home');
    setFeatureIntroPresentation('manual');
    dispatch({ type: 'CLOSE_BRAIN' });
  };

  const stopGeneration = async () => {
    const active = activeRequestRef.current;
    if (!active || active.intentional) return;
    active.intentional = true;
    dispatch({ type: 'SET_COMPOSER_STATE', value: 'stopping' });
    const cancel = active.requestId ? client.cancelRequest(active.requestId).catch(() => null) : Promise.resolve(null);
    active.controller.abort();
    await cancel;
    accountWorkspace.commit(active.accountToken, () => {
      setMessages((current) => current.map((message) => (
        message.clientRequestId === active.clientRequestId && message.role === 'assistant' && message.status === 'streaming'
          ? { ...message, status: 'stopped' }
          : message
      )));
      dispatch({ type: 'SET_COMPOSER_STATE', value: 'stopped' });
    });
  };

  const handleRetry = (assistantId) => {
    const exchange = findRetryExchange(messages, assistantId);
    if (!exchange || BUSY_STATES.has(state.composerState)) return;
    const savedQuestion = decodeDocumentMessage(exchange.content);
    const reference = savedQuestion?.kind === 'question' ? savedQuestion.data : documentRequestRefs.current.get(exchange.clientRequestId);
    if (reference) {
      const record = documentQa.session.current?.record;
      if (!record || record.documentId !== reference.documentId || record.revision !== reference.revision) { showToast('请先重新选择这次提问使用的资料'); return; }
      documentRequestRefs.current.set(exchange.clientRequestId, reference);
    } else if (documentQa.session.current) { showToast('请先取消文件引用，再重试原来的消息'); return; }
    if (savedQuestion?.kind === 'question') exchange.content = savedQuestion.data.question;
    setMessages((current) => current.map((message) => (
      message.id === exchange.assistantId ? { ...message, content: '', status: 'streaming', errorCode: null } : message
    )));
    void runStream({
      content: exchange.content,
      clientRequestId: exchange.clientRequestId,
      attachmentIds: exchange.attachmentIds,
      retry: true
    });
  };

  const createNewConversation = async () => {
    const accountToken = accountWorkspace.capture();
    documentQa.clear(); documentRequestRefs.current.clear();
    if (BUSY_STATES.has(state.composerState)) await stopGeneration();
    if (!accountWorkspace.isCurrent(accountToken)) return;
    const orphaned = selectedAttachmentsRef.current.filter((item) => item.attachmentId);
    await Promise.allSettled(orphaned.map((item) => attachmentClient.delete(item.attachmentId)));
    accountWorkspace.commit(accountToken, () => {
      releaseAttachmentPreviews(selectedAttachmentsRef.current);
      selectedAttachmentsRef.current = [];
      setSelectedAttachments([]);
      setConversationId(null);
      setMessages([]);
      setDraft('');
      setError('');
      dispatch({ type: 'SET_COMPOSER_STATE', value: 'idle' });
      if (storageKey) window.localStorage.setItem(storageKey, NEW_CONVERSATION_MARKER);
      showToast('已开始新对话');
    });
  };

  const handleSelectImages = async (files) => {
    const accountToken = accountWorkspace.capture();
    if (privacyConsent?.consent?.current !== true) {
      showToast('请先阅读并同意当前隐私说明');
      return;
    }
    if (attachmentCapability.loading) {
      showToast('图片功能正在初始化，请稍候');
      return;
    }
    if (!attachmentCapability.enabled) {
      showToast('图片功能当前未启用');
      return;
    }
    const result = await addSelectedImages(selectedAttachmentsRef.current, files);
    if (!accountWorkspace.commit(accountToken, () => {
      setSelectedAttachments(result.items);
      if (result.errors.length) showToast(attachmentSelectionErrorMessage(result.errors[0]));
    })) releaseAttachmentPreviews(result.items);
  };

  const handleRemoveAttachment = async (id) => {
    const accountToken = accountWorkspace.capture();
    const queued = selectedAttachmentsRef.current.find((item) => item.id === id || item.attachmentId === id);
    if (queued) {
      if (queued.status === 'uploading') return;
      if (queued.attachmentId) {
        try {
          await attachmentClient.delete(queued.attachmentId);
        } catch (caught) {
          if (!accountWorkspace.isCurrent(accountToken)) return;
          if (requiresAccountReset(caught)) expireSession();
          else showToast(caught?.message || '图片暂时无法删除，请重试');
          return;
        }
      }
      accountWorkspace.commit(accountToken, () => {
        setSelectedAttachments((current) => removeSelectedImage(current, queued.id));
      });
      return;
    }
    try {
      await attachmentClient.delete(id);
      accountWorkspace.commit(accountToken, () => {
        setMessages((current) => current.map((message) => ({
          ...message,
          ...(Array.isArray(message.attachments) ? {
            attachments: message.attachments.map((attachment) => (
              attachment.attachmentId === id
                ? { ...attachment, processingState: 'deleted' }
                : attachment
            ))
          } : {})
        })));
        showToast('图片已删除');
      });
    } catch (caught) {
      if (!accountWorkspace.isCurrent(accountToken)) return;
      if (requiresAccountReset(caught)) expireSession();
      else showToast(caught?.message || '图片暂时无法删除，请重试');
    }
  };

  const handleTaskToggle = async (task) => {
    const accountToken = accountWorkspace.capture();
    if (!task?.id || busyTaskId) return;
    if (HEALTH_ENABLED && task.healthId) { window.location.hash = `health=${task.healthId}`; return; }
    if (DIARY_ENABLED && task.diaryId) { window.location.hash = `diary=${task.diaryId}`; return; }
    setBusyTaskId(task.id);
    setTaskActionError('');
    try {
      const updated = task.status === 'completed'
        ? await tasksClient.restore(task.id)
        : await tasksClient.complete(task.id);
      accountWorkspace.commit(accountToken, () => dispatchTasks({ type: 'task-updated', task: updated }));
    } catch (caught) {
      if (!accountWorkspace.isCurrent(accountToken)) return;
      if (requiresAccountReset(caught)) expireSession();
      else setTaskActionError(caught?.message || '事项状态更新失败，请重试。');
    } finally {
      accountWorkspace.commit(accountToken, () => setBusyTaskId(''));
    }
  };

  const selectBrainFunction = (featureKey) => {
    const feature = getFeature(featureKey);
    if (!feature) return;
    setMeetingRouteRecovery(null);
    dispatch({ type: 'CLOSE_BRAIN' });
    if (feature.key === 'chat') {
      setFeatureView('home');
      enterChat();
      return;
    }
    if (feature.key === 'games') setInitialGame('lobby');
    setFeatureView(feature.key);
  };

  const returnFromFeature = () => {
    if (featureView === 'health') {
      setTasksReloadKey(value=>value+1);setHealthRecordId(null);
      if(window.location.hash.startsWith('#health='))window.history.replaceState(null,'',window.location.pathname+window.location.search);
    }
    if (DIARY_ENABLED && featureView === 'memory') {
      setTasksReloadKey(value=>value+1); setDiaryEntryId(null);
      if(window.location.hash.startsWith('#diary=')) window.history.replaceState(null,'',window.location.pathname+window.location.search);
    }
    setMeetingRouteRecovery(null);
    setFeatureView('home');
    dispatch({ type: 'CLOSE_BRAIN' });
  };

  const startChatFromMemory = () => {
    if (DIARY_ENABLED) { setDiaryEntryId(null); if(window.location.hash.startsWith('#diary=')) window.history.replaceState(null,'',window.location.pathname+window.location.search); }
    setMeetingRouteRecovery(null);
    setFeatureView('home');
    dispatch({ type: 'CLOSE_BRAIN' });
    enterChat();
  };

  const startChatFromFinance = () => {
    setMeetingRouteRecovery(null);
    setFeatureView('home');
    dispatch({ type: 'CLOSE_BRAIN' });
    enterChat();
  };

  const handleLogin = async (username, password) => {
    const { user, featureFlags } = await loginAccount(username, password);
    const privacy = await fetchPrivacyConsent();
    accountWorkspace.transitionTo(user?.id || null);
    setThemePreference(readThemePreferenceForUser(user?.id));
    setPrivacyConsent(privacy);
    setSession({ loading: false, user, featureFlags, error: '' });
  };

  const handlePrivacyAccept = async (input) => {
    const accountToken = accountWorkspace.capture();
    const accepted = await acceptPrivacyConsent(input);
    accountWorkspace.commit(accountToken, () => {
      setPrivacyConsent((current) => ({ ...current, consent: accepted.consent }));
    });
  };

  const handleLogout = async () => {
    onVoiceCancel();
    if (BUSY_STATES.has(state.composerState)) await stopGeneration();
    await logoutAccount();
    accountWorkspace.transitionTo(null);
    setSession({ loading: false, user: null, error: '请使用现有账号登录。' });
  };

  const showHome = featureView === 'home' && (state.appView === 'home' || ['entering', 'exiting'].includes(state.chatTransitionState));
  const showChat = state.appView === 'immersiveChat' && featureView !== 'learning' && featureView !== 'games';
  const selectedFeature = getFeature(featureView);
  const accountContextReady = Boolean(session.user?.id && accountWorkspace.isOwner(session.user.id));

  const handleAccountDeleted = () => {
    if (storageKey) window.localStorage.removeItem(storageKey);
    accountWorkspace.transitionTo(null);
    setSession({ loading: false, user: null, error: '账号和在线个人数据已删除。' });
  };

  const changeThemePreference = (nextPreference) => {
    if (!THEME_PREFERENCES.has(nextPreference)) return;
    setThemePreference(nextPreference);
    setThemeClock(new Date());
    if (themeStorageKey) window.localStorage.setItem(themeStorageKey, nextPreference);
  };

  return (
    <DocumentQaContext.Provider value={documentQa}>
    <LazyMotion features={domAnimation} strict>
      <ThemeProvider themeId={themeId}>
        <div ref={canvasRef} className={`af-prototype-canvas ${DIARY_ENABLED && featureView === 'memory' ? 'is-diary-open' : ''} ${HEALTH_ENABLED && featureView === 'health' ? 'is-health-open' : ''} ${reducedMotion ? 'is-reduced-motion' : ''}`} style={{ '--motion-duration': `${duration}ms` }} data-mode="real" data-theme-mode={themeMode}>
          {session.loading || (session.user && !accountContextReady) ? <div className="af-real-session-loading" role="status">正在确认账号…</div> : null}
          {!session.loading && !session.user ? <RealAccountLogin onLogin={handleLogin} initialError={session.error} /> : null}
          {session.user && accountContextReady && privacyConsent?.consent?.current !== true ? (
            <PrivacyConsentView notice={privacyConsent?.notice || {}} onAccept={handlePrivacyAccept} />
          ) : null}
          {session.user && accountContextReady && privacyConsent?.consent?.current === true ? (
            <AnimatePresence initial={false} mode="sync">
              {showHome ? (
                <HomeAmbientScene
                  key="home"
                  homeState={state.homeState}
                  draft={draft}
                  attachments={selectedAttachments}
                  composerState={state.composerState}
                  voiceState={voiceState}
                  voiceError={voiceError}
                  voiceDurationMs={voiceDurationMs}
                  voiceLevel={voiceLevel}
                  onDraftChange={setDraft}
                  onEnterChat={enterChat}
                  onToggleBrain={() => dispatch({ type: state.homeState === 'brainOpen' ? 'CLOSE_BRAIN' : 'OPEN_BRAIN' })}
                  onCloseBrain={() => dispatch({ type: 'CLOSE_BRAIN' })}
                  onSelectFunction={selectBrainFunction}
                  onRemindersComplete={() => dispatch({ type: 'REMINDERS_COMPLETE' })}
                  onAttach={(kind, message) => {
                    if (BUSY_STATES.has(state.composerState)) { showToast('请先停止当前回复'); return false; }
                    if (kind === 'file' && selectedAttachmentsRef.current.length) { showToast('请先发送或移除已选图片'); return false; }
                    if (kind === 'image' && (documentQa.session.current || documentQa.state.state === 'parsing')) { showToast('请先取消当前文件引用'); return false; }
                    if (kind === 'image' && !attachmentCapability.enabled) {
                      showToast(attachmentCapability.loading ? '图片功能正在初始化，请稍候' : '图片功能当前未启用');
                      return false;
                    }
                    return true;
                  }}
                  onSelectImages={(files) => void handleSelectImages(files)}
                  onRemoveAttachment={(id) => void handleRemoveAttachment(id)}
                  onVoice={onVoice}
                  onVoiceChat={openVoiceChat}
                  onVoiceCancel={onVoiceCancel}
                  onTransitionComplete={() => dispatch({ type: 'CHAT_ENTERED' })}
                  reducedMotion={reducedMotion}
                  tasksState={tasksState}
                  bubbleIdentity={session.user?.id}
                  onTasksRetry={() => setTasksReloadKey((value) => value + 1)}
                  onTaskToggle={handleTaskToggle}
                  busyTaskId={busyTaskId}
                  taskActionError={taskActionError}
                  featureIntroPresentation={featureIntroPresentation}
                  onFeatureIntroSkip={handleFeatureIntroSkip}
                  onFeatureIntroComplete={handleFeatureIntroComplete}
                  onFeatureIntroReopen={() => setFeatureIntroPresentation('expanded')}
                  transitionProgress={null}
                  transitionState={state.chatTransitionState}
                />
              ) : null}
              {showChat ? (
                <ImmersiveChatView
                  key="chat"
                  transitionState={state.chatTransitionState}
                  transitionProgress={null}
                  reducedMotion={reducedMotion}
                  messages={messages}
                  draft={draft}
                  attachments={selectedAttachments}
                  composerState={state.composerState}
                  voiceState={voiceState}
                  voiceError={voiceError}
                  voiceDurationMs={voiceDurationMs}
                  voiceLevel={voiceLevel}
                  error={error}
                  onTransitionComplete={() => dispatch({ type: 'CHAT_EXITED' })}
                  onBack={() => {
                    setTasksReloadKey((value) => value + 1);
                    dispatch({ type: 'EXIT_CHAT' });
                  }}
                  onNewConversation={() => void createNewConversation()}
                  onDraftChange={setDraft}
                  onSend={(content, attachments) => void startGeneration(content, attachments)}
                  onStop={() => void stopGeneration()}
                  onAttach={(kind, message) => {
                    if (BUSY_STATES.has(state.composerState)) { showToast('请先停止当前回复'); return false; }
                    if (kind === 'file' && selectedAttachmentsRef.current.length) { showToast('请先发送或移除已选图片'); return false; }
                    if (kind === 'image' && (documentQa.session.current || documentQa.state.state === 'parsing')) { showToast('请先取消当前文件引用'); return false; }
                    if (kind === 'image' && !attachmentCapability.enabled) {
                      showToast(attachmentCapability.loading ? '图片功能正在初始化，请稍候' : '图片功能当前未启用');
                      return false;
                    }
                    return true;
                  }}
                  onSelectImages={(files) => void handleSelectImages(files)}
                  onRemoveAttachment={(id) => void handleRemoveAttachment(id)}
                  onVoice={onVoice}
                  onVoiceChat={openVoiceChat}
                  onVoiceCancel={onVoiceCancel}
                  onRetry={handleRetry}
                />
              ) : null}
              {GAMES_ENABLED && featureView === 'games' ? <GameBoundary onBack={returnFromFeature}><Suspense fallback={<div className="af-real-session-loading" role="status">正在打开游戏…</div>}><GamesView key={`games-${session.user.id}`} ownerId={session.user.id} initialGame={initialGame} onBack={returnFromFeature} /></Suspense></GameBoundary> : null}
              {LEARNING_ENABLED && featureView === 'learning' ? <LearningView key={`learning-${session.user?.id}`} ownerId={session.user.id} onSessionExpired={expireSession} onBack={returnFromFeature} /> : null}
              {featureView === 'memory' ? (
                DIARY_ENABLED ? <DiaryView key={`diary-${session.user?.id}`} initialEntryId={diaryEntryId} onBack={returnFromFeature} onStartChat={startChatFromMemory} onChanged={() => setTasksReloadKey(value=>value+1)} /> : <MemoryFeatureView key="feature-memory" onBack={returnFromFeature} onStartChat={startChatFromMemory} />
              ) : null}
              {featureView === 'settings' ? (
                <RealSettingsView
                  key="feature-settings"
                  currentUser={session.user}
                  onBack={returnFromFeature}
                  onLogout={handleLogout}
                  onAccountDeleted={handleAccountDeleted}
                  onOpenFeatureIntro={openFeatureIntroFromSettings}
                  themePreference={themePreference}
                  onThemePreferenceChange={changeThemePreference}
                />
              ) : null}
              {featureView === 'finance' ? (
                <FinanceView
                  key="feature-finance"
                  onBack={returnFromFeature}
                  onStartConversation={startChatFromFinance}
                  financeF201Enabled={session.featureFlags?.financeF201Enabled === true}
                />
              ) : null}
              {featureView === 'meeting' ? (
                <MeetingCenter
                  key="feature-meeting"
                  currentUser={session.user}
                  onNavigate={returnFromFeature}
                  routeRecovery={meetingRouteRecovery}
                />
              ) : null}
              {HEALTH_ENABLED && featureView === 'health' ? <HealthView key={`health-${session.user?.id}`} initialRecordId={healthRecordId} onBack={returnFromFeature} /> : null}
              {selectedFeature?.view === 'placeholder' && !(HEALTH_ENABLED && featureView === 'health') ? (
                <FeaturePlaceholderView key={`feature-${selectedFeature.key}`} feature={selectedFeature} onBack={returnFromFeature} />
              ) : null}
            </AnimatePresence>
          ) : null}
          {voiceChat.visible && accountContextReady ? <VoiceChatPanel voice={voiceChat} onText={() => dispatch({ type: 'ENTER_CHAT' })} /> : null}
          {toast ? <button type="button" className="af-toast" onClick={() => setToast('')} aria-label="关闭提示">{toast}</button> : null}
        </div>
      </ThemeProvider>
    </LazyMotion>
    </DocumentQaContext.Provider>
  );
}
