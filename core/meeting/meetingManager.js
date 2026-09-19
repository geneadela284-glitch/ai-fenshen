import { persistentMemoryService } from '../memory/memoryRuntime.js';
import { MeetingActionExtractor } from './meetingActionExtractor.js';
import { MeetingDocumentGenerator } from './meetingDocumentGenerator.js';
import { MeetingMemoryAdapter } from './meetingMemoryAdapter.js';
import { MeetingRepository, meetingRepository } from './meetingRepository.js';
import { createMeetingSession, calculateDurationSeconds } from './meetingSession.js';
import { meetingStatuses, meetingTranscriptSources } from './meetingTypes.js';
import { MeetingSummaryService } from './meetingSummaryService.js';

function fallbackId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function error(code, message, data = null) {
  return { ok: false, code, message, data };
}

function success(code, data) {
  return { ok: true, code, data };
}

const transitions = {
  [meetingStatuses.DRAFT]: [meetingStatuses.RECORDING, meetingStatuses.FAILED],
  [meetingStatuses.RECORDING]: [meetingStatuses.PAUSED, meetingStatuses.COMPLETED, meetingStatuses.FAILED],
  [meetingStatuses.PAUSED]: [meetingStatuses.RECORDING, meetingStatuses.COMPLETED, meetingStatuses.FAILED],
  [meetingStatuses.PROCESSING]: [meetingStatuses.COMPLETED, meetingStatuses.FAILED],
  [meetingStatuses.COMPLETED]: [meetingStatuses.ARCHIVED],
  [meetingStatuses.FAILED]: [meetingStatuses.ARCHIVED],
  [meetingStatuses.ARCHIVED]: []
};

export class MeetingManager {
  constructor({
    repository = meetingRepository,
    summaryService,
    actionExtractor,
    memoryService = persistentMemoryService,
    memoryAdapter,
    documentGenerator = new MeetingDocumentGenerator(),
    now = () => new Date(),
    idFactory = fallbackId
  } = {}) {
    this.repository = repository;
    this.now = now;
    this.idFactory = idFactory;
    this.actionExtractor = actionExtractor || new MeetingActionExtractor({ now });
    this.summaryService = summaryService || new MeetingSummaryService({ actionExtractor: this.actionExtractor, now });
    this.memoryAdapter = memoryAdapter || new MeetingMemoryAdapter({ memoryService, now });
    this.documentGenerator = documentGenerator;
  }

  timestamp() {
    return this.now().toISOString();
  }

  createMeeting(input = {}) {
    return this.repository.create(createMeetingSession(input, { now: this.now, idFactory: this.idFactory }));
  }

  getMeeting(id) {
    return this.repository.read(id);
  }

  listMeetings(options = {}) {
    return this.repository.list(options);
  }

  transition(id, nextStatus, updates = {}, options = {}) {
    const meeting = this.getMeeting(id);
    if (!meeting) return error('MEETING_NOT_FOUND', '会议不存在。');
    const allowed = transitions[meeting.status] || [];
    if (!allowed.includes(nextStatus) && !(options.allowDraft && meeting.status === meetingStatuses.DRAFT && nextStatus === meetingStatuses.ARCHIVED)) {
      return error('MEETING_INVALID_STATUS_TRANSITION', `不能从 ${meeting.status} 切换到 ${nextStatus}。`);
    }
    const updated = this.repository.update(id, {
      ...updates,
      status: nextStatus,
      updatedAt: this.timestamp()
    });
    return updated || error('MEETING_UPDATE_FAILED', '会议状态更新失败。');
  }

  startMeeting(id) {
    return this.transition(id, meetingStatuses.RECORDING, { startedAt: this.timestamp(), errorCode: '' });
  }

  pauseMeeting(id) {
    return this.transition(id, meetingStatuses.PAUSED);
  }

  resumeMeeting(id) {
    return this.transition(id, meetingStatuses.RECORDING);
  }

  endMeeting(id) {
    const meeting = this.getMeeting(id);
    if (!meeting) return error('MEETING_NOT_FOUND', '会议不存在。');
    const endedAt = this.timestamp();
    return this.transition(id, meetingStatuses.COMPLETED, {
      endedAt,
      durationSeconds: calculateDurationSeconds(meeting, endedAt)
    });
  }

  failMeeting(id, errorCode = 'MEETING_FAILED') {
    return this.transition(id, meetingStatuses.FAILED, { errorCode });
  }

  archiveMeeting(id, options = {}) {
    return this.transition(id, meetingStatuses.ARCHIVED, { archivedAt: this.timestamp() }, options);
  }

  saveTranscript(id, transcript = '', options = {}) {
    const meeting = this.getMeeting(id);
    if (!meeting) return error('MEETING_NOT_FOUND', '会议不存在。');
    return this.repository.update(id, {
      transcript: String(transcript || ''),
      transcriptSource: options.transcriptSource || meetingTranscriptSources.PASTE,
      updatedAt: this.timestamp()
    });
  }

  generateSummary(id) {
    const meeting = this.getMeeting(id);
    if (!meeting) return error('MEETING_NOT_FOUND', '会议不存在。');
    const generated = this.summaryService.generate(meeting);
    if (!generated.ok) return generated;
    const data = generated.data;
    const updated = this.repository.update(id, {
      summary: {
        source: data.source,
        generatedAt: data.generatedAt,
        summary: data.summary,
        topics: data.topics,
        unconfirmedItems: data.unconfirmedItems
      },
      decisions: data.decisions,
      actionItems: data.actionItems,
      risks: data.risks,
      followUps: data.followUps,
      participants: data.participants,
      memoryCandidates: data.memoryCandidates,
      updatedAt: this.timestamp()
    });
    return success('MEETING_SUMMARY_GENERATED', updated);
  }

  confirmActionItem(id, actionItemId, updates = {}) {
    const meeting = this.getMeeting(id);
    if (!meeting) return error('MEETING_NOT_FOUND', '会议不存在。');
    const actionItems = meeting.actionItems.map((item) => {
      if (item.id !== actionItemId) return item;
      return {
        ...item,
        ...updates,
        confirmedByUser: true,
        requiresConfirmation: false,
        status: 'confirmed'
      };
    });
    return this.repository.update(id, { actionItems, updatedAt: this.timestamp() });
  }

  confirmMemoryCandidates(id, candidateIds = [], context = {}) {
    const meeting = this.getMeeting(id);
    if (!meeting) return error('MEETING_NOT_FOUND', '会议不存在。');
    const result = this.memoryAdapter.saveConfirmed(meeting, candidateIds, context);
    if (result.ok) {
      const savedIds = new Set(candidateIds);
      this.repository.update(id, {
        memoryCandidates: (meeting.memoryCandidates || []).map((candidate) => (
          savedIds.has(candidate.id) ? { ...candidate, confirmedByUser: true, savedAt: this.timestamp() } : candidate
        )),
        updatedAt: this.timestamp()
      });
    }
    return result;
  }

  exportMarkdown(id, options = {}) {
    const meeting = this.getMeeting(id);
    if (!meeting) return error('MEETING_NOT_FOUND', '会议不存在。');
    return this.documentGenerator.generateMarkdown(meeting, options);
  }
}

export const meetingManager = new MeetingManager();
export { MeetingRepository };
