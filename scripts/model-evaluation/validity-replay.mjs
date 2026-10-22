import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { EVALUATION_CASES } from '../../server/modelEvaluation/evaluationCases.js';
import { renderEvaluationReport } from '../../server/modelEvaluation/evaluationReport.js';
import {
  buildMachineResult,
  scoreCachedEvaluation
} from '../../server/modelEvaluation/evaluationScorer.js';
import { traceProductionPlan } from '../../server/modelEvaluation/evaluationValidity.js';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

function parseEnvelope(content) {
  try {
    return JSON.parse(String(content || '').trim()).plan || null;
  } catch {
    return null;
  }
}

function pct(value) {
  return value === null || value === undefined ? 'N/A' : `${(value * 100).toFixed(1)}%`;
}

function safeCanary(value) {
  return {
    ...value,
    upstream_records: (value.upstream_records || []).map((record) => {
      const usage = record.usage || null;
      return {
        ...record,
        usage: usage
          ? {
              input_tokens: Number.isFinite(usage.input_tokens) ? usage.input_tokens : null,
              output_tokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : null,
              total_tokens: Number.isFinite(usage.total_tokens) ? usage.total_tokens : null
            }
          : null
      };
    })
  };
}

function routerPolicy({ ready }) {
  return {
    schema_version: 1,
    policy_version: 'router-core-policy-gate-v1',
    status: ready ? 'READY FOR ROUTER CORE IMPLEMENTATION' : 'NOT READY',
    implementation_authorized: false,
    ordinary_chat: {
      primary: 'deepseek-v4-flash',
      first_backup: 'qwen-max',
      second_backup: null
    },
    semantic_planner: {
      primary: 'deepseek-v4-flash',
      first_backup: 'qwen-max',
      backup_scope: 'ordinary_chat_and_finance_only_after_canonical_domain_is_known',
      second_backup: null
    },
    memory_calendar: {
      provider_switch_allowed: false,
      reason: 'qwen_production_canary_2_of_5_full_path_pass_and_no_other_viable_backup',
      deterministic_execution_required: true,
      fail_closed_after_primary_planner_failure: true
    },
    deterministic_tasks: [
      'finance_amount_date_balance_and_aggregation',
      'memory_owner_scoped_read_write_dedup_and_lifecycle',
      'calendar_solar_lunar_conversion_next_occurrence_and_days_until',
      'evidence_binding_permissions_and_idempotency'
    ],
    switch_on_before_business_execution_only: [
      'timeout',
      'network_error',
      'http_502',
      'http_503',
      'http_504',
      'http_429',
      'provider_unavailable',
      'auth_or_quota_failure',
      'strict_json_invalid_after_one_repair',
      'raw_schema_invalid_after_one_repair',
      'canonicalization_failure_before_side_effect'
    ],
    do_not_switch_on: [
      'true_ambiguity',
      'invalid_user_input',
      'memory_evidence_not_found',
      'permission_or_policy_rejection',
      'domain_contract_ask_or_reject',
      'deterministic_tool_reject',
      'database_or_tool_failure_after_execution_started',
      'any_uncertain_or_committed_business_write'
    ],
    attempts: {
      max_distinct_providers: 2,
      max_total_upstream_model_calls: 3,
      primary_schema_repairs: 1,
      backup_schema_repairs: 'only_if_total_call_cap_remains'
    },
    duplicate_cost_and_write_controls: [
      'cache_planner_response_by_owner_conversation_source_message_input_digest_policy_provider_model',
      'bill_user_request_once_while_recording_each_provider_attempt_as_internal_cost',
      'keep_provider_attempts_plan_only_and_side_effect_free',
      'reuse_one_stable_action_idempotency_key_across_provider_attempts',
      'acquire_one_execution_ledger_compare_and_set_after_final_plan_selection',
      'never_switch_provider_after_database_or_tool_execution_begins'
    ],
    unique_blocker: ready
      ? null
      : 'production_aligned_targeted_canary_evidence_incomplete'
  };
}

const baselineDirectory = path.resolve(argument('baseline') || '');
const canaryPath = path.resolve(argument('canary') || '');
const outputDirectory = path.resolve(argument('output') || '');
if (!argument('baseline') || !argument('canary') || !argument('output')) {
  throw new Error('VALIDITY_REPLAY_BASELINE_CANARY_OUTPUT_REQUIRED');
}
await mkdir(outputDirectory, { recursive: true });

const records = (await readFile(path.join(baselineDirectory, 'raw-cache.ndjson'), 'utf8'))
  .trim().split(/\n/).filter(Boolean).map(JSON.parse);
const manualReviews = JSON.parse(
  await readFile(path.join(baselineDirectory, 'manual-review.json'), 'utf8')
);
const canary = safeCanary(JSON.parse(await readFile(canaryPath, 'utf8')));
const scored = await scoreCachedEvaluation(records, {
  cases: EVALUATION_CASES,
  pricingByModel: {},
  manualReviews
});
const corrected = buildMachineResult(scored);

const caseMap = new Map(EVALUATION_CASES.map((definition) => [definition.id, definition]));
const oldResult = JSON.parse(await readFile(path.join(baselineDirectory, 'results.json'), 'utf8'));
const oldScores = new Map(oldResult.case_scores.map((score) => [
  `${score.provider_id}:${score.case_id}`,
  score
]));
const selectedIds = ['D01', 'D02', 'E01', 'E02', 'E03', 'C01', 'A02'];
const deepseekTraces = [];
for (const caseId of selectedIds) {
  const record = records.find((entry) =>
    entry.provider_id === 'deepseek' && entry.case_id === caseId && entry.http_success);
  const definition = caseMap.get(caseId);
  const plan = parseEnvelope(record?.content);
  deepseekTraces.push({
    case_id: caseId,
    m12_score: oldScores.get(`deepseek:${caseId}`) || null,
    production_trace: ['memory', 'calendar'].includes(definition.category) && plan
      ? await traceProductionPlan(plan, definition)
      : {
          classification: oldScores.get(`deepseek:${caseId}`)?.success
            ? 'm12_evidence_valid_for_non_stateful_scope'
            : 'm12_non_stateful_failure',
          first_failure: oldScores.get(`deepseek:${caseId}`)?.failures?.[0]
            ? { layer: 'm12_scorer', code: oldScores.get(`deepseek:${caseId}`).failures[0] }
            : null
        }
  });
}
const qwenTraces = [];
for (const entry of canary.cases || []) {
  if (!entry.plan || !caseMap.has(entry.case_id)) continue;
  qwenTraces.push({
    case_id: entry.case_id,
    planner_attempts: entry.attempts,
    trace: await traceProductionPlan(entry.plan, caseMap.get(entry.case_id))
  });
}
const qwenPasses = qwenTraces.filter(({ trace }) =>
  trace.classification === 'production_chain_pass').length;
const canaryLatencies = (canary.upstream_records || [])
  .filter(({ http_success: ok, latency_ms: latency }) => ok && Number.isFinite(latency))
  .map(({ latency_ms: latency }) => latency)
  .sort((left, right) => left - right);
const canaryAverageLatency = canaryLatencies.length
  ? Math.round(canaryLatencies.reduce((sum, value) => sum + value, 0) / canaryLatencies.length)
  : null;
const canaryPercentile = (fraction) => canaryLatencies.length
  ? canaryLatencies[Math.max(0, Math.ceil(canaryLatencies.length * fraction) - 1)]
  : null;
const canaryTotalTokens = (canary.upstream_records || [])
  .reduce((sum, { usage }) => sum + Number(usage?.total_tokens || 0), 0);
const ready = canary.call_count <= 8 &&
  canary.exceeded_call_limit !== true &&
  canary.cases?.length === 5 &&
  canary.cases.every(({ ok }) => ok === true);
const policy = routerPolicy({ ready });

const layerTrace = {
  schema_version: 1,
  audit_version: 'model-evaluation-validity-router-policy-gate-v1',
  provider_calls_from_cache_replay: 0,
  first_behavior_difference: {
    layer: 'model_request_contract',
    evaluation_file: 'server/modelEvaluation/evaluationContract.js',
    evaluation_function: 'buildEvaluationMessages',
    production_file: 'server/agent/assistantSemanticPlanner.js',
    production_function: 'createAssistantSemanticPlanner.plan',
    rules: [
      'evaluation_system_contract_is_not_the_production_system_prompt',
      'evaluation_confirmed_memory_fixture_is_not_production_memory_context',
      'evaluation_prompt_omits_registered_tool_descriptors',
      'formal_evaluation_does_not_run_the_production_schema_repair_attempt',
      'evaluation_scorer_passes_trustedContext_null',
      'evaluation_calendar_fixture_bypasses_semantic_and_tool_evidence_binders',
      'evaluation_memory_cases_do_not_execute_query_v2_or_safe_write'
    ]
  },
  production_chain_equivalence: {
    generation_115_tag: 'calendar-solar-lunar-birthday-contract-v1-generation-115-20260727',
    generation_115_commit: '04c7f0e5750a1048fa04a832ddeececc697c38f8',
    business_source_diff_to_generation_117: 'none',
    isolated_http_test: {
      file: 'server/agent/unifiedSemanticBlackboxHttp.test.js',
      test: 'Generation 115 production chain accepts the M12 validity-gate inputs on an isolated HTTP runtime',
      port: 'ephemeral_127_0_0_1',
      databases: 'temporary_auth_conversation_memory_finance',
      provider_calls: 0,
      covered: [
        'memory_save_relation_and_birthday',
        'new_conversation_recall',
        'gregorian_next_birthday',
        'lunar_conversion',
        'days_until_next_birthday',
        'finance_expense',
        'ordinary_chat'
      ]
    }
  },
  deepseek_cached_samples: deepseekTraces,
  qwen_production_canary: {
    call_count: canary.call_count,
    call_limit: canary.call_limit,
    full_path_passes: qwenPasses,
    case_count: qwenTraces.length,
    traces: qwenTraces
  },
  corrected_interpretation: {
    old_memory_calendar_rates: '0%',
    corrected_domain_rates: 'N/A',
    reason: 'planner_only_or_synthetic_tool_scoring_cannot_measure_production_domain_execution',
    provider_capability_failures_preserved: [
      'kimi_raw_schema_incompatible_24_of_24',
      'zhipu_no_successful_http',
      'qwen_calendar_next_and_days_semantic_plan_invalid_in_production_canary'
    ],
    evaluator_or_alignment_failures: [
      'deepseek_D02_birth_date_is_normalized_to_birthday_by_production_adapter',
      'memory_query_v2_and_safe_write_were_not_executed',
      'calendar_evidence_binder_was_bypassed',
      'production_prompt_tool_descriptors_and_repair_were_not_used'
    ],
    canonical_compatibility_gap: [
      'qwen_D01_value_calendar_type_is_not_preserved_into_canonical_qualifiers'
    ]
  }
};

corrected.validity_gate = {
  old_memory_calendar_rates: '0%',
  corrected_memory_domain_rate: null,
  corrected_calendar_domain_rate: null,
  correction: 'not_measured_not_zero',
  provider_calls: 0,
  qwen_canary_calls: canary.call_count,
  qwen_canary_full_path_passes: `${qwenPasses}/${qwenTraces.length}`,
  router_policy_status: policy.status
};
const baselineReplayReport = renderEvaluationReport(corrected);
corrected.routing_recommendation = policy;

const providerRows = corrected.providers.map(({ provider_id: providerId, model_id: modelId, metrics }) =>
  `| ${providerId} / ${modelId} | ${pct(metrics.http_success_rate)} | ${metrics.average_latency_ms ?? 'N/A'} / ${metrics.p50_latency_ms ?? 'N/A'} / ${metrics.p95_latency_ms ?? 'N/A'} | ${pct(metrics.strict_json_parse_rate)} | ${pct(metrics.canonical_schema_pass_rate)} | ${pct(metrics.finance_success_rate)} | ${pct(metrics.memory_plan_success_rate)} | ${pct(metrics.calendar_plan_success_rate)} | N/A | N/A |`
).join('\n');
const report = `# Model Evaluation Validity And Router Policy Gate V1

## 结论

M12-B1 的 Memory/Calendar 0% 不是可信的 Domain 成功率。修正后两个
Domain 成功率均为 N/A；原始 Planner 命中率、Raw Schema 和 Canonical
指标保留。第一处分叉发生在模型调用前：评测使用
\`buildEvaluationMessages\`，生产使用
\`createAssistantSemanticPlanner.plan\`，两者 Prompt、上下文、工具描述和
Schema 修复合同不同。

Router Policy Gate：**${policy.status}**。该结论只授权后续独立的 Router
Core 实施评审，本任务没有实现或启用路由。

## Provider 对比

| Provider / Model | HTTP | Avg/P50/P95 ms | JSON | Canonical | Finance | Memory Plan | Calendar Plan | Memory Domain | Calendar Domain |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${providerRows}

Qwen 生产合同 Canary：${canary.call_count}/8 次调用，HTTP
${canary.upstream_records?.filter(({ http_success: ok }) => ok).length || 0}/${canary.call_count}，
完整生产路径 ${qwenPasses}/${qwenTraces.length}。D02 跨会话查询和 E03
农历换算通过；D01 暴露 Canonical qualifier 保留缺口；E01/E02 的动作或
source_calendar 不满足 Calendar Contract。

Canary 延迟 Avg/P50/P95 为 ${canaryAverageLatency ?? 'N/A'} /
${canaryPercentile(0.5) ?? 'N/A'} / ${canaryPercentile(0.95) ?? 'N/A'} ms，
可核验总 Token 为 ${canaryTotalTokens || 'N/A'}；输入/输出拆分因脱敏为
N/A。Model Catalog 无可靠版本化价格，货币成本仍为 N/A。

## 修正前后

| 指标 | M12-B1 原结论 | 有效性修正 |
|---|---:|---:|
| Memory Domain | 0% | N/A（未执行生产 Memory 链） |
| Calendar Domain | 0% | N/A（绕过生产 Binder 的 synthetic Tool 不能代表 Domain） |
| DeepSeek D02 | predicate_mismatch | 生产 Adapter 规范为 birthday，Domain Contract ACCEPT |
| Qwen production-aligned | 未测 | 2/5 完整路径通过 |

## 第一处分叉与逐层结论

- M12 Fixture 使用 \`confirmed_memory\`；生产使用 owner/conversation
  scoped \`memory_context\` 与 Query V2 Evidence。
- M12 Scorer 固定 \`trustedContext: null\`；生产链绑定可信上下文并运行
  Semantic Evidence Binder。
- M12 Calendar 直接构造 synthetic Evidence 后调用 Tool；生产先运行
  Memory Evidence Binder，再运行 Calendar Domain Contract 与确定性工具。
- M12 Memory 没有运行 Safe Write、Query V2、Evidence Bundle 或 Grounded
  Response，因此不能输出 Domain 成功率。
- DeepSeek D02 的 \`birth_date\` 会被生产 Domain Adapter 规范为
  \`birthday\` 并通过查询合同，原 \`predicate_mismatch\` 属于 Scorer 错误。

逐层顺序固定为：Provider Raw Response → Raw Plan → Raw-to-Canonical
Normalizer → Canonical Schema → Semantic Evidence Binder → Domain Adapter →
Memory Evidence Binder / Query V2 → Domain Contract → Deterministic Tool →
Scorer。完整脱敏对象见 \`layer-trace.json\`。

## 错误分类

- Fixture/Evidence 错误：Memory 用例未建立真实 owner-scoped DB 状态；
  Calendar synthetic Evidence 绕过生产 Binder。
- Scorer 错误：DeepSeek D02 把生产 Adapter 可规范的 \`birth_date\` 当作
  literal predicate 失败。
- Canonical 标准化缺失：Qwen D01 的 \`value.calendar_type=gregorian\`
  在 Canonical qualifier 中丢失。
- Provider 语义计划不足：Qwen E01/E02 产生不合法 Calendar source/action；
  Kimi 24/24 Raw Schema 不兼容。
- Provider 可用性：智谱无成功 HTTP；豆包维持 HTTP 404 unavailable 且本轮
  零调用。
- Domain Contract 真实失败：Generation 115 同条件七项对照中没有发现。

## 同条件对照

隔离 HTTP 测试使用 127.0.0.1 临时端口和临时 Auth、Conversation、
Memory、Finance SQLite，固定 2026-07-27，覆盖 Memory 保存、跨会话召回、
公历下一次、农历换算、剩余天数、Finance 支出和普通聊天。生产业务源码与
Generation 115 Tag 无差异；上述七项全部通过，Provider 调用为 0。

## Router Policy

- 普通聊天：DeepSeek 主，Qwen 第一备用，无第二备用。
- Semantic Planner：DeepSeek 主；Qwen 只可作为最终 Canonical domain 为
  ordinary_chat/finance 的条件备用。
- Memory/Calendar：当前不允许跨模型切换；DeepSeek 规划失败时 fail closed。
- 金额、日期、余额、去重、Evidence、权限、数据库写入和 Calendar 换算始终
  由确定性程序执行。
- Router 级最多 2 个 Provider、总上游模型调用最多 3 次；所有切换必须发生
  在业务执行前。
- 同一用户请求只记一次产品计费；Provider 尝试分别进入内部成本审计。最终
  Plan 选定后才以同一 idempotency key 获取单次执行权，执行开始后禁止切换。

## 安全与公网

- 缓存重评分 Provider 调用：0。
- Targeted Canary：${canary.call_count}，未超过 8。
- 原始响应只含合成输入并已脱敏；完整 Credential、KEK、Cookie、私钥未写入。
- 公网 Generation 115 未修改。
`;

await Promise.all([
  writeFile(path.join(outputDirectory, 'corrected-results.json'), `${JSON.stringify(corrected, null, 2)}\n`, { mode: 0o644 }),
  writeFile(path.join(outputDirectory, 'layer-trace.json'), `${JSON.stringify(layerTrace, null, 2)}\n`, { mode: 0o644 }),
  writeFile(path.join(outputDirectory, 'router-policy.json'), `${JSON.stringify(policy, null, 2)}\n`, { mode: 0o644 }),
  writeFile(path.join(outputDirectory, 'qwen-production-canary.json'), `${JSON.stringify(canary, null, 2)}\n`, { mode: 0o644 }),
  writeFile(path.join(outputDirectory, 'baseline-replay-report.md'), baselineReplayReport, { mode: 0o644 }),
  writeFile(path.join(outputDirectory, 'report.md'), report, { mode: 0o644 })
]);

console.log('PROVIDER_CALLS=0');
console.log(`BASELINE_CACHE_RECORDS=${records.length}`);
console.log(`CANARY_CALLS=${canary.call_count}`);
console.log(`ROUTER_POLICY_STATUS=${policy.status}`);
console.log(`OUTPUT=${outputDirectory}`);
