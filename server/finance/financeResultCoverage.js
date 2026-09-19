import { localDateKey } from './time.js';

function formatMinor(value) {
  const minor = Number(value) || 0;
  return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2).replace(/0$/, '');
}

function categoryText(result, type) {
  return (result.categories || []).filter((item) => item.type === type)
    .map((item) => `${item.category}${formatMinor(item.amountMinor)}元`).join('，');
}

function expectedMetricText(metric, result) {
  if (metric === 'income') return `收入${formatMinor(result.incomeMinor)}元`;
  if (metric === 'expense') return `支出${formatMinor(result.expenseMinor)}元`;
  if (metric === 'net') return `结余${formatMinor(result.balanceMinor)}元`;
  return null;
}

function effectiveMetrics(requested) {
  const metrics = [...requested];
  if (metrics.includes('income') && metrics.includes('expense') && !metrics.includes('net')) metrics.push('net');
  return metrics;
}

function deterministicContent(plan, result, coveredMetrics) {
  const label = plan.label || '该时间范围';
  const totals = coveredMetrics.filter((metric) => metric !== 'entries');
  const lines = [];
  if (totals.length > 1) {
    lines.push(`${label}${totals.map((metric) => expectedMetricText(metric, result)).join('，')}。`);
    if (coveredMetrics.includes('income') && coveredMetrics.includes('expense')) {
      lines.push('需要我根据这份收支情况给你一些建议吗？');
    }
  }
  else if (totals[0] === 'net') lines.push(`${label}${expectedMetricText('net', result)}。`);
  else if (totals.length === 1) {
    const type = totals[0];
    const total = type === 'income' ? result.incomeMinor : result.expenseMinor;
    const details = categoryText(result, type);
    lines.push(`${label}共${type === 'income' ? '收入' : '支出'}${formatMinor(total)}元${details ? `：\n${details}。` : '。'}`);
  }
  if (coveredMetrics.includes('entries')) {
    lines.push((result.entries || []).length
      ? result.entries.map((entry) => `${localDateKey(new Date(entry.occurredAt), plan.timezone)} ${entry.type === 'income' ? '收入' : '支出'} ${entry.category} ${formatMinor(entry.amountMinor)}元`).join('\n')
      : `${label}没有账目记录。`);
  }
  return lines.join('\n');
}

function candidateCovers(candidate, metrics, result) {
  if (!candidate || !Array.isArray(candidate.coveredMetrics)) return false;
  if (metrics.some((metric) => !candidate.coveredMetrics.includes(metric))) return false;
  return metrics.filter((metric) => metric !== 'entries')
    .every((metric) => String(candidate.content || '').includes(expectedMetricText(metric, result)));
}

export function coverFinanceResult({ plan, repositoryResult, candidate = null } = {}) {
  const requestedMetrics = [...(plan?.metrics || [])];
  if (!requestedMetrics.length) throw new Error('FINANCE_REQUESTED_METRICS_REQUIRED');
  for (const field of ['incomeMinor', 'expenseMinor', 'balanceMinor']) {
    if (!Number.isSafeInteger(repositoryResult?.[field])) throw new Error('FINANCE_REPOSITORY_RESULT_INVALID');
  }
  if (requestedMetrics.includes('entries') && !Array.isArray(repositoryResult.entries)) {
    throw new Error('FINANCE_REPOSITORY_RESULT_INVALID');
  }
  const coveredMetrics = effectiveMetrics(requestedMetrics);
  const fallback = deterministicContent(plan, repositoryResult, coveredMetrics);
  const candidateValid = candidateCovers(candidate, coveredMetrics, repositoryResult);
  return {
    content: candidateValid ? candidate.content : fallback,
    usedFallback: !candidateValid,
    data: { ...repositoryResult, requestedMetrics, coveredMetrics }
  };
}
