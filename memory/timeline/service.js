import { MemorySensitivity, validateMemoryRepositoryInterface } from '../kernel/index.js';
import { TimelineBuilder, TimelineMerge } from './builder.js';
import {
  TimelineAuditAction,
  deepFreezeTimeline,
  normalizeTimelineQuery,
  toTimelineRepositoryContext,
  validateTimelineContext
} from './contracts.js';
import { TimelineFilter } from './query.js';
import { TimelineRenderer } from './renderer.js';

export class MemoryLifeTimelineService {
  constructor({ repository, clock = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!repository || !validateMemoryRepositoryInterface(repository).valid) throw new TypeError('MemoryLifeTimelineService requires a MemoryRepository.');
    this.repository = repository;
    this.clock = clock;
    this.idFactory = idFactory;
    this.builder = new TimelineBuilder();
    this.merge = new TimelineMerge();
    this.filter = new TimelineFilter();
    this.renderer = new TimelineRenderer();
    this.auditEvents = [];
  }

  _now() {
    const value = this.clock();
    return (value instanceof Date ? value : new Date(value)).toISOString();
  }

  _audit(context, action, reasonCode, values = {}) {
    const event = deepFreezeTimeline({
      id: `timeline-audit-${this.idFactory()}`,
      userId: context.authenticatedUserId,
      actor: { type: context.actorType, id: context.actorId },
      action,
      timestamp: this._now(),
      reasonCode,
      memoryIds: [...new Set(values.memoryIds || [])].sort(),
      counts: { selected: values.selected || 0, excluded: values.excluded || 0 },
      metadata: {}
    });
    this.auditEvents.push(event);
    return event;
  }

  _failure(context, code) {
    const safeContext = {
      authenticatedUserId: context?.authenticatedUserId || '',
      actorType: context?.actorType || 'system',
      actorId: context?.actorId || 'timeline',
      timestamp: context?.timestamp || this._now()
    };
    const event = this._audit(safeContext, TimelineAuditAction.FAILED, code);
    return deepFreezeTimeline({
      ok: false,
      reasonCode: code,
      query: null,
      events: [], periods: [], conflicts: [], excluded: [], segments: [],
      auditEvents: [event],
      error: { code }
    });
  }

  async _read(context, query) {
    const records = [];
    let cursor = null;
    do {
      const page = await this.repository.query(toTimelineRepositoryContext(context), {
        userId: context.authenticatedUserId,
        includeHistorical: query.includeHistorical,
        includeCandidates: false,
        sensitivityMax: MemorySensitivity.HIGH,
        limit: 100,
        cursor,
        sort: 'createdAt:asc',
        ...(query.memoryTypes.length ? { memoryTypes: query.memoryTypes } : {})
      });
      records.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return records;
  }

  async _execute(context, queryInput, operation) {
    if (!validateTimelineContext(context).valid) return this._failure(context, 'TIMELINE_INVALID_CONTEXT');
    let query;
    try { query = normalizeTimelineQuery(queryInput); } catch { return this._failure(context, 'TIMELINE_INVALID_QUERY'); }
    let records;
    try { records = await this._read(context, query); } catch { return this._failure(context, 'TIMELINE_REPOSITORY_UNAVAILABLE'); }
    const auditEvents = [];
    const built = this.builder.build(records, {
      userId: context.authenticatedUserId,
      includeHistorical: query.includeHistorical,
      includeSensitive: query.includeSensitive
    });
    const merged = this.merge.merge(built.events);
    const selected = this.filter.apply({ ...built, events: merged.events }, query, context);
    const rendered = this.renderer.render(selected, { granularity: query.granularity, timezone: context.timezone });
    auditEvents.push(this._audit(context, operation, operation === TimelineAuditAction.QUERIED ? 'TIMELINE_QUERY_APPLIED' : 'TIMELINE_MEMORY_DERIVED', {
      memoryIds: selected.events.flatMap((event) => event.memoryIds), selected: selected.events.length, excluded: built.excluded.length
    }));
    for (const event of selected.events.filter((item) => item.visibility === 'hidden_sensitive')) {
      auditEvents.push(this._audit(context, TimelineAuditAction.SENSITIVE_HIDDEN, 'TIMELINE_SENSITIVE_DEFAULT_HIDDEN', { memoryIds: event.memoryIds, selected: 1 }));
    }
    for (const item of merged.merges) auditEvents.push(this._audit(context, TimelineAuditAction.MERGED, item.reasonCode, { memoryIds: item.memoryIds, selected: 1 }));
    for (const conflict of selected.conflicts) auditEvents.push(this._audit(context, TimelineAuditAction.CONFLICT_MARKED, 'TIMELINE_CONFLICT_GOVERNANCE_REQUIRED', { memoryIds: conflict.memoryIds }));
    auditEvents.push(this._audit(context, TimelineAuditAction.RENDERED, 'TIMELINE_DATA_RENDERED', { selected: selected.events.length }));
    const empty = selected.events.length === 0 && selected.periods.length === 0;
    return deepFreezeTimeline({
      ok: true,
      reasonCode: empty ? 'TIMELINE_EMPTY' : 'TIMELINE_READY',
      query,
      events: selected.events,
      periods: selected.periods,
      conflicts: selected.conflicts,
      excluded: selected.excluded,
      segments: rendered.segments,
      auditEvents,
      error: null
    });
  }

  build(context, query = {}) { return this._execute(context, query, TimelineAuditAction.BUILT); }
  query(context, query = {}) { return this._execute(context, query, TimelineAuditAction.QUERIED); }

  render(context, timelineResult, options = {}) {
    if (!validateTimelineContext(context).valid) return this._failure(context, 'TIMELINE_INVALID_CONTEXT');
    return this.renderer.render(timelineResult, { granularity: options.granularity, timezone: context.timezone });
  }

  listAuditEvents(context) {
    if (!validateTimelineContext(context).valid) return deepFreezeTimeline([]);
    return deepFreezeTimeline(this.auditEvents.filter((event) => event.userId === context.authenticatedUserId).map((event) => structuredClone(event)));
  }
}

export const LifeTimelineService = MemoryLifeTimelineService;
