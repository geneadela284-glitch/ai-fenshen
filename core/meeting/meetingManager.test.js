import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage } from '../storage/memoryStorage.js';
import { MemoryRepository } from '../memory/repository/memoryRepository.js';
import { MemoryService } from '../memory/service/memoryService.js';
import { MeetingManager, MeetingRepository, meetingStatuses } from './index.js';

const now = '2026-07-13T09:00:00.000Z';

function createHarness() {
  const storage = createMemoryStorage();
  const meetingRepository = new MeetingRepository({ storage, namespace: 'test-meeting-foundation' });
  const memoryRepository = new MemoryRepository({ storage, namespace: 'test-meeting-memory', now: () => new Date(now) });
  const memoryService = new MemoryService({ repository: memoryRepository, now: () => new Date(now) });
  const manager = new MeetingManager({
    repository: meetingRepository,
    memoryService,
    now: () => new Date(now)
  });
  return { storage, manager, meetingRepository, memoryRepository };
}

const transcript = [
  '参会人：张三、李四、王总',
  '主题：华南客户续约推进会',
  '决定：华南客户报价12万元，本周五前发送正式报价。',
  '张三负责整理报价单，截止明天18点。',
  '需要准备客户案例。',
  '风险：客户要求交付周期写进合同。'
].join('\n');

test('manages meeting lifecycle and blocks invalid transitions', () => {
  const { manager } = createHarness();
  const created = manager.createMeeting({ title: '华南客户续约会' });
  assert.equal(created.status, meetingStatuses.DRAFT);

  const started = manager.startMeeting(created.id);
  assert.equal(started.status, meetingStatuses.RECORDING);

  const paused = manager.pauseMeeting(created.id);
  assert.equal(paused.status, meetingStatuses.PAUSED);

  const resumed = manager.resumeMeeting(created.id);
  assert.equal(resumed.status, meetingStatuses.RECORDING);

  const invalid = manager.archiveMeeting(created.id);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'MEETING_INVALID_STATUS_TRANSITION');

  const ended = manager.endMeeting(created.id);
  assert.equal(ended.status, meetingStatuses.COMPLETED);
  assert.equal(ended.durationSeconds >= 0, true);
});

test('saves transcript separately and refuses to generate summary without transcript', () => {
  const { manager } = createHarness();
  const meeting = manager.createMeeting({ title: '空会议' });

  const empty = manager.generateSummary(meeting.id);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'MEETING_TRANSCRIPT_REQUIRED');

  const updated = manager.saveTranscript(meeting.id, transcript, { transcriptSource: 'paste' });
  assert.equal(updated.transcript, transcript);
  assert.equal(updated.transcriptSource, 'paste');
  assert.equal(updated.summary, null);
});

test('generates structured summary, decisions, action candidates and risks from pasted transcript', () => {
  const { manager } = createHarness();
  const meeting = manager.createMeeting({ title: '华南客户续约会' });
  manager.saveTranscript(meeting.id, transcript);

  const result = manager.generateSummary(meeting.id);
  assert.equal(result.ok, true);
  assert.equal(result.data.summary.source, 'deterministic');
  assert.deepEqual(result.data.participants, ['张三', '李四', '王总']);
  assert.equal(result.data.decisions.length, 1);
  assert.match(result.data.decisions[0].content, /报价12万元/);
  assert.equal(result.data.actionItems.length, 2);

  const explicitAction = result.data.actionItems.find((item) => item.owner === '张三');
  assert.equal(explicitAction.requiresConfirmation, false);
  assert.match(explicitAction.dueDate, /^\d{4}-\d{2}-\d{2}$/);

  const incompleteAction = result.data.actionItems.find((item) => item.content.includes('客户案例'));
  assert.equal(incompleteAction.requiresConfirmation, true);
  assert.equal(incompleteAction.owner, '未明确');
  assert.equal(incompleteAction.dueDate, '');
  assert.equal(result.data.risks.length, 1);
});

test('keeps memory candidates pending until user confirms and never saves full transcript', () => {
  const { manager, memoryRepository } = createHarness();
  const meeting = manager.createMeeting({ title: '华南客户续约会' });
  manager.saveTranscript(meeting.id, transcript);
  const summarized = manager.generateSummary(meeting.id).data;

  assert.equal(memoryRepository.count(), 0);
  assert.equal(summarized.memoryCandidates.length, 1);

  const saved = manager.confirmMemoryCandidates(meeting.id, [summarized.memoryCandidates[0].id], {
    userId: 'u1'
  });
  assert.equal(saved.ok, true);
  assert.equal(memoryRepository.count(), 1);

  const [record] = memoryRepository.list({ includeDeleted: true });
  assert.match(record.originalText, /华南客户报价12万元/);
  assert.doesNotMatch(record.originalText, /张三负责整理报价单.*需要准备客户案例/s);
  assert.equal(record.sourceType, 'meeting');
  assert.equal(record.sourceId, meeting.id);
});

test('exports markdown without leaking internal ids or provider details', () => {
  const { manager } = createHarness();
  const meeting = manager.createMeeting({ title: '华南客户续约会' });
  manager.saveTranscript(meeting.id, transcript);
  manager.generateSummary(meeting.id);

  const exported = manager.exportMarkdown(meeting.id, { includeTranscript: true });
  assert.match(exported.content, /^# 华南客户续约会/);
  assert.match(exported.content, /## 会议摘要/);
  assert.match(exported.content, /## 待办事项/);
  assert.doesNotMatch(exported.content, /Provider|API Key|meeting-/);
});

test('persists meetings across repository instances and hides archived meetings by default', () => {
  const { storage, manager } = createHarness();
  const meeting = manager.createMeeting({ title: '可归档会议' });
  manager.archiveMeeting(meeting.id, { allowDraft: true });

  const nextRepository = new MeetingRepository({ storage, namespace: 'test-meeting-foundation' });
  const nextManager = new MeetingManager({ repository: nextRepository, now: () => new Date(now) });

  assert.equal(nextManager.listMeetings().length, 0);
  assert.equal(nextManager.listMeetings({ includeArchived: true }).length, 1);
});
