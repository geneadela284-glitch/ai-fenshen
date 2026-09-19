export const todayAgenda = [
  { time: '10:00', title: '项目方案评审会' },
  { time: '14:30', title: '与产品团队沟通需求' },
  { time: '19:00', title: '健身训练' }
];

export const tomorrowAgenda = [
  { time: '09:30', title: '团队周会' },
  { time: '11:00', title: '客户需求沟通' },
  { time: '16:00', title: '财务报表整理' }
];

export const reminderItems = [
  { time: '10:00', title: '项目方案评审会', note: '会议资料已整理' },
  { time: '14:30', title: '与产品团队沟通需求', note: '有 3 项待确认' },
  { time: '19:00', title: '健身训练', note: '45 分钟力量训练' }
];

export const featureIntroItems = [
  { title: '管理日程', note: '把重要事项交给AI分身提醒', icon: 'calendar-event' },
  { title: '长期记忆', note: '记住你的偏好与关键背景', icon: 'brain' },
  { title: '对话协助', note: '直接说出目标，我来整理下一步', icon: 'message-circle' }
];

export const brainFunctions = [
  { label: '对话', icon: 'message-circle' },
  { label: '记忆', icon: 'brain' },
  { label: '会议', icon: 'calendar-event' },
  { label: '健康', icon: 'heart' },
  { label: '财务', icon: 'wallet' },
  { label: '资料', icon: 'folder' },
  { label: '设置', icon: 'settings' }
];

export const initialMessages = [
  {
    id: 'assistant-welcome',
    role: 'assistant',
    status: 'complete',
    content: '你好，我在这里。你可以直接告诉我想完成的事。'
  }
];

export const longConversation = Array.from({ length: 14 }, (_, index) => ({
  id: `long-${index}`,
  role: index % 2 ? 'assistant' : 'user',
  status: 'complete',
  content: index % 2
    ? `第 ${Math.ceil((index + 1) / 2)} 轮整理完成。\n\n- 已记录关键进展\n- 已标出需要确认的事项\n- 下一步建议保持简洁并逐项推进`
    : `这是第 ${Math.ceil((index + 2) / 2)} 个补充问题，请继续结合前面的上下文整理。`
}));

export const fakeAssistantReply = [
  '今天的工作进展已经整理好：',
  '',
  '1. 完成项目方案的核心结构，并进入评审准备。',
  '2. 与产品团队确认了三项关键需求，剩余一项待明早回复。',
  '3. 财务资料已汇总，明天可以直接开始复核。',
  '',
  '明天建议：先处理待确认事项，再集中完成评审后的修改，下午预留一段不被打断的执行时间。'
];
