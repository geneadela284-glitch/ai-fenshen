export const SETTINGS_VIEWS = Object.freeze({
  HOME: 'home',
  APPEARANCE: 'appearance',
  PRIVACY: 'privacy'
});

export function reduceSettingsView(currentView, action = {}) {
  if (action.type === 'open-appearance') return SETTINGS_VIEWS.APPEARANCE;
  if (action.type === 'open-privacy') return SETTINGS_VIEWS.PRIVACY;
  if (action.type === 'back') return SETTINGS_VIEWS.HOME;
  return currentView || SETTINGS_VIEWS.HOME;
}

export function getSettingsHomeEntries({ isAdmin = false } = {}) {
  const entries = [
    {
      id: 'profile',
      title: '个人资料',
      description: '账号信息与显示名称'
    },
    {
      id: 'appearance',
      title: '外观',
      description: '主题颜色与显示风格'
    },
    {
      id: 'notifications',
      title: '通知',
      description: '提醒和任务状态通知'
    },
    {
      id: 'privacy',
      title: '隐私与数据',
      description: '本地数据、缓存和导出管理'
    }
  ];

  if (isAdmin) {
    entries.push({
      id: 'ai-service',
      title: 'AI 服务',
      description: '管理员专属服务配置'
    });
  }

  return entries;
}

export function releasePageFocus(documentRef) {
  const activeElement = documentRef?.activeElement;
  if (typeof activeElement?.blur !== 'function') return false;
  activeElement.blur();
  return true;
}
