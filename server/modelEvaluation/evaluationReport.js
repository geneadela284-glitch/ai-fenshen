function pct(value) {
  return value === null || value === undefined ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function money(value) {
  if (!value) return '价格不可用';
  return `${value.amount.toFixed(6)} ${value.currency} (${value.version})`;
}

export function renderEvaluationReport(result) {
  const lines = [
    '# Model Evaluation Baseline M12-B1 V1',
    '',
    `- 生成时间：${result.generated_at}`,
    `- 实际调用：${result.call_count}`,
    `- 正式初始调用上限：${result.formal_initial_call_limit}`,
    `- 含重试硬上限：${result.hard_call_limit}`,
    `- 是否超限：${result.exceeded_call_limit ? 'YES' : 'NO'}`,
    '',
    '## Provider 对比表',
    '',
    '| Provider / Model | HTTP | 平均/P50/P95 ms | JSON | Canonical | Finance | Memory Plan | Calendar Plan | Memory Domain | Calendar Domain | 输入/输出 Token | 成本 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
  ];
  for (const provider of result.providers) {
    const metric = provider.metrics;
    lines.push(
      `| ${provider.provider_id} / ${provider.model_id} | ${pct(metric.http_success_rate)} | ` +
      `${metric.average_latency_ms ?? 'N/A'} / ${metric.p50_latency_ms ?? 'N/A'} / ${metric.p95_latency_ms ?? 'N/A'} | ` +
      `${pct(metric.strict_json_parse_rate)} | ${pct(metric.canonical_schema_pass_rate)} | ` +
      `${pct(metric.finance_success_rate)} | ${pct(metric.memory_plan_success_rate)} | ${pct(metric.calendar_plan_success_rate)} | ` +
      `${pct(metric.memory_success_rate)} | ${pct(metric.calendar_success_rate)} | ` +
      `${metric.input_tokens} / ${metric.output_tokens} | ${money(metric.estimated_cost)} |`
    );
  }
  lines.push('', '## 错误类型统计', '');
  const errors = Object.entries(result.error_distribution);
  if (!errors.length) lines.push('- 无');
  else errors.sort(([left], [right]) => left.localeCompare(right))
    .forEach(([type, count]) => lines.push(`- ${type}: ${count}`));

  lines.push('', '## 领域成功率', '');
  for (const provider of result.providers) {
    const metric = provider.metrics;
    lines.push(
      `- ${provider.provider_id}/${provider.model_id}: ordinary_chat=${pct(metric.ordinary_chat_success_rate)}, ` +
      `semantic=${pct(metric.semantic_success_rate)}, finance=${pct(metric.finance_success_rate)}, ` +
      `memory_plan=${pct(metric.memory_plan_success_rate)}, calendar_plan=${pct(metric.calendar_plan_success_rate)}, ` +
      `Memory Domain=${pct(metric.memory_success_rate)}, Calendar Domain=${pct(metric.calendar_success_rate)}, ` +
      `stability=${pct(metric.stability_success_rate)}, true_ambiguity=${pct(metric.true_ambiguity_accuracy)}`
    );
  }
  lines.push(
    '',
    '> Memory Plan 与 Calendar Plan 只表示评测 Raw/Canonical 规划命中；M12-B1 未经过生产 Memory 执行链，Calendar 也仅使用绕过生产 Binder 的合成 Tool Fixture，因此两个 Domain 成功率必须为 N/A。'
  );

  lines.push('', '## 普通聊天人工复核', '');
  for (const provider of result.providers) {
    if (!provider.manual_review.length) continue;
    lines.push(`- ${provider.provider_id}/${provider.model_id}: ` +
      provider.manual_review.map(({ case_id: caseId, status }) => `${caseId}=${status}`).join(', '));
  }

  const route = result.routing_recommendation;
  lines.push(
    '',
    '## 路由建议草案（不实现）',
    '',
    `- 默认普通聊天：${route.default_ordinary_chat || '证据不足'}`,
    `- Semantic Planner：${route.semantic_planner || '证据不足'}`,
    `- 严格 JSON：${route.strict_json || '证据不足'}`,
    `- 第一备用：${route.first_backup || '证据不足'}`,
    `- 第二备用：${route.second_backup || '证据不足'}`,
    `- 应触发切换：${route.switch_on.join(', ')}`,
    `- 不应自动切换：${route.do_not_switch_on.join(', ')}`,
    `- 是否具备进入 Router Core 条件：${route.evidence_sufficient_for_router_core ? 'YES' : 'NO'} (${route.evidence_note})`,
    '',
    '> 本节是数据驱动的非执行草案；本任务不修改任何路由。'
  );
  return `${lines.join('\n')}\n`;
}
