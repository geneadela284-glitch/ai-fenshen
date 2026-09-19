import { createHash } from 'node:crypto';

import {
  MemoryConfirmation,
  MemorySensitivity,
  MemoryStatus,
  MemoryType,
  validateMemoryRecord
} from '../kernel/index.js';
import {
  TimelineEventStatus,
  TimelineTimeBasis,
  TimelineVisibility,
  createTimelineEvent,
  createTimelinePeriod,
  deepFreezeTimeline
} from './contracts.js';

const HISTORICAL = new Set([MemoryStatus.SUPERSEDED, MemoryStatus.EXPIRED, MemoryStatus.ARCHIVED]);
const ALLOWED_CONFIRMATION = new Set([
  MemoryConfirmation.USER_CONFIRMED,
  MemoryConfirmation.SYSTEM_VERIFIED,
  MemoryConfirmation.NOT_REQUIRED
]);
const TYPE_TITLE = Object.freeze({
  fact: '人生事实', relationship: '关系', preference: '偏好', goal: '目标',
  life_event: '人生事件', habit_routine: '习惯与日常', constraint: '约束',
  commitment: '承诺', decision: '决定', context: '阶段上下文',
  memory_candidate: '记忆候选', sensitive_memory: '敏感人生事件'
});
const PROHIBITED_TEXT = /(?:password|api[ _-]*key|cookie|(?:access|refresh|session)[ _-]*token|private[ _-]*key|recovery[ _-]*code|密码|私钥|恢复码|完整银行卡号|完整身份证|\bsk-[a-z0-9_-]{20,}\b|\beyJ[a-z0-9_-]{16,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function text(value) {
  if (typeof value === 'string') return value.trim();
  try { return JSON.stringify(value); } catch { return ''; }
}

function statusFor(record, conflict) {
  if (conflict || record.status === MemoryStatus.DISPUTED) return TimelineEventStatus.CONFLICT;
  if (HISTORICAL.has(record.status)) return TimelineEventStatus.HISTORICAL;
  return TimelineEventStatus.CURRENT;
}

function eligible(record, includeHistorical) {
  if ([MemoryStatus.CANDIDATE, MemoryStatus.PENDING_CONFIRMATION, MemoryStatus.DELETED].includes(record.status)) return false;
  if (HISTORICAL.has(record.status) && !includeHistorical) return false;
  return record.status === MemoryStatus.CONFIRMED || record.status === MemoryStatus.DISPUTED || HISTORICAL.has(record.status);
}

function time(record) {
  if (record.metadata?.timeline?.captureTimeOnly === true) {
    return {
      beginTime: record.createdAt,
      endTime: null,
      timeBasis: TimelineTimeBasis.ESTIMATED_CAPTURE,
      estimated: true
    };
  }
  return {
    beginTime: record.effectiveFrom,
    endTime: record.effectiveTo ?? null,
    timeBasis: TimelineTimeBasis.EFFECTIVE,
    estimated: false
  };
}

function identity(record, range) {
  return hash({
    type: record.memoryType,
    subject: record.subject,
    predicate: record.predicate,
    normalizedValue: record.normalizedValue,
    beginTime: range.beginTime,
    endTime: range.endTime
  });
}

function safeContent(record) {
  const sensitive = [MemorySensitivity.HIGH, MemorySensitivity.RESTRICTED].includes(record.sensitivity);
  const value = text(record.value);
  if (sensitive) {
    return {
      title: '敏感人生事件',
      summary: '存在一条敏感人生事件，正文已隐藏。',
      visibility: TimelineVisibility.HIDDEN_SENSITIVE
    };
  }
  return {
    title: TYPE_TITLE[record.memoryType] || '人生记忆',
    summary: value || TYPE_TITLE[record.memoryType] || '人生记忆',
    visibility: TimelineVisibility.VISIBLE
  };
}

function eventFromRecord(record, conflict) {
  const range = time(record);
  const content = safeContent(record);
  const visibleMetadata = content.visibility === TimelineVisibility.VISIBLE ? {
    subject: record.subject,
    predicate: record.predicate,
    normalizedValue: structuredClone(record.normalizedValue),
    tags: [...(record.tags || [])],
    periodIds: record.metadata?.timeline?.period?.id ? [record.metadata.timeline.period.id] : []
  } : { periodIds: record.metadata?.timeline?.period?.id ? [record.metadata.timeline.period.id] : [] };
  return createTimelineEvent({
    id: `timeline-event-${record.id}`,
    userId: record.userId,
    memoryIds: [record.id],
    title: content.title,
    summary: content.summary,
    type: record.memoryType,
    beginTime: range.beginTime,
    endTime: range.endTime,
    status: statusFor(record, conflict),
    confidence: record.confidence,
    importance: record.importance,
    visibility: content.visibility,
    sourceCount: 1,
    version: record.version,
    metadata: {
      derived: true,
      timeBasis: range.timeBasis,
      estimated: range.estimated,
      identityHash: identity(record, range),
      conflictGroupId: record.conflictGroupId ?? null,
      sourceTypes: [record.source.type],
      sourceIdHashes: [hash(record.source.id)],
      ...visibleMetadata
    }
  }, { trustedUserId: record.userId });
}

function periodFromRecord(record, event) {
  const period = record.metadata?.timeline?.period;
  if (!period || typeof period !== 'object' || typeof period.id !== 'string' || !period.id.trim() || typeof period.title !== 'string' || !period.title.trim()) return null;
  return createTimelinePeriod({
    id: period.id,
    userId: record.userId,
    memoryIds: [record.id],
    title: event.visibility === TimelineVisibility.HIDDEN_SENSITIVE ? '敏感人生阶段' : period.title.trim(),
    beginTime: event.beginTime,
    endTime: event.endTime,
    status: event.status,
    visibility: event.visibility,
    version: record.version,
    metadata: { derived: true, explicitlyDeclared: true, timeBasis: event.metadata.timeBasis }
  }, { trustedUserId: record.userId });
}

function mergePeriods(periods) {
  const groups = new Map();
  for (const period of periods) {
    if (!groups.has(period.id)) groups.set(period.id, []);
    groups.get(period.id).push(period);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const memoryIds = [...new Set(group.flatMap((period) => period.memoryIds))].sort();
    const beginTime = group.map((period) => period.beginTime).sort()[0];
    const ends = group.map((period) => period.endTime).filter(Boolean).sort();
    const hidden = group.some((period) => period.visibility === TimelineVisibility.HIDDEN_SENSITIVE);
    return createTimelinePeriod({
      ...structuredClone(group[0]),
      memoryIds,
      title: hidden ? '敏感人生阶段' : group[0].title,
      beginTime,
      endTime: ends.at(-1) || null,
      visibility: hidden ? TimelineVisibility.HIDDEN_SENSITIVE : group[0].visibility,
      version: Math.max(...group.map((period) => period.version))
    }, { trustedUserId: group[0].userId });
  }).sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id));
}

export class TimelineBuilder {
  build(records = [], { userId, includeHistorical = false } = {}) {
    const excluded = [];
    const valid = [];
    for (const record of Array.isArray(records) ? records : []) {
      if (record?.userId !== userId) {
        excluded.push({ memoryId: record?.id ?? null, reasonCode: 'TIMELINE_USER_SCOPE_EXCLUDED' });
        continue;
      }
      if (record.sensitivity === MemorySensitivity.RESTRICTED) {
        excluded.push({ memoryId: record.id, reasonCode: 'TIMELINE_PROHIBITED_EXCLUDED' });
        continue;
      }
      if (PROHIBITED_TEXT.test(text(record.value)) || PROHIBITED_TEXT.test(text(record.normalizedValue))) {
        excluded.push({ memoryId: record.id, reasonCode: 'TIMELINE_PROHIBITED_EXCLUDED' });
        continue;
      }
      if (record.memoryType === MemoryType.MEMORY_CANDIDATE) {
        excluded.push({ memoryId: record.id, reasonCode: 'TIMELINE_CANDIDATE_EXCLUDED' });
        continue;
      }
      const validation = validateMemoryRecord(record, { trustedUserId: userId });
      if (!validation.valid) {
        excluded.push({ memoryId: record.id ?? null, reasonCode: 'TIMELINE_INVALID_MEMORY' });
        continue;
      }
      if (!eligible(record, includeHistorical) || !ALLOWED_CONFIRMATION.has(record.confirmationStatus)) {
        excluded.push({ memoryId: record.id, reasonCode: 'TIMELINE_MEMORY_NOT_ELIGIBLE' });
        continue;
      }
      if (record.accessPolicy?.governanceMode === 'archived_only' || record.accessPolicy?.timelineVisible === false) {
        excluded.push({ memoryId: record.id, reasonCode: 'TIMELINE_ACCESS_EXCLUDED' });
        continue;
      }
      valid.push(record);
    }

    const conflictCounts = new Map();
    for (const record of valid) if (record.conflictGroupId) conflictCounts.set(record.conflictGroupId, (conflictCounts.get(record.conflictGroupId) || 0) + 1);
    const events = valid.map((record) => eventFromRecord(record, Boolean(record.conflictGroupId && conflictCounts.get(record.conflictGroupId) > 1)));
    events.sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id));
    const periods = mergePeriods(valid.map((record, index) => periodFromRecord(record, events.find((event) => event.memoryIds[0] === record.id) || events[index])).filter(Boolean));
    const conflicts = [...conflictCounts.entries()].filter(([, count]) => count > 1).map(([conflictGroupId]) => ({
      conflictGroupId,
      memoryIds: valid.filter((record) => record.conflictGroupId === conflictGroupId).map((record) => record.id).sort(),
      resolution: 'governance_required'
    }));
    return deepFreezeTimeline({ events, periods, conflicts, excluded });
  }
}

export class TimelineMerge {
  merge(events = []) {
    const groups = new Map();
    for (const event of events) {
      const key = event.status === TimelineEventStatus.CONFLICT ? `conflict:${event.id}` : event.metadata.identityHash;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(event);
    }
    const merged = [];
    const merges = [];
    for (const group of groups.values()) {
      if (group.length === 1) { merged.push(group[0]); continue; }
      const memoryIds = [...new Set(group.flatMap((event) => event.memoryIds))].sort();
      const sourceTypes = [...new Set(group.flatMap((event) => event.metadata.sourceTypes || []))].sort();
      const sourceIdHashes = [...new Set(group.flatMap((event) => event.metadata.sourceIdHashes || []))].sort();
      const periodIds = [...new Set(group.flatMap((event) => event.metadata.periodIds || []))].sort();
      const event = createTimelineEvent({
        ...structuredClone(group[0]),
        id: `timeline-event-merged-${hash(memoryIds).slice(0, 16)}`,
        memoryIds,
        confidence: Math.max(...group.map((item) => item.confidence)),
        importance: Math.max(...group.map((item) => item.importance)),
        sourceCount: sourceIdHashes.length || group.reduce((sum, item) => sum + item.sourceCount, 0),
        version: Math.max(...group.map((item) => item.version)),
        metadata: { ...structuredClone(group[0].metadata), sourceTypes, sourceIdHashes, periodIds, merged: true }
      }, { trustedUserId: group[0].userId });
      merged.push(event);
      merges.push({ memoryIds, eventId: event.id, reasonCode: 'TIMELINE_EXACT_DUPLICATE_MERGE' });
    }
    merged.sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id));
    return deepFreezeTimeline({ events: merged, merges });
  }
}
