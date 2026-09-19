import { createActionItem } from './meetingSession.js';
import { meetingPriorities } from './meetingTypes.js';

const ACTION_RE = /(负责|跟进|处理|完成|准备|整理|待办|需要|请)/;
const HIGH_PRIORITY_RE = /(紧急|高优先级|今天|必须|风险)/;

function startOfToday(now) {
  const date = now instanceof Date ? new Date(now) : new Date(now || Date.now());
  date.setHours(0, 0, 0, 0);
  return date;
}

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function resolveDueDate(line = '', now = new Date()) {
  const date = startOfToday(now);
  if (/今天/.test(line)) return isoDate(date);
  if (/明天/.test(line)) {
    date.setDate(date.getDate() + 1);
    return isoDate(date);
  }
  if (/后天/.test(line)) {
    date.setDate(date.getDate() + 2);
    return isoDate(date);
  }
  const explicit = line.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/);
  if (explicit) return `${explicit[1]}-${explicit[2].padStart(2, '0')}-${explicit[3].padStart(2, '0')}`;
  return '';
}

function cleanActionContent(line = '') {
  return line
    .replace(/^[-*\d.、\s]+/, '')
    .replace(/^(请|待办[:：]?|需要)\s*/, '')
    .replace(/截止.*$/, '')
    .replace(/，$/, '')
    .trim();
}

function extractOwner(line = '') {
  const match = line.match(/^(.+?)(?:负责|跟进|处理|完成|准备|整理)/);
  const owner = String(match?.[1] || '').trim();
  if (!owner || /^(请|需要|待办)$/.test(owner)) return '未明确';
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(owner) || /^[A-Za-z]{2,20}$/.test(owner)) return owner;
  return '未明确';
}

export class MeetingActionExtractor {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
  }

  extract(transcript = '') {
    return String(transcript || '')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line && ACTION_RE.test(line))
      .map((line, index) => {
        const owner = extractOwner(line);
        const dueDate = resolveDueDate(line, this.now());
        const content = cleanActionContent(line);
        return createActionItem({
          id: `meeting-action-${index + 1}`,
          content,
          owner,
          dueDate,
          priority: HIGH_PRIORITY_RE.test(line) ? meetingPriorities.HIGH : meetingPriorities.NORMAL,
          sourceQuote: line,
          requiresConfirmation: owner === '未明确' || !dueDate
        }, index);
      })
      .filter((item) => item.content);
  }
}
