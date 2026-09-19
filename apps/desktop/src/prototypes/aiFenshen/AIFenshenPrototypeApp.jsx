import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AnimatePresence, LazyMotion, domAnimation, useReducedMotion } from 'motion/react';
import HomeAmbientScene from './HomeAmbientScene.jsx';
import ImmersiveChatView from './ImmersiveChatView.jsx';
import LoginExperience from './LoginExperience.jsx';
import ThemeProvider from './ThemeProvider.jsx';
import { fakeAssistantReply, initialMessages, longConversation, reminderItems, todayAgenda, tomorrowAgenda } from './fakeData.js';
import { normalizeLoginScreenState } from './loginMockState.js';
import { createInitialPrototypeState, getMotionDuration, prototypeReducer, THEME_IDS } from './prototypeState.js';
import useStableVisualViewport from './useStableVisualViewport.js';
import './aiFenshenPrototype.css';

function readOptions() {
  const search = new URLSearchParams(window.location.search);
  const themeId = search.get('theme');
  const scenario = search.get('scenario') || 'login';
  return {
    entry: search.get('entry'),
    scenario,
    loginScreenState: scenario.startsWith('login-') ? 'face_ready' : normalizeLoginScreenState(search.get('loginState')),
    themeId: THEME_IDS.includes(themeId) ? themeId : 'deep-blue',
    reducedMotion: search.get('reducedMotion') === '1' || search.get('scenario')?.startsWith('reduced-motion')
  };
}

function readTransitionProgress(scenario) {
  const progress = {
    'chat-entering-start': 0.25,
    'chat-entering-25': 0.25,
    'chat-entering-mid': 0.5,
    'chat-entering-50': 0.5,
    'chat-entering-75': 0.75
  }[scenario];
  return Number.isFinite(progress) ? progress : null;
}

function createScenarioState(options) {
  const initial = createInitialPrototypeState(options.themeId);
  const scenario = options.scenario;
  if (options.entry === 'home') return { ...initial, appView: 'home', loginState: 'success', homeState: 'idle' };
  if (scenario === 'login-scanning') return { ...initial, loginState: 'scanning' };
  if (scenario === 'login-success') return { ...initial, loginState: 'success' };
  if (scenario === 'login-failure') return { ...initial, loginState: 'failure' };
  if (scenario.startsWith('home') || scenario.startsWith('reminder') || scenario === 'brain-open') {
    return { ...initial, appView: 'home', loginState: 'success', homeState: scenario === 'brain-open' ? 'brainOpen' : scenario.startsWith('reminder') ? 'reminderSequence' : 'idle' };
  }
  if (scenario === 'reduced-motion') return { ...initial, appView: 'home', loginState: 'success', homeState: 'reminderSequence' };
  if (scenario === 'reduced-motion-chat') {
    return { ...initial, appView: 'immersiveChat', loginState: 'success', homeState: 'idle', chatTransitionState: 'active', composerState: 'idle' };
  }
  if (readTransitionProgress(scenario) !== null) {
    return { ...initial, appView: 'immersiveChat', loginState: 'success', homeState: 'idle', chatTransitionState: 'entering', composerState: 'idle' };
  }
  if (scenario.startsWith('chat') || ['composer-multiline', 'attachment', 'keyboard', 'reduced-motion-chat'].includes(scenario)) {
    return {
      ...initial,
      appView: 'immersiveChat',
      loginState: 'success',
      homeState: 'idle',
      chatTransitionState: 'active',
      composerState: scenario === 'chat-streaming' ? 'streaming' : scenario === 'chat-stopped' ? 'stopped' : scenario === 'chat-error' ? 'error' : 'idle'
    };
  }
  return initial;
}

function initialScenarioMessages(scenario) {
  const prompt = { id: 'scenario-user', role: 'user', status: 'complete', content: '帮我总结一下今天的工作进展，并给出明天的建议。' };
  if (scenario === 'chat-long') return longConversation;
  if (scenario === 'chat-streaming') return [...initialMessages, prompt, { id: 'scenario-ai', role: 'assistant', status: 'streaming', content: '今天的工作进展已经整理好：\n\n1. 项目方案已进入评审准备。' }];
  if (scenario === 'chat-stopped') return [...initialMessages, prompt, { id: 'scenario-ai', role: 'assistant', status: 'stopped', content: '今天的工作进展已经整理好：\n\n1. 项目方案已进入评审准备。' }];
  if (scenario === 'chat-error') return [...initialMessages, prompt, { id: 'scenario-ai', role: 'assistant', status: 'error', content: '' }];
  if (scenario.startsWith('chat') || ['composer-multiline', 'attachment', 'keyboard'].includes(scenario)) {
    return [...initialMessages, prompt, { id: 'scenario-ai', role: 'assistant', status: 'complete', content: fakeAssistantReply.join('\n') }];
  }
  return initialMessages;
}

function prototypeTask(item, day, index) {
  return {
    id: `prototype-${day}-${index}`,
    title: item.title,
    description: item.note || '',
    time: item.time,
    status: 'pending'
  };
}

function createAttachment(kind) {
  return kind === 'image'
    ? { id: `image-${Date.now()}`, kind: 'image', name: '项目现场.jpg', preview: '/prototype/ai-fenshen/ai-fenshen-avatar-deep-blue.png' }
    : { id: `file-${Date.now()}`, kind: 'file', name: '项目评审资料.pdf' };
}

export default function AIFenshenPrototypeApp() {
  const options = useMemo(readOptions, []);
  const [state, dispatch] = useReducer(prototypeReducer, options, createScenarioState);
  const systemReducedMotion = useReducedMotion();
  const reducedMotion = options.reducedMotion || Boolean(systemReducedMotion);
  const duration = getMotionDuration(reducedMotion);
  const transitionProgress = readTransitionProgress(options.scenario);
  const [draft, setDraft] = useState(() => options.scenario === 'composer-multiline' || options.scenario === 'keyboard' ? '请帮我整理今天的项目进展，\n重点说明已经完成的内容、\n仍需确认的风险和明天的执行顺序。' : '');
  const [attachments, setAttachments] = useState(() => options.scenario === 'attachment' ? [createAttachment('image'), createAttachment('file')] : []);
  const [messages, setMessages] = useState(() => initialScenarioMessages(options.scenario));
  const [loginFeedback, setLoginFeedback] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState(options.scenario === 'chat-error' ? '连接暂时中断，本轮为错误状态模拟。' : '');
  const canvasRef = useRef(null);
  const pendingSendRef = useRef('');
  const generationTimerRef = useRef(null);
  const loginTimerRef = useRef([]);
  useStableVisualViewport(canvasRef, { mockKeyboardInset: options.scenario === 'keyboard' ? 292 : 0 });

  useEffect(() => () => {
    window.clearInterval(generationTimerRef.current);
    loginTimerRef.current.forEach(window.clearTimeout);
  }, []);

  const startGeneration = (value) => {
    const content = String(value || draft).trim();
    if (!content && !attachments.length) return;
    const attachment = attachments[0] || null;
    const userMessage = { id: `user-${Date.now()}`, role: 'user', status: 'complete', content, attachment };
    const assistantId = `assistant-${Date.now()}`;
    setMessages((current) => [...current, userMessage, { id: assistantId, role: 'assistant', status: 'streaming', content: '' }]);
    setDraft('');
    setAttachments([]);
    setError('');
    dispatch({ type: 'SET_COMPOSER_STATE', value: 'streaming' });
    let index = 0;
    window.clearInterval(generationTimerRef.current);
    generationTimerRef.current = window.setInterval(() => {
      index += 1;
      setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: fakeAssistantReply.slice(0, index).join('\n'), status: index >= fakeAssistantReply.length ? 'complete' : 'streaming' } : message));
      if (index >= fakeAssistantReply.length) {
        window.clearInterval(generationTimerRef.current);
        dispatch({ type: 'SET_COMPOSER_STATE', value: 'idle' });
      }
    }, reducedMotion ? 60 : 160);
  };

  useEffect(() => {
    if (state.chatTransitionState === 'active' && pendingSendRef.current) {
      const pending = pendingSendRef.current;
      pendingSendRef.current = '';
      startGeneration(pending);
    }
  }, [state.chatTransitionState]);

  const enterChat = (value = '') => {
    if (typeof value === 'string' && value.trim()) pendingSendRef.current = value;
    if (state.appView !== 'immersiveChat' || state.chatTransitionState === 'exiting') dispatch({ type: 'ENTER_CHAT' });
  };

  const stopGeneration = () => {
    window.clearInterval(generationTimerRef.current);
    setMessages((current) => current.map((message) => message.status === 'streaming' ? { ...message, status: 'stopped' } : message));
    dispatch({ type: 'SET_COMPOSER_STATE', value: 'stopped' });
  };

  const handleFaceScan = () => {
    if (state.loginState === 'scanning') {
      loginTimerRef.current.forEach(window.clearTimeout);
      loginTimerRef.current = [];
      dispatch({ type: 'LOGIN_FAILURE' });
      return;
    }
    dispatch({ type: 'LOGIN_SCAN' });
    loginTimerRef.current = [
      window.setTimeout(() => dispatch({ type: 'LOGIN_SUCCESS' }), 850),
      window.setTimeout(() => dispatch({ type: 'ENTER_HOME' }), 1550)
    ];
  };

  const handleAlternative = (label) => {
    setLoginFeedback(`${label}登录为原型反馈，本轮不连接真实认证。`);
    window.setTimeout(() => setLoginFeedback(''), 2200);
  };

  const handleCredentialComplete = () => dispatch({ type: 'ENTER_HOME' });

  const handleVoice = () => {
    if (state.composerState === 'recording') {
      dispatch({ type: 'SET_COMPOSER_STATE', value: 'processingVoice' });
      window.setTimeout(() => {
        setDraft('请帮我整理今天的工作进展。');
        dispatch({ type: 'SET_COMPOSER_STATE', value: 'voiceResult' });
      }, 680);
      return;
    }
    dispatch({ type: 'SET_COMPOSER_STATE', value: 'recording' });
  };

  const handleRetry = () => {
    setMessages((current) => current.filter((message) => message.status !== 'error'));
    setError('');
    startGeneration('请重新生成刚才的回复。');
  };

  const handleNewMockConversation = () => {
    window.clearInterval(generationTimerRef.current);
    setMessages(initialMessages);
    setDraft('');
    setAttachments([]);
    setError('');
    dispatch({ type: 'SET_COMPOSER_STATE', value: 'idle' });
    setToast('已开始新对话');
  };

  const reminderScenario = options.scenario.startsWith('reminder-') ? { phase: options.scenario.replace('reminder-', ''), freeze: true } : null;
  const showHome = state.appView === 'home' || ['entering', 'exiting'].includes(state.chatTransitionState);
  const showChat = state.appView === 'immersiveChat';

  return (
    <LazyMotion features={domAnimation} strict>
      <ThemeProvider themeId={state.themeId}>
        <div
          ref={canvasRef}
          className={`af-prototype-canvas ${reducedMotion ? 'is-reduced-motion' : ''}`}
          style={{ '--motion-duration': `${duration}ms` }}
          data-scenario={options.scenario}
        >
          {state.appView === 'login' ? (
                <LoginExperience
                  loginState={state.loginState}
                  loginScreenState={options.loginScreenState}
                  onFaceScan={handleFaceScan}
                  onAlternative={handleAlternative}
                  onEnterHome={handleCredentialComplete}
                  onEnrollFace={handleCredentialComplete}
                  onSkipFace={handleCredentialComplete}
                  feedback={loginFeedback}
                />
          ) : null}
          <AnimatePresence initial={false} mode="sync">
            {showHome ? (
              <HomeAmbientScene
                key="home"
                homeState={state.homeState}
                draft={draft}
                attachments={attachments}
                composerState={state.composerState}
                onDraftChange={setDraft}
                onEnterChat={enterChat}
                onToggleBrain={() => dispatch({ type: state.homeState === 'brainOpen' ? 'CLOSE_BRAIN' : 'OPEN_BRAIN' })}
                onCloseBrain={() => dispatch({ type: 'CLOSE_BRAIN' })}
                onSelectFunction={(key, feature) => key === 'chat' ? enterChat() : setToast(`${feature.label}入口为本轮导航动效演示`)}
                onRemindersComplete={() => dispatch({ type: 'REMINDERS_COMPLETE' })}
                onAttach={(kind) => setAttachments((current) => [...current, createAttachment(kind)])}
                onVoice={handleVoice}
                onTransitionComplete={() => dispatch({ type: 'CHAT_ENTERED' })}
                reducedMotion={reducedMotion}
                tasksState={{
                  status: 'success',
                  dataState: 'ready',
                  today: todayAgenda.map((item, index) => prototypeTask(item, 'today', index)),
                  tomorrow: tomorrowAgenda.map((item, index) => prototypeTask(item, 'tomorrow', index)),
                  range: { timezone: 'Asia/Shanghai', today: '2026-07-30', tomorrow: '2026-07-31' },
                  error: ''
                }}
                bubbleIdentity="prototype-user"
                onTasksRetry={() => {}}
                onTaskToggle={() => {}}
                reminderItemsOverride={options.scenario === 'reminder-empty' ? [] : reminderItems}
                reminderScenario={reminderScenario}
                transitionProgress={transitionProgress}
                transitionState={state.chatTransitionState}
              />
            ) : null}
            {showChat ? (
              <ImmersiveChatView
                key="chat"
                transitionState={state.chatTransitionState}
                transitionProgress={transitionProgress}
                reducedMotion={reducedMotion}
                messages={messages}
                draft={draft}
                attachments={attachments}
                composerState={state.composerState}
                error={error}
                onTransitionComplete={() => dispatch({ type: 'CHAT_EXITED' })}
                onBack={() => dispatch({ type: 'EXIT_CHAT' })}
                onNewConversation={handleNewMockConversation}
                onDraftChange={setDraft}
                onSend={startGeneration}
                onStop={stopGeneration}
                onAttach={(kind) => setAttachments((current) => [...current, createAttachment(kind)])}
                onRemoveAttachment={(id) => setAttachments((current) => current.filter((item) => item.id !== id))}
                onVoice={handleVoice}
                onRetry={handleRetry}
              />
            ) : null}
          </AnimatePresence>
          {toast ? <button type="button" className="af-toast" onClick={() => setToast('')} aria-label="关闭提示">{toast}</button> : null}
        </div>
      </ThemeProvider>
    </LazyMotion>
  );
}
