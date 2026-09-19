import { buildMeetingAnalysisViewModel } from '../components/meeting/meetingAnalysisUiModel.js';
import { createMeetingAnalysisModelClient } from './meetingAnalysisModelClient.js';

const MAX_REFINEMENT_REQUEST_CHARS = 2_000;

export const MEETING_ANALYSIS_REFINEMENT_SYSTEM_PROMPT = [
  '你是 AI分身 的会议整理助手。',
  '只对已确认的会议整理做表达、结构和重点层面的微调。',
  '不得新增原文没有的事实、负责人、日期、金额、决定或承诺。',
  '如果用户要求改变事实，请明确说明只能调整表达，不能替换已确认事实。',
  '只输出给用户阅读的整理草稿，不输出技术字段、模型信息或权限信息。'
].join('\n');

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function text(value) {
  return String(value ?? '').trim();
}

function listText(items, render = (item) => item.content) {
  return items.length ? items.map((item, index) => `${index + 1}. ${text(render(item))}`).join('\n') : '无';
}

function defaultIdFactory() {
  return globalThis.crypto?.randomUUID?.()
    || `refinement-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildMeetingAnalysisRefinementInput({ analysis, request } = {}) {
  const model = buildMeetingAnalysisViewModel(analysis);
  if (!model.displayable) throw codedError('MEETING_ANALYSIS_REFINEMENT_UNAVAILABLE');
  const normalizedRequest = text(request);
  if (!normalizedRequest || normalizedRequest.length > MAX_REFINEMENT_REQUEST_CHARS) {
    throw codedError('MEETING_ANALYSIS_REFINEMENT_REQUEST_INVALID');
  }
  return [
    '下面是已经通过会议原文校验的整理结果，请按用户要求生成一份未保存的表达草稿。',
    '',
    `会议主题：${text(model.summary.topic)}`,
    `核心讨论：${text(model.summary.overview)}`,
    `讨论重点：\n${listText(model.summary.keyPoints)}`,
    `最终结论：\n${listText(model.summary.conclusions)}`,
    `未决问题：\n${listText(model.summary.openQuestions)}`,
    `会议决定：\n${listText(model.decisions, (item) => `${item.content}（${item.statusLabel}）`)}`,
    `后续行动：\n${listText(model.actionItems, (item) => `${item.content}｜负责人：${item.ownerLabel}｜截止日期：${item.dueDateLabel}`)}`,
    '',
    `用户要求：${normalizedRequest}`
  ].join('\n');
}

export function createMeetingAnalysisRefinementClient({ modelClient = null, idFactory = defaultIdFactory } = {}) {
  const runModel = typeof modelClient === 'function' ? modelClient : createMeetingAnalysisModelClient();
  return async function refineMeetingAnalysis({ analysis, request } = {}) {
    const input = buildMeetingAnalysisRefinementInput({ analysis, request });
    const response = await runModel({
      input,
      messages: [
        { role: 'system', content: MEETING_ANALYSIS_REFINEMENT_SYSTEM_PROMPT },
        { role: 'user', content: input }
      ],
      metadata: { clientRequestId: `meeting-refinement-${idFactory()}` }
    });
    const content = text(response?.content);
    if (!content) throw codedError('MEETING_ANALYSIS_REFINEMENT_EMPTY');
    return Object.freeze({ content, persisted: false });
  };
}
