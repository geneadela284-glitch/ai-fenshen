import { MeetingActionExtractor } from './meetingActionExtractor.js';

function lines(transcript = '') {
  return String(transcript || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
}

function extractParticipants(items = []) {
  const explicit = items.find((line) => /^参会人[:：]/.test(line));
  if (explicit) {
    return explicit.replace(/^参会人[:：]\s*/, '').split(/[、,，\s]+/).map((name) => name.trim()).filter(Boolean);
  }
  return [...new Set(items.map((line) => line.match(/^([\u4e00-\u9fa5A-Za-z]{2,8})[:：]/)?.[1]).filter(Boolean))];
}

function extractPrefixed(items = [], pattern, stripPattern) {
  return items
    .filter((line) => pattern.test(line))
    .map((line, index) => ({
      id: `${stripPattern}-${index + 1}`,
      content: line.replace(pattern, '').trim(),
      sourceQuote: line,
      confirmedByUser: false,
      aiInferred: false
    }))
    .filter((item) => item.content);
}

function extractTopics(items = []) {
  const topic = items.find((line) => /^主题[:：]/.test(line));
  if (topic) return [topic.replace(/^主题[:：]\s*/, '').trim()].filter(Boolean);
  return items.slice(0, 2);
}

function buildMemoryCandidates(decisions = []) {
  return decisions.map((decision, index) => ({
    id: `meeting-memory-${index + 1}`,
    type: 'decision',
    content: decision.content,
    sourceQuote: decision.sourceQuote,
    confirmedByUser: false,
    requiresConfirmation: true
  }));
}

export class MeetingSummaryService {
  constructor({ actionExtractor = new MeetingActionExtractor(), now = () => new Date() } = {}) {
    this.actionExtractor = actionExtractor;
    this.now = now;
  }

  generate(meeting = {}) {
    const transcript = String(meeting.transcript || '').trim();
    if (!transcript) {
      return {
        ok: false,
        code: 'MEETING_TRANSCRIPT_REQUIRED',
        message: '无会议原文时不能生成真实会议纪要。'
      };
    }

    const sourceLines = lines(transcript);
    const participants = extractParticipants(sourceLines);
    const decisions = extractPrefixed(sourceLines, /^(决定|结论|确认|最终决策)[:：]?\s*/, 'decision');
    const risks = extractPrefixed(sourceLines, /^(风险|风险点)[:：]?\s*/, 'risk');
    const actionItems = this.actionExtractor.extract(transcript);
    const topics = extractTopics(sourceLines);
    const summaryText = decisions.length
      ? `本次会议围绕${topics[0] || '当前事项'}形成了${decisions.length}项明确决策，并整理出${actionItems.length}个待办候选。`
      : `本次会议围绕${topics[0] || '当前事项'}进行讨论，当前未识别到明确决策。`;
    const unconfirmedItems = [
      ...actionItems.filter((item) => item.requiresConfirmation).map((item) => `待办需确认：${item.content}`),
      ...(participants.length ? [] : ['参会人未明确'])
    ];

    return {
      ok: true,
      data: {
        title: meeting.title || '未命名会议',
        source: 'deterministic',
        generatedAt: this.now().toISOString(),
        participants,
        summary: summaryText,
        topics,
        decisions,
        actionItems,
        risks,
        followUps: actionItems.filter((item) => item.requiresConfirmation).map((item) => item.content),
        unconfirmedItems,
        memoryCandidates: buildMemoryCandidates(decisions)
      }
    };
  }
}
