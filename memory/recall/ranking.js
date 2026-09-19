import { DEFAULT_RANKING_WEIGHTS } from './planning.js';
import { deepFreezeRecall } from './contracts.js';

const SOURCE_TRUST = Object.freeze({
  user_confirmed: 1,
  structured_system_record: 0.95,
  user_explicit: 0.9,
  repeated_observation: 0.7,
  imported: 0.6,
  model_inferred: 0.35,
  legacy_unknown: 0.2
});
const CONFIRMATION = Object.freeze({ user_confirmed: 1, system_verified: 0.9, not_required: 0.8 });
const SENSITIVITY_PENALTY = Object.freeze({ public: 0, low: 0, medium: 0.15, high: 0.5, restricted: 1 });

function grams(value) {
  const text = String(value ?? '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  if (text.length < 2) return new Set(text ? [text] : []);
  return new Set(Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2)));
}

function relevance(record, request) {
  const wanted = grams(request.text);
  if (!wanted.size) return 0;
  const available = grams([record.subject, record.predicate, record.value, ...(record.tags || [])].join(' '));
  return [...wanted].filter((item) => available.has(item)).length / wanted.size;
}

function recency(timestamp, now) {
  const days = Math.max(0, (Date.parse(now) - Date.parse(timestamp)) / 86400000);
  return 1 / (1 + days / 365);
}

function effective(record, now) {
  const instant = Date.parse(now);
  return Date.parse(record.effectiveFrom) <= instant && (!record.effectiveTo || instant < Date.parse(record.effectiveTo)) ? 1 : 0;
}

function taskFit(record, intent) {
  const mapping = {
    personal_preference: 'preference', personal_fact: 'fact', relationship_context: 'relationship',
    goal_context: 'goal', habit_or_routine: 'habit_routine', prior_decision: 'decision',
    life_event_context: 'life_event'
  };
  return mapping[intent] === record.memoryType ? 1 : 0.5;
}

export class MemoryRankingEngine {
  constructor({ weights = DEFAULT_RANKING_WEIGHTS } = {}) {
    this.weights = Object.freeze({ ...DEFAULT_RANKING_WEIGHTS, taskFit: 0.1, ...weights });
  }

  score(record, request) {
    const breakdown = {
      relevance: relevance(record, request),
      recency: recency(record.sourceTimestamp, request.timestamp),
      effectiveTimeMatch: effective(record, request.timestamp),
      confidence: record.confidence,
      importance: record.importance,
      sourceTrust: SOURCE_TRUST[record.source.type] ?? 0,
      confirmationStrength: CONFIRMATION[record.confirmationStatus] ?? 0,
      taskFit: taskFit(record, request.intent),
      sensitivityPenalty: SENSITIVITY_PENALTY[record.sensitivity] ?? 1,
      redundancyPenalty: 0,
      conflictPenalty: 0
    };
    const positive = ['relevance', 'recency', 'effectiveTimeMatch', 'confidence', 'importance', 'sourceTrust', 'confirmationStrength', 'taskFit'];
    const negative = ['sensitivityPenalty', 'redundancyPenalty', 'conflictPenalty'];
    const score = positive.reduce((sum, key) => sum + breakdown[key] * (this.weights[key] || 0), 0) -
      negative.reduce((sum, key) => sum + breakdown[key] * (this.weights[key] || 0), 0);
    return deepFreezeRecall({ score: Number(score.toFixed(6)), breakdown });
  }

  rank(records, request) {
    return deepFreezeRecall(records.map((record) => ({ record, ...this.score(record, request) })).sort((left, right) => (
      right.score - left.score || left.record.id.localeCompare(right.record.id)
    )));
  }
}
