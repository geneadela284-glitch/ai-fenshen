import { MemoryGovernanceService } from '../memory/governance/memoryGovernanceService.js';

export class MeetingMemoryAdapter {
  constructor({ memoryService, governance, now = () => new Date() } = {}) {
    this.memoryService = memoryService;
    this.governance = governance || (memoryService ? new MemoryGovernanceService({ memory: memoryService, now }) : null);
  }

  buildCandidates(meeting = {}) {
    return (meeting.memoryCandidates || []).map((candidate) => ({
      ...candidate,
      confirmedByUser: Boolean(candidate.confirmedByUser),
      requiresConfirmation: true
    }));
  }

  saveConfirmed(meeting = {}, candidateIds = [], context = {}) {
    if (!this.memoryService) {
      return { ok: false, code: 'MEETING_MEMORY_SERVICE_UNAVAILABLE', saved: [], failed: [] };
    }
    const ids = new Set(candidateIds);
    const candidates = this.buildCandidates(meeting).filter((candidate) => ids.has(candidate.id));
    const saved = [];
    const failed = [];

    candidates.forEach((candidate) => {
      const input = `记一下，会议决策：${candidate.content}`;
      const memoryContext = {
        ...context,
        sourceType: 'meeting',
        sourceId: meeting.id,
        currentTime: context.currentTime || new Date().toISOString(),
        metadata: {
          ...(context.metadata || {}),
          meetingTitle: meeting.title,
          sourceQuote: candidate.sourceQuote
        }
      };
      const prepared = this.memoryService.prepare(input, memoryContext);
      let result = prepared;
      if (prepared.requiresConfirmation && prepared.candidateId) {
        result = this.memoryService.confirm(prepared.candidateId, { confirmedByUser: true, sourceType: 'meeting', sourceId: meeting.id });
      } else if (prepared.ok && prepared.action === 'prepared') {
        result = this.memoryService.remember(input, { context: memoryContext });
      }

      if (result.ok) {
        saved.push({ candidateId: candidate.id, memoryId: result.memoryId, result });
      } else {
        failed.push({ candidateId: candidate.id, result });
      }
    });

    return { ok: failed.length === 0, code: failed.length ? 'MEETING_MEMORY_PARTIAL_FAILURE' : 'MEETING_MEMORY_SAVED', saved, failed };
  }
}
