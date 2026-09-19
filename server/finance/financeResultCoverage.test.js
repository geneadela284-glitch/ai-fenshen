import assert from 'node:assert/strict';
import test from 'node:test';

import { coverFinanceResult } from './financeResultCoverage.js';

test('coverage includes income, expense and deterministic net even when a requested value is zero', () => {
  const covered = coverFinanceResult({
    plan: { metrics: ['income', 'expense'], label: '本月', timezone: 'Asia/Shanghai' },
    repositoryResult: { incomeMinor: 0, expenseMinor: 6800, balanceMinor: -6800, categories: [], entries: [] }
  });
  assert.deepEqual(covered.data.requestedMetrics, ['income', 'expense']);
  assert.deepEqual(covered.data.coveredMetrics, ['income', 'expense', 'net']);
  assert.match(covered.content, /^本月收入0元，支出68元，结余-68元。/);
});

test('coverage replaces an incomplete candidate answer with the complete deterministic result', () => {
  const covered = coverFinanceResult({
    plan: { metrics: ['income', 'expense', 'net'], label: '本月', timezone: 'Asia/Shanghai' },
    repositoryResult: { incomeMinor: 10000, expenseMinor: 6800, balanceMinor: 3200, categories: [], entries: [] },
    candidate: { content: '本月支出68元。', coveredMetrics: ['expense'] }
  });
  assert.equal(covered.usedFallback, true);
  assert.match(covered.content, /^本月收入100元，支出68元，结余32元。/);
});
