export const CAPABILITIES = {
  CHAT: 'CHAT',
  WRITING: 'WRITE',
  REASONING: 'REASONING',
  SUMMARIZATION: 'SUMMARY',
  STRUCTURED_EXTRACTION: 'STRUCTURED_EXTRACTION',
  DATA_ANALYSIS: 'REPORT',
  TRANSLATION: 'TRANSLATE',
  MEETING_SUMMARY: 'MEETING_SUMMARY',
  WRITE: 'WRITE',
  SUMMARY: 'SUMMARY',
  OCR: 'OCR',
  VISION: 'VISION',
  SEARCH: 'SEARCH',
  REPORT: 'REPORT',
  CODE: 'CODE',
  TRANSLATE: 'TRANSLATE',
  WORKFLOW: 'WORKFLOW'
};

export const capabilityLabels = {
  CHAT: '对话',
  WRITING: '写作',
  REASONING: '推理',
  SUMMARIZATION: '总结',
  STRUCTURED_EXTRACTION: '结构化提取',
  DATA_ANALYSIS: '数据分析',
  TRANSLATION: '翻译',
  MEETING_SUMMARY: '会议总结',
  WRITE: '写作',
  SUMMARY: '总结',
  OCR: 'OCR',
  VISION: '视觉',
  SEARCH: '搜索',
  REPORT: '报告',
  CODE: '代码',
  TRANSLATE: '翻译',
  WORKFLOW: '工作流'
};

export const capabilityRequirements = {
  CHAT: ['Writing'],
  WRITE: ['Writing'],
  SUMMARY: ['Writing'],
  OCR: ['OCR'],
  VISION: ['Vision'],
  SEARCH: ['Search'],
  REPORT: ['Presentation', 'Writing'],
  CODE: ['Coding'],
  TRANSLATE: ['Translation'],
  WORKFLOW: ['Workflow']
};

export const defaultRoutePolicy = {
  CHAT: { providerId: 'deepseek', model: 'deepseek-v4-flash' },
  REASONING: { providerId: 'deepseek', model: 'deepseek-reasoner' },
  STRUCTURED_EXTRACTION: { providerId: 'qwen', model: 'qwen-plus' },
  MEETING_SUMMARY: { providerId: 'kimi', model: 'moonshot-v1-32k' },
  WRITE: { providerId: 'deepseek', model: 'deepseek-v4-flash' },
  SUMMARY: { providerId: 'deepseek', model: 'deepseek-v4-flash' },
  REPORT: { providerId: 'deepseek', model: 'deepseek-v4-flash' },
  OCR: { providerId: 'qwen', model: 'qwen3.5-ocr' },
  VISION: { providerId: 'qwen', model: 'qwen3-vl-plus' },
  CODE: { providerId: 'claude', model: 'claude-sonnet', reserved: true },
  TRANSLATE: { providerId: 'claude', model: 'claude-sonnet', reserved: true },
  SEARCH: { providerId: 'qwen', model: 'qwen-plus', reserved: true },
  WORKFLOW: { providerId: 'deepseek', model: 'deepseek-v4-flash' }
};

export function normalizeCapability(capability = '') {
  const value = String(capability || '').trim().toUpperCase();
  return CAPABILITIES[value] || CAPABILITIES.CHAT;
}

export default CAPABILITIES;
