export const THEME_IDS = ['day-sky', 'deep-blue', 'teal', 'violet', 'pink', 'light-silver'];

export const THEME_TOKEN_KEYS = [
  'background',
  'backgroundElevated',
  'surface',
  'surfaceStrong',
  'surfaceBlur',
  'primary',
  'secondary',
  'accent',
  'textPrimary',
  'textSecondary',
  'textMuted',
  'glow',
  'borderSubtle',
  'focusRing',
  'danger',
  'logoMain',
  'logoGhost',
  'avatarAsset',
  'avatarPosition',
  'avatarAspectRatio',
  'brainCenterX',
  'brainCenterY',
  'backgroundPrimary',
  'backgroundSecondary',
  'skyBlue',
  'earthBlue',
  'glassFill',
  'glassBorder',
  'glassHighlight',
  'shadowSoft'
];

const avatarAsset = "url('/prototype/ai-fenshen/home-night-20260910.jpg')";
const dayAvatarAsset = "url('/prototype/ai-fenshen/home-day-20260910.jpg')";
const nightGlassTokens = {
  avatarAspectRatio: '609 / 1280',
  brainCenterX: '82.1018%',
  brainCenterY: '44.1406%',
  backgroundPrimary: '#020817',
  backgroundSecondary: '#07152d',
  skyBlue: '#1c5eb9',
  earthBlue: '#2477de',
  glassFill: 'rgba(7, 28, 64, 0.48)',
  glassBorder: 'rgba(150, 201, 255, 0.28)',
  glassHighlight: 'rgba(235, 248, 255, 0.42)',
  shadowSoft: 'rgba(0, 7, 28, 0.3)'
};

const themes = {
  'day-sky': {
    background: '#128fe9',
    backgroundElevated: '#82d2ff',
    surface: 'rgba(4, 52, 108, 0.34)',
    surfaceStrong: 'rgba(4, 43, 91, 0.54)',
    surfaceBlur: '14px',
    primary: '#0f82eb',
    secondary: '#eefaff',
    accent: '#ffffff',
    textPrimary: '#ffffff',
    textSecondary: '#edfaff',
    textMuted: '#d9f1ff',
    glow: 'rgba(89, 199, 255, 0.64)',
    borderSubtle: 'rgba(232, 249, 255, 0.48)',
    focusRing: 'rgba(255, 255, 255, 0.86)',
    danger: '#ff6688',
    logoMain: '#ffffff',
    logoGhost: '#a9e5ff',
    avatarAsset: dayAvatarAsset,
    avatarPosition: 'center center',
    avatarAspectRatio: '606 / 1280',
    brainCenterX: '82.5083%',
    brainCenterY: '44.1406%',
    backgroundPrimary: '#128fe9',
    backgroundSecondary: '#9bdeff',
    skyBlue: '#20a8f7',
    earthBlue: '#087fe9',
    glassFill: 'rgba(4, 45, 96, 0.38)',
    glassBorder: 'rgba(246, 253, 255, 0.72)',
    glassHighlight: 'rgba(255, 255, 255, 0.82)',
    shadowSoft: 'rgba(2, 42, 88, 0.3)'
  },
  'deep-blue': {
    ...nightGlassTokens,
    background: '#020817',
    backgroundElevated: '#07152d',
    surface: 'rgba(6, 23, 52, 0.54)',
    surfaceStrong: 'rgba(7, 24, 54, 0.88)',
    surfaceBlur: '18px',
    primary: '#4b8dff',
    secondary: '#7aa8ff',
    accent: '#a8d9ff',
    textPrimary: '#f4f8ff',
    textSecondary: '#b8c8e5',
    textMuted: '#7f93b7',
    glow: 'rgba(54, 135, 255, 0.42)',
    borderSubtle: 'rgba(124, 178, 255, 0.18)',
    focusRing: 'rgba(113, 184, 255, 0.72)',
    danger: '#ff7d9f',
    logoMain: '#f3f8ff',
    logoGhost: '#3f8dff',
    avatarAsset,
    avatarPosition: '66% center'
  },
  teal: {
    ...nightGlassTokens,
    background: '#021313', backgroundElevated: '#062a2a', surface: 'rgba(4, 39, 39, 0.53)', surfaceStrong: 'rgba(4, 44, 44, 0.88)', surfaceBlur: '17px', primary: '#36d4c5', secondary: '#69d8cc', accent: '#d0fff7', textPrimary: '#f2fffd', textSecondary: '#b7ddd8', textMuted: '#74a49f', glow: 'rgba(38, 205, 190, 0.38)', borderSubtle: 'rgba(91, 225, 211, 0.18)', focusRing: 'rgba(91, 225, 211, 0.7)', danger: '#ff8799', logoMain: '#f0fffc', logoGhost: '#2ac5b7', avatarAsset, avatarPosition: '66% center'
  },
  violet: {
    ...nightGlassTokens,
    background: '#0a0618', backgroundElevated: '#1b1037', surface: 'rgba(27, 14, 58, 0.53)', surfaceStrong: 'rgba(31, 16, 66, 0.88)', surfaceBlur: '18px', primary: '#9a72ff', secondary: '#c196ff', accent: '#f0e8ff', textPrimary: '#fbf8ff', textSecondary: '#d3c3ed', textMuted: '#9982b9', glow: 'rgba(142, 92, 255, 0.4)', borderSubtle: 'rgba(184, 143, 255, 0.18)', focusRing: 'rgba(190, 150, 255, 0.72)', danger: '#ff7fa3', logoMain: '#fbf6ff', logoGhost: '#a16cff', avatarAsset, avatarPosition: '66% center'
  },
  pink: {
    ...nightGlassTokens,
    background: '#170712', backgroundElevated: '#321126', surface: 'rgba(57, 16, 43, 0.52)', surfaceStrong: 'rgba(64, 17, 48, 0.88)', surfaceBlur: '18px', primary: '#f16bb6', secondary: '#ff9bc9', accent: '#ffe6f3', textPrimary: '#fff7fb', textSecondary: '#eac2d8', textMuted: '#b684a0', glow: 'rgba(241, 107, 182, 0.38)', borderSubtle: 'rgba(255, 149, 207, 0.18)', focusRing: 'rgba(255, 151, 208, 0.72)', danger: '#ff7c87', logoMain: '#fff5fb', logoGhost: '#f064b2', avatarAsset, avatarPosition: '66% center'
  },
  'light-silver': {
    ...nightGlassTokens,
    background: '#e8eef7', backgroundElevated: '#f8fbff', surface: 'rgba(248, 251, 255, 0.58)', surfaceStrong: 'rgba(248, 251, 255, 0.9)', surfaceBlur: '15px', primary: '#3f74d8', secondary: '#7896c7', accent: '#15376d', textPrimary: '#102342', textSecondary: '#405574', textMuted: '#71819a', glow: 'rgba(76, 123, 208, 0.24)', borderSubtle: 'rgba(45, 79, 132, 0.16)', focusRing: 'rgba(52, 105, 206, 0.62)', danger: '#c64461', logoMain: '#123765', logoGhost: '#5784cd', avatarAsset, avatarPosition: '66% center'
  }
};

export function getThemeTokens(themeId = 'deep-blue') {
  return themes[themeId] || themes['deep-blue'];
}

export function resolveThemeMode({
  preference = 'auto',
  now = new Date(),
  timeZone,
  systemPrefersDark = false
} = {}) {
  if (preference === 'day' || preference === 'night') return preference;
  try {
    if (!timeZone) throw new Error('TIMEZONE_UNAVAILABLE');
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: '2-digit',
      hourCycle: 'h23'
    }).format(now));
    if (!Number.isFinite(hour)) throw new Error('TIMEZONE_UNAVAILABLE');
    return hour >= 7 && hour < 19 ? 'day' : 'night';
  } catch {
    return systemPrefersDark ? 'night' : 'day';
  }
}

export function themeIdForMode(mode) {
  return mode === 'day' ? 'day-sky' : 'deep-blue';
}

export function createInitialPrototypeState(themeId = 'deep-blue') {
  return {
    appView: 'login',
    loginState: 'idle',
    homeState: 'reminderSequence',
    chatTransitionState: 'inactive',
    composerState: 'idle',
    themeId: THEME_IDS.includes(themeId) ? themeId : 'deep-blue'
  };
}

export function prototypeReducer(state, action) {
  switch (action.type) {
    case 'LOGIN_SCAN':
      return { ...state, loginState: 'scanning' };
    case 'LOGIN_FAILURE':
      return { ...state, loginState: 'failure' };
    case 'LOGIN_SUCCESS':
      return { ...state, loginState: 'success' };
    case 'ENTER_HOME':
      return { ...state, appView: 'home', loginState: 'success', homeState: 'reminderSequence' };
    case 'OPEN_BRAIN':
      return state.appView === 'home' ? { ...state, homeState: 'brainOpen' } : state;
    case 'CLOSE_BRAIN':
      return state.appView === 'home' ? { ...state, homeState: 'idle' } : state;
    case 'REMINDERS_COMPLETE':
      return state.appView === 'home' ? { ...state, homeState: 'idle' } : state;
    case 'ENTER_CHAT':
      return {
        ...state,
        appView: 'immersiveChat',
        homeState: 'idle',
        chatTransitionState: 'entering'
      };
    case 'CHAT_ENTERED':
      return state.appView === 'immersiveChat' && state.chatTransitionState === 'entering'
        ? { ...state, chatTransitionState: 'active' }
        : state;
    case 'EXIT_CHAT':
      return state.appView === 'immersiveChat' ? { ...state, chatTransitionState: 'exiting' } : state;
    case 'CHAT_EXITED':
      return state.appView === 'immersiveChat' && state.chatTransitionState === 'exiting'
        ? { ...state, appView: 'home', homeState: 'idle', chatTransitionState: 'inactive' }
        : state;
    case 'RESET_ACCOUNT_CONTEXT':
      return {
        ...state,
        appView: 'home',
        loginState: 'success',
        homeState: 'idle',
        chatTransitionState: 'inactive',
        composerState: 'idle'
      };
    case 'SET_COMPOSER_STATE':
      return { ...state, composerState: action.value };
    case 'SET_THEME':
      return THEME_IDS.includes(action.value) ? { ...state, themeId: action.value } : state;
    default:
      return state;
  }
}

export function advanceReminder(state, total) {
  if (state.complete) return state;
  if (state.phase === 'blurred') return { ...state, phase: 'clear' };
  if (state.phase === 'clear') return { ...state, phase: 'shattering' };
  const nextIndex = state.index + 1;
  if (nextIndex >= total) return { index: state.index, phase: 'complete', complete: true };
  return { index: nextIndex, phase: 'blurred', complete: false };
}

export function calculateComposerHeight({ scrollHeight, viewportHeight }) {
  const maxHeight = Math.round(viewportHeight * 0.3);
  return Math.min(Math.max(56, Math.ceil(scrollHeight)), maxHeight);
}

export function calculateKeyboardInset({ innerHeight, visualViewportHeight, offsetTop = 0 }) {
  return Math.max(0, Math.round(innerHeight - visualViewportHeight - offsetTop));
}

export function getMotionDuration(reducedMotion) {
  return reducedMotion ? 140 : 380;
}

export function isNearBottom({ scrollTop, clientHeight, scrollHeight }, threshold = 80) {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}
