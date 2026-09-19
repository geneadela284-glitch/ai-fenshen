export const taskTypes = {
  writing: {
    id: 'writing',
    label: 'Writing',
    keywords: ['文章', '文案', '润色', '改写', '总结', '产品介绍', '邮件', '通知', '写一篇', '写一封']
  },
  reasoning: {
    id: 'reasoning',
    label: 'Reasoning',
    keywords: ['推理', '分析', '比较', '判断', '制定方案', '方案', '风险', '建议', '为什么']
  },
  data_analysis: {
    id: 'data_analysis',
    label: 'Data Analysis',
    keywords: ['excel', '表格', '销售数据', '统计', '排行', '成交率', '异常分析', '门店', '单品', '销售额']
  },
  presentation: {
    id: 'presentation',
    label: 'Presentation',
    keywords: ['ppt', 'PPT', '大纲', '汇报结构', '演示文稿', '季度汇报', '幻灯片']
  },
  general: {
    id: 'general',
    label: 'General',
    keywords: []
  }
};

export const taskDetectionOrder = ['presentation', 'data_analysis', 'writing', 'reasoning'];

export function normalizeTaskInput(request = {}) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const lastMessage = [...messages].reverse().find((message) => message?.role !== 'system')?.content;
  return String(request.input || request.prompt || lastMessage || '').trim();
}
