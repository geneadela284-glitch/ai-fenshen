export const AI_SECRETARY_NAVIGATOR_ENTRIES = [
  {
    id: 'meeting',
    label: '会议记录',
    description: '粘贴会议文字，生成纪要和待办',
    kind: 'route',
    target: '会议记录'
  },
  {
    id: 'history',
    label: '历史对话',
    description: '查看和恢复已有会话',
    kind: 'drawer',
    target: 'conversation-history'
  },
  {
    id: 'memory',
    label: '长期记忆',
    description: '记忆查询可用，管理界面建设中',
    kind: 'status',
    target: 'memory-status'
  },
  {
    id: 'schedule',
    label: '日程与待办',
    description: '查看真实日程和提醒',
    kind: 'drawer',
    target: 'schedule-panel'
  },
  {
    id: 'statistics',
    label: '统计与报表',
    description: '当前显示真实支持范围',
    kind: 'panel',
    target: 'quick-note-reports'
  },
  {
    id: 'knowledge',
    label: '资料库',
    description: '打开现有资料入口',
    kind: 'panel',
    target: 'knowledge-drop'
  },
  {
    id: 'settings',
    label: '设置中心',
    description: '进入现有设置页面',
    kind: 'route',
    target: '设置'
  }
];
