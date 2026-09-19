import { createHash } from 'node:crypto';

import { MemoryType } from '../kernel/index.js';
import {
  TimelineEventStatus,
  TimelineTimeBasis,
  TimelineVisibility,
  validateTimelineContext,
  validateTimelineEvent,
  validateTimelinePeriod
} from '../timeline/index.js';
import {
  LifeCadence,
  LifeDerivedStatus,
  LifePatternType,
  LifeTrendDirection,
  LifeTrendType,
  createLifePattern,
  createLifeStage,
  createLifeTrend,
  deepFreezeLifeIntelligence
} from './contracts.js';

const DAY = 86400000;
const TREND_TYPES = new Set([
  MemoryType.FACT, MemoryType.RELATIONSHIP, MemoryType.PREFERENCE, MemoryType.GOAL,
  MemoryType.HABIT_ROUTINE, MemoryType.CONSTRAINT, MemoryType.COMMITMENT, MemoryType.DECISION
]);

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function key(event, includeValue) {
  return JSON.stringify([
    event.type,
    event.metadata?.subject,
    event.metadata?.predicate,
    includeValue ? event.metadata?.normalizedValue : null
  ]);
}

function groupBy(events, includeValue) {
  const groups = new Map();
  for (const event of events) {
    const groupKey = key(event, includeValue);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(event);
  }
  return [...groups.values()].map((group) => group.sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id)));
}

function cadence(events) {
  const intervals = events.slice(1).map((event, index) => (Date.parse(event.beginTime) - Date.parse(events[index].beginTime)) / DAY);
  if (intervals.every((days) => days >= 0.5 && days <= 1.5)) return LifeCadence.DAILY;
  if (intervals.every((days) => days >= 5 && days <= 9)) return LifeCadence.WEEKLY;
  if (intervals.every((days) => days >= 25 && days <= 35)) return LifeCadence.MONTHLY;
  return LifeCadence.REPEATED;
}

function evidence(events) {
  return events.map((event) => ({
    memoryId: event.memoryIds[0],
    timelineEventId: event.id,
    observedAt: event.beginTime
  }));
}

export class LifeContextAnalyzer {
  analyze(context, timeline) {
    if (!validateTimelineContext(context).valid || timeline?.ok !== true || !Array.isArray(timeline.events) || !Array.isArray(timeline.periods)) {
      return deepFreezeLifeIntelligence({ ok: false, reasonCode: 'LIFE_INTELLIGENCE_INVALID_CONTEXT', userId: context?.authenticatedUserId || null, events: [], periods: [], conflicts: [], filtered: [] });
    }
    if ([...timeline.events, ...timeline.periods].some((item) => item.userId !== context.authenticatedUserId)) {
      return deepFreezeLifeIntelligence({ ok: false, reasonCode: 'LIFE_INTELLIGENCE_USER_SCOPE_MISMATCH', userId: context.authenticatedUserId, events: [], periods: [], conflicts: [], filtered: [] });
    }
    if (timeline.events.some((event) => !validateTimelineEvent(event, { trustedUserId: context.authenticatedUserId }).valid) ||
        timeline.periods.some((period) => !validateTimelinePeriod(period, { trustedUserId: context.authenticatedUserId }).valid)) {
      return deepFreezeLifeIntelligence({ ok: false, reasonCode: 'LIFE_INTELLIGENCE_INVALID_TIMELINE', userId: context.authenticatedUserId, events: [], periods: [], conflicts: [], filtered: [] });
    }
    const filtered = [];
    const events = timeline.events.filter((event) => {
      let reasonCode = null;
      if (event.visibility === TimelineVisibility.HIDDEN_SENSITIVE) reasonCode = 'LIFE_INTELLIGENCE_SENSITIVE_FILTERED';
      else if (event.status === TimelineEventStatus.CONFLICT) reasonCode = 'LIFE_INTELLIGENCE_CONFLICT_DEFERRED';
      else if (event.metadata?.timeBasis === TimelineTimeBasis.ESTIMATED_CAPTURE) reasonCode = 'LIFE_INTELLIGENCE_ESTIMATED_TIME_FILTERED';
      if (reasonCode) filtered.push({ timelineEventId: event.id, memoryIds: [...event.memoryIds], reasonCode });
      return !reasonCode;
    });
    const periods = timeline.periods.filter((period) => {
      const allowed = period.visibility === TimelineVisibility.VISIBLE && period.status !== TimelineEventStatus.CONFLICT;
      if (!allowed) filtered.push({ timelinePeriodId: period.id, memoryIds: [...period.memoryIds], reasonCode: period.visibility === TimelineVisibility.HIDDEN_SENSITIVE ? 'LIFE_INTELLIGENCE_SENSITIVE_FILTERED' : 'LIFE_INTELLIGENCE_CONFLICT_DEFERRED' });
      return allowed;
    });
    return deepFreezeLifeIntelligence({
      ok: true,
      reasonCode: 'LIFE_INTELLIGENCE_CONTEXT_READY',
      userId: context.authenticatedUserId,
      timestamp: context.timestamp,
      timezone: context.timezone,
      events: structuredClone(events),
      periods: structuredClone(periods),
      conflicts: structuredClone(timeline.conflicts || []),
      filtered
    });
  }
}

export class LifePatternEngine {
  detect(context) {
    if (context?.ok !== true) return deepFreezeLifeIntelligence([]);
    const patterns = [];
    const candidates = context.events.filter((event) => event.type === MemoryType.HABIT_ROUTINE);
    for (const group of groupBy(candidates, true)) {
      const memoryIds = sortedUnique(group.flatMap((event) => event.memoryIds));
      if (group.length < 3 || memoryIds.length < 3) continue;
      const timelineEventIds = group.map((event) => event.id);
      patterns.push(createLifePattern({
        id: `life-pattern-${hash([context.userId, key(group[0], true), memoryIds])}`,
        userId: context.userId,
        patternType: LifePatternType.REPEATED_BEHAVIOR,
        subject: group[0].metadata.subject,
        predicate: group[0].metadata.predicate,
        occurrenceCount: group.length,
        beginTime: group[0].beginTime,
        endTime: group.at(-1).beginTime,
        cadence: cadence(group),
        status: LifeDerivedStatus.OBSERVED,
        confidence: Number((group.reduce((sum, event) => sum + event.confidence, 0) / group.length).toFixed(6)),
        importance: Math.max(...group.map((event) => event.importance)),
        memoryIds,
        timelineEventIds,
        evidence: evidence(group),
        metadata: { derived: true, source: 'timeline', prediction: false }
      }, { trustedUserId: context.userId }));
    }
    return deepFreezeLifeIntelligence(patterns.sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id)));
  }
}

export class LifeTrendEngine {
  detect(context) {
    if (context?.ok !== true) return deepFreezeLifeIntelligence([]);
    const trends = [];
    for (const group of groupBy(context.events.filter((event) => TREND_TYPES.has(event.type)), false)) {
      const memoryIds = sortedUnique(group.flatMap((event) => event.memoryIds));
      const values = new Set(group.map((event) => JSON.stringify(event.metadata.normalizedValue)));
      if (group.length < 2 || memoryIds.length < 2 || values.size < 2) continue;
      trends.push(createLifeTrend({
        id: `life-trend-${hash([context.userId, key(group[0], false), memoryIds])}`,
        userId: context.userId,
        trendType: LifeTrendType.VALUE_CHANGE,
        subject: group[0].metadata.subject,
        predicate: group[0].metadata.predicate,
        beginTime: group[0].beginTime,
        endTime: group.at(-1).beginTime,
        direction: LifeTrendDirection.CHANGED,
        status: LifeDerivedStatus.OBSERVED,
        confidence: Math.min(...group.map((event) => event.confidence)),
        memoryIds,
        timelineEventIds: group.map((event) => event.id),
        evidence: evidence(group),
        metadata: { changeCount: values.size - 1, derived: true, prediction: false, source: 'timeline' }
      }, { trustedUserId: context.userId }));
    }
    return deepFreezeLifeIntelligence(trends.sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id)));
  }
}

export class LifeStageEngine {
  identify(context) {
    if (context?.ok !== true) return deepFreezeLifeIntelligence([]);
    return deepFreezeLifeIntelligence(context.periods.map((period) => {
      const supporting = context.events.filter((event) => event.memoryIds.some((id) => period.memoryIds.includes(id)));
      return createLifeStage({
        id: `life-stage-${hash([context.userId, period.id, period.memoryIds])}`,
        userId: context.userId,
        periodId: period.id,
        title: period.title,
        beginTime: period.beginTime,
        endTime: period.endTime,
        status: LifeDerivedStatus.EXPLICIT,
        confidence: supporting.length ? Math.min(...supporting.map((event) => event.confidence)) : 1,
        memoryIds: [...period.memoryIds],
        timelinePeriodIds: [period.id],
        evidence: period.memoryIds.map((memoryId) => ({ memoryId, timelinePeriodId: period.id, observedAt: period.beginTime })),
        metadata: { derived: true, inferred: false, source: 'timeline_period' }
      }, { trustedUserId: context.userId });
    }).sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.id.localeCompare(right.id)));
  }
}

export class LifeEvolutionTracker {
  track({ patterns = [], trends = [], stages = [] } = {}) {
    const markers = [
      ...patterns.map((item) => ({ kind: 'pattern', sourceId: item.id, beginTime: item.beginTime, endTime: item.endTime, memoryIds: [...item.memoryIds] })),
      ...trends.map((item) => ({ kind: 'trend', sourceId: item.id, beginTime: item.beginTime, endTime: item.endTime, memoryIds: [...item.memoryIds] })),
      ...stages.map((item) => ({ kind: 'stage', sourceId: item.id, beginTime: item.beginTime, endTime: item.endTime, memoryIds: [...item.memoryIds] }))
    ];
    markers.sort((left, right) => left.beginTime.localeCompare(right.beginTime) || left.kind.localeCompare(right.kind) || left.sourceId.localeCompare(right.sourceId));
    return deepFreezeLifeIntelligence(markers);
  }
}
