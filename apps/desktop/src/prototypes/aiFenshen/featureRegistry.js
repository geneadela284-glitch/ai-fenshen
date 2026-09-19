import { GAMES_ENABLED } from './games/feature.js';
import { LEARNING_ENABLED } from './learning/learningFeature.js';
import { DIARY_ENABLED } from './diaryFeature.js';
export const FEATURE_KEYS = Object.freeze([
  LEARNING_ENABLED ? 'learning' : 'chat', 'memory', 'meeting', 'health', 'finance', GAMES_ENABLED ? 'games' : 'documents', 'settings'
]);

export const FEATURE_REGISTRY = Object.freeze([
  { key: LEARNING_ENABLED ? 'learning' : 'chat', label: LEARNING_ENABLED ? '学习' : '对话', icon: LEARNING_ENABLED ? 'book' : 'message-circle', status: 'available', route: LEARNING_ENABLED ? 'learning' : 'immersive-chat', view: LEARNING_ENABLED ? 'learning' : 'chat', description: LEARNING_ENABLED ? '从零开口，在情境中练习英语。' : '进入当前真实AI对话。', enabled: true },
  { key: 'memory', label: DIARY_ENABLED ? '日记' : '记忆', icon: 'brain', status: 'available_after_m9_2', route: 'memory-intro', view: 'memory', description: '在对话中保存并召回经你授权的重要信息。', enabled: true },
  { key: 'meeting', label: '会议', icon: 'calendar-event', status: 'available_phase1a', route: 'feature/meeting', view: 'meeting', description: '现场录音、本地加密保存和中断恢复。', enabled: true },
  { key: 'health', label: '健康', icon: 'heart', status: 'coming_soon', route: 'feature/health', view: 'placeholder', description: '健康能力正在完善。', enabled: true },
  { key: 'finance', label: '财务', icon: 'wallet', status: 'available', route: 'finance', view: 'finance', description: '查看真实收支、分类与最近账目。', enabled: true },
  GAMES_ENABLED ? { key: 'games', label: '游戏', icon: 'gamepad', status: 'available', route: 'feature/games', view: 'games', description: '经典扑克机，轻松玩一局。', enabled: true } : { key: 'documents', label: '资料', icon: 'folder', status: 'coming_soon', route: 'feature/documents', view: 'placeholder', description: '资料能力正在完善。', enabled: true },
  { key: 'settings', label: '设置', icon: 'settings', status: 'available', route: 'settings', view: 'settings', description: '管理账号与当前可用服务。', enabled: true }
].map((item) => Object.freeze(item)));

const FEATURES_BY_KEY = new Map(FEATURE_REGISTRY.map((item) => [item.key, item]));

export function getFeature(key) {
  return FEATURES_BY_KEY.get(String(key || '')) || null;
}
