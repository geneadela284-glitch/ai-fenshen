import { buildMeetingAnalysisViewModel } from '../components/meeting/meetingAnalysisUiModel.js';
import { exportResultToWord } from './resultExports.js';

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function text(value, fallback = '未明确') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function list(items, render = (item) => item.content) {
  return items.length ? items.map((item) => `- ${text(render(item))}`).join('\n') : '- 未明确';
}

export function buildMeetingAnalysisMarkdown(analysis, { title = '会议整理' } = {}) {
  const model = buildMeetingAnalysisViewModel(analysis);
  if (!model.displayable) throw codedError('MEETING_ANALYSIS_EXPORT_UNAVAILABLE');
  const meetingTitle = text(title, '会议整理');
  return [
    `# ${meetingTitle}`,
    '',
    '> 这份会议整理来自已通过原文证据校验的当前版本。',
    '',
    '## 会议摘要',
    `**会议主题：** ${text(model.summary.topic)}`,
    '',
    `**核心讨论：** ${text(model.summary.overview)}`,
    '',
    '## 主要讨论',
    list(model.summary.keyPoints),
    '',
    '## 最终结论',
    list(model.summary.conclusions),
    '',
    '## 未决问题',
    list(model.summary.openQuestions),
    '',
    '## 会议决定',
    list(model.decisions, (item) => `${item.content}（${item.statusLabel}）`),
    '',
    '## 后续行动',
    list(model.actionItems, (item) => `${item.content}｜负责人：${item.ownerLabel}｜截止日期：${item.dueDateLabel}`)
  ].join('\n');
}

export function exportMeetingAnalysisToWord(title, analysis, { exportWord = exportResultToWord } = {}) {
  const markdown = buildMeetingAnalysisMarkdown(analysis, { title });
  return exportWord(text(title, '会议整理'), markdown);
}
