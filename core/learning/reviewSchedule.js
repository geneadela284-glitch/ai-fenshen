import { learningError } from './contract.js';
export function scheduleReview({ stage = 0, independent, now }) {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp) || !Number.isInteger(stage) || stage < 0 || stage > 3) throw learningError('REVIEW_INPUT_INVALID');
  if (!independent) return { stage: 0, dueAt: new Date(timestamp).toISOString(), scheduleVersion: 1 };
  const days = [1, 3, 7, 7][stage];
  return { stage: Math.min(3, stage + 1), dueAt: new Date(timestamp + days * 86400000).toISOString(), scheduleVersion: 1 };
}
