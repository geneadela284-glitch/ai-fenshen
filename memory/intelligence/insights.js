import { createHash } from 'node:crypto';

import {
  LifeDerivedStatus,
  LifeInsightType,
  LifeSuggestionType,
  createLifeInsight,
  createLifeSuggestion,
  deepFreezeLifeIntelligence
} from './contracts.js';
import { InsightPolicy } from './policy.js';

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

function now(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function refs(artifact) {
  return {
    memoryIds: [...artifact.memoryIds],
    timelineEventIds: [...(artifact.timelineEventIds || [])]
  };
}

export class InsightBuilder {
  constructor({ clock = () => new Date() } = {}) { this.clock = clock; }

  fromPattern(pattern) {
    const source = refs(pattern);
    return createLifeInsight({
      id: `life-insight-${hash(['pattern', pattern.id])}`,
      userId: pattern.userId,
      insightType: LifeInsightType.PATTERN_SUMMARY,
      title: '已记录的生活规律',
      summary: `已有 ${pattern.occurrenceCount} 条同类记录，形成可追溯的 ${pattern.cadence} 规律。`,
      confidence: pattern.confidence,
      status: LifeDerivedStatus.INFORMATIONAL,
      ...source,
      patternIds: [pattern.id], trendIds: [], stageIds: [],
      evidence: [{ kind: 'pattern', id: pattern.id }],
      createdAt: now(this.clock),
      metadata: { derived: true, sourcePredicate: pattern.predicate, writesMemory: false }
    }, { trustedUserId: pattern.userId });
  }

  fromTrend(trend) {
    const source = refs(trend);
    return createLifeInsight({
      id: `life-insight-${hash(['trend', trend.id])}`,
      userId: trend.userId,
      insightType: LifeInsightType.TREND_SUMMARY,
      title: '已记录的变化',
      summary: `同一事项在 ${trend.timelineEventIds.length} 条记录中发生了变化；这里只陈述已有记录。`,
      confidence: trend.confidence,
      status: LifeDerivedStatus.INFORMATIONAL,
      ...source,
      patternIds: [], trendIds: [trend.id], stageIds: [],
      evidence: [{ kind: 'trend', id: trend.id }],
      createdAt: now(this.clock),
      metadata: { derived: true, sourcePredicate: trend.predicate, writesMemory: false }
    }, { trustedUserId: trend.userId });
  }

  fromStage(stage) {
    return createLifeInsight({
      id: `life-insight-${hash(['stage', stage.id])}`,
      userId: stage.userId,
      insightType: LifeInsightType.STAGE_SUMMARY,
      title: '已明确记录的人生阶段',
      summary: `“${stage.title}”来自已明确记录的时间轴阶段，不是系统推断。`,
      confidence: stage.confidence,
      status: LifeDerivedStatus.INFORMATIONAL,
      memoryIds: [...stage.memoryIds], timelineEventIds: [],
      patternIds: [], trendIds: [], stageIds: [stage.id],
      evidence: [{ kind: 'stage', id: stage.id }],
      createdAt: now(this.clock),
      metadata: { derived: true, sourcePredicate: null, writesMemory: false }
    }, { trustedUserId: stage.userId });
  }

  suggestionFor(insight) {
    return createLifeSuggestion({
      id: `life-suggestion-${hash(insight.id)}`,
      userId: insight.userId,
      suggestionType: LifeSuggestionType.OPTIONAL_REFLECTION,
      title: '可选建议',
      summary: '如果这仍然对你重要，可以考虑继续保持记录或按需要调整；最终决定由你。',
      decisionOwner: 'user',
      status: LifeDerivedStatus.OPTIONAL,
      insightIds: [insight.id],
      memoryIds: [...insight.memoryIds],
      evidence: [{ kind: 'insight', id: insight.id }],
      createdAt: now(this.clock),
      metadata: { derived: true, sourcePredicate: insight.metadata.sourcePredicate, executesAction: false }
    }, { trustedUserId: insight.userId });
  }
}

export class LifeInsightEngine {
  constructor({ clock = () => new Date(), policy = new InsightPolicy() } = {}) {
    this.policy = policy;
    this.builder = new InsightBuilder({ clock });
  }

  build({ patterns = [], trends = [], stages = [] } = {}) {
    const insights = [];
    for (const pattern of patterns) if (this.policy.evaluateArtifact(pattern).allowed) insights.push(this.builder.fromPattern(pattern));
    for (const trend of trends) if (this.policy.evaluateArtifact(trend).allowed) insights.push(this.builder.fromTrend(trend));
    for (const stage of stages) if (this.policy.evaluateArtifact(stage).allowed) insights.push(this.builder.fromStage(stage));
    return deepFreezeLifeIntelligence(insights.sort((left, right) => left.id.localeCompare(right.id)));
  }

  suggest(insights = []) {
    return deepFreezeLifeIntelligence(insights.filter((insight) => this.policy.allowsSuggestion(insight).allowed).map((insight) => this.builder.suggestionFor(insight)));
  }
}
