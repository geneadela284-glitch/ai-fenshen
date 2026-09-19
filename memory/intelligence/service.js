import { validateTimelineContext } from '../timeline/index.js';
import { deepFreezeLifeIntelligence } from './contracts.js';
import {
  LifeContextAnalyzer,
  LifeEvolutionTracker,
  LifePatternEngine,
  LifeStageEngine,
  LifeTrendEngine
} from './engines.js';
import { LifeInsightEngine } from './insights.js';
import { InsightPolicy } from './policy.js';

export const InsightAuditAction = Object.freeze({
  CONTEXT_ANALYZED: 'life_context_analyzed',
  PATTERN_DETECTED: 'life_pattern_detected',
  TREND_DETECTED: 'life_trend_detected',
  STAGE_IDENTIFIED: 'life_stage_identified',
  INSIGHT_BUILT: 'life_insight_built',
  SUGGESTION_BUILT: 'life_suggestion_built',
  SENSITIVE_FILTERED: 'life_sensitive_filtered',
  CONFLICT_DEFERRED: 'life_conflict_deferred',
  COMPLETED: 'life_intelligence_completed',
  FAILED: 'life_intelligence_failed'
});

function timestamp(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export class InsightAudit {
  constructor({ clock = () => new Date(), idFactory = () => crypto.randomUUID() } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.events = [];
  }

  record(context, action, reasonCode, { artifactIds = [], memoryIds = [], count = 0 } = {}) {
    const event = deepFreezeLifeIntelligence({
      id: `life-audit-${this.idFactory()}`,
      userId: context?.authenticatedUserId || '',
      actor: { type: context?.actorType || 'system', id: context?.actorId || 'life-intelligence' },
      action,
      timestamp: timestamp(this.clock),
      reasonCode,
      artifactIds: [...new Set(artifactIds)].sort(),
      memoryIds: [...new Set(memoryIds)].sort(),
      count,
      metadata: {}
    });
    this.events.push(event);
    return event;
  }

  list(context) {
    if (!validateTimelineContext(context).valid) return deepFreezeLifeIntelligence([]);
    return deepFreezeLifeIntelligence(this.events.filter((event) => event.userId === context.authenticatedUserId).map((event) => structuredClone(event)));
  }
}

export class LifeIntelligenceService {
  constructor({ clock = () => new Date(), idFactory = () => crypto.randomUUID(), policy = new InsightPolicy() } = {}) {
    this.contextAnalyzer = new LifeContextAnalyzer();
    this.patternEngine = new LifePatternEngine();
    this.trendEngine = new LifeTrendEngine();
    this.stageEngine = new LifeStageEngine();
    this.evolutionTracker = new LifeEvolutionTracker();
    this.insightEngine = new LifeInsightEngine({ clock, policy });
    this.policy = policy;
    this.audit = new InsightAudit({ clock, idFactory });
  }

  analyze(context, timeline) {
    const analyzed = this.contextAnalyzer.analyze(context, timeline);
    if (!analyzed.ok) {
      const auditEvent = this.audit.record(context, InsightAuditAction.FAILED, analyzed.reasonCode);
      return deepFreezeLifeIntelligence({ ok: false, reasonCode: analyzed.reasonCode, patterns: [], trends: [], stages: [], evolution: [], insights: [], suggestions: [], filtered: [], auditEvents: [auditEvent], error: { code: analyzed.reasonCode } });
    }

    const auditEvents = [this.audit.record(context, InsightAuditAction.CONTEXT_ANALYZED, 'LIFE_INTELLIGENCE_CONTEXT_READY', { count: analyzed.events.length })];
    const patterns = this.patternEngine.detect(analyzed).filter((item) => this.policy.evaluateArtifact(item).allowed);
    const trends = this.trendEngine.detect(analyzed).filter((item) => this.policy.evaluateArtifact(item).allowed);
    const stages = this.stageEngine.identify(analyzed).filter((item) => this.policy.evaluateArtifact(item).allowed);
    const artifacts = [...patterns, ...trends, ...stages];
    const memoryIds = artifacts.flatMap((item) => item.memoryIds);
    if (patterns.length) auditEvents.push(this.audit.record(context, InsightAuditAction.PATTERN_DETECTED, 'LIFE_PATTERN_EVIDENCE_FOUND', { artifactIds: patterns.map((item) => item.id), memoryIds: patterns.flatMap((item) => item.memoryIds), count: patterns.length }));
    if (trends.length) auditEvents.push(this.audit.record(context, InsightAuditAction.TREND_DETECTED, 'LIFE_TREND_EVIDENCE_FOUND', { artifactIds: trends.map((item) => item.id), memoryIds: trends.flatMap((item) => item.memoryIds), count: trends.length }));
    if (stages.length) auditEvents.push(this.audit.record(context, InsightAuditAction.STAGE_IDENTIFIED, 'LIFE_STAGE_EXPLICIT_PERIOD_FOUND', { artifactIds: stages.map((item) => item.id), memoryIds: stages.flatMap((item) => item.memoryIds), count: stages.length }));
    if (analyzed.filtered.some((item) => item.reasonCode === 'LIFE_INTELLIGENCE_SENSITIVE_FILTERED')) auditEvents.push(this.audit.record(context, InsightAuditAction.SENSITIVE_FILTERED, 'LIFE_INTELLIGENCE_SENSITIVE_FILTERED'));
    if (analyzed.filtered.some((item) => item.reasonCode === 'LIFE_INTELLIGENCE_CONFLICT_DEFERRED')) auditEvents.push(this.audit.record(context, InsightAuditAction.CONFLICT_DEFERRED, 'LIFE_INTELLIGENCE_CONFLICT_DEFERRED'));
    const insights = this.insightEngine.build({ patterns, trends, stages });
    const suggestions = this.insightEngine.suggest(insights);
    if (insights.length) auditEvents.push(this.audit.record(context, InsightAuditAction.INSIGHT_BUILT, 'LIFE_INSIGHT_EVIDENCE_BACKED', { artifactIds: insights.map((item) => item.id), memoryIds, count: insights.length }));
    if (suggestions.length) auditEvents.push(this.audit.record(context, InsightAuditAction.SUGGESTION_BUILT, 'LIFE_SUGGESTION_OPTIONAL_ONLY', { artifactIds: suggestions.map((item) => item.id), memoryIds, count: suggestions.length }));
    const evolution = this.evolutionTracker.track({ patterns, trends, stages });
    const empty = artifacts.length === 0;
    auditEvents.push(this.audit.record(context, InsightAuditAction.COMPLETED, empty ? 'LIFE_INTELLIGENCE_EMPTY' : 'LIFE_INTELLIGENCE_READY', { artifactIds: artifacts.map((item) => item.id), memoryIds, count: artifacts.length }));
    return deepFreezeLifeIntelligence({
      ok: true,
      reasonCode: empty ? 'LIFE_INTELLIGENCE_EMPTY' : 'LIFE_INTELLIGENCE_READY',
      patterns, trends, stages, evolution, insights, suggestions,
      filtered: analyzed.filtered,
      auditEvents,
      error: null
    });
  }

  listAuditEvents(context) { return this.audit.list(context); }
}
