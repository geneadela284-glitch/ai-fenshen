import {
  meetingActionStatuses,
  meetingPriorities,
  meetingStatuses,
  meetingTranscriptSources
} from './meetingTypes.js';

function fallbackId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createMeetingSession(input = {}, { now = () => new Date(), idFactory = fallbackId } = {}) {
  const timestamp = now().toISOString();
  return normalizeMeeting({
    id: input.id || idFactory('meeting'),
    title: String(input.title || '未命名会议').trim() || '未命名会议',
    status: input.status || meetingStatuses.DRAFT,
    startedAt: input.startedAt || '',
    endedAt: input.endedAt || '',
    durationSeconds: Number(input.durationSeconds || 0),
    sourceType: input.sourceType || 'manual',
    transcript: input.transcript || '',
    transcriptSource: input.transcriptSource || '',
    summary: input.summary || null,
    decisions: input.decisions || [],
    actionItems: input.actionItems || [],
    risks: input.risks || [],
    followUps: input.followUps || [],
    participants: input.participants || [],
    memoryCandidates: input.memoryCandidates || [],
    createdAt: input.createdAt || timestamp,
    updatedAt: input.updatedAt || timestamp,
    archivedAt: input.archivedAt || '',
    errorCode: input.errorCode || '',
    metadata: input.metadata || {}
  });
}

export function normalizeMeeting(meeting = {}) {
  return {
    ...meeting,
    title: String(meeting.title || '未命名会议').trim() || '未命名会议',
    status: Object.values(meetingStatuses).includes(meeting.status) ? meeting.status : meetingStatuses.DRAFT,
    durationSeconds: Number.isFinite(Number(meeting.durationSeconds)) ? Number(meeting.durationSeconds) : 0,
    transcript: String(meeting.transcript || ''),
    transcriptSource: meeting.transcriptSource || (meeting.transcript ? meetingTranscriptSources.PASTE : ''),
    summary: meeting.summary || null,
    decisions: Array.isArray(meeting.decisions) ? meeting.decisions : [],
    actionItems: Array.isArray(meeting.actionItems) ? meeting.actionItems.map(normalizeActionItem) : [],
    risks: Array.isArray(meeting.risks) ? meeting.risks : [],
    followUps: Array.isArray(meeting.followUps) ? meeting.followUps : [],
    participants: Array.isArray(meeting.participants) ? meeting.participants : [],
    memoryCandidates: Array.isArray(meeting.memoryCandidates) ? meeting.memoryCandidates : [],
    metadata: meeting.metadata && typeof meeting.metadata === 'object' ? meeting.metadata : {}
  };
}

export function createActionItem(input = {}, index = 0) {
  return normalizeActionItem({
    id: input.id || `action-${index + 1}`,
    content: input.content || '',
    owner: input.owner || '未明确',
    dueDate: input.dueDate || '',
    priority: input.priority || meetingPriorities.NORMAL,
    status: input.status || meetingActionStatuses.CANDIDATE,
    sourceQuote: input.sourceQuote || '',
    confirmedByUser: Boolean(input.confirmedByUser),
    requiresConfirmation: Boolean(input.requiresConfirmation)
  });
}

export function normalizeActionItem(item = {}) {
  const owner = String(item.owner || '未明确').trim() || '未明确';
  const dueDate = String(item.dueDate || '').trim();
  return {
    id: item.id || fallbackId('meeting-action'),
    content: String(item.content || '').trim(),
    owner,
    dueDate,
    priority: Object.values(meetingPriorities).includes(item.priority) ? item.priority : meetingPriorities.NORMAL,
    status: Object.values(meetingActionStatuses).includes(item.status) ? item.status : meetingActionStatuses.CANDIDATE,
    sourceQuote: String(item.sourceQuote || '').trim(),
    confirmedByUser: Boolean(item.confirmedByUser),
    requiresConfirmation: item.requiresConfirmation ?? (owner === '未明确' || !dueDate)
  };
}

export function calculateDurationSeconds(meeting = {}, endedAt = '') {
  const start = Date.parse(meeting.startedAt || '');
  const end = Date.parse(endedAt || meeting.endedAt || '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return Number(meeting.durationSeconds || 0);
  return Math.max(0, Math.round((end - start) / 1000));
}
