import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { EvaluationCache } from '../../server/modelEvaluation/evaluationCache.js';
import { EVALUATION_CASES } from '../../server/modelEvaluation/evaluationCases.js';
import {
  EVALUATION_PARAMETERS,
  EVALUATION_VERSION,
  FORMAL_PROVIDER_IDS,
  validateFrozenEvaluationSuite
} from '../../server/modelEvaluation/evaluationContract.js';
import { renderEvaluationReport } from '../../server/modelEvaluation/evaluationReport.js';
import {
  buildMachineResult,
  scoreCachedEvaluation
} from '../../server/modelEvaluation/evaluationScorer.js';
import {
  buildPreflightBudget,
  runEvaluation
} from '../../server/modelEvaluation/evaluationRunner.js';
import { createVpsEvaluationRuntime } from '../../server/modelEvaluation/vpsEvaluationRuntime.js';

function argumentsMap(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    const value = argv[index + 1]?.startsWith('--') ? true : argv[++index] ?? true;
    result[key] = value;
  }
  return result;
}

function basePlan(overrides = {}) {
  return {
    domain: 'ordinary_chat',
    intent: 'ordinary_chat',
    action: 'ordinary_chat',
    entity: { type: null, reference: null, relation_to_owner: null },
    relation_to_owner: null,
    predicate: null,
    value: null,
    qualifiers: {},
    tool: null,
    arguments: {},
    required_evidence: [],
    explicit_fields: ['domain', 'intent', 'action'],
    inherited_fields: [],
    ambiguity_reasons: [],
    confidence: 1,
    requires_confirmation: false,
    source_spans: [],
    source_message_id: null,
    ...overrides
  };
}

function mockEnvelope(definition) {
  const expected = definition.expected;
  let plan = basePlan();
  let assistantText = null;
  if (expected.domain === 'ordinary_chat') {
    assistantText = definition.id === 'A01' ? '我是AI秘书，可以协助处理工作与生活事务。' : '这是一个简洁、自然的合成评测回答。';
  } else if (expected.domain === 'ambiguous') {
    plan = basePlan({
      domain: 'ambiguous',
      intent: 'ambiguous',
      action: 'ambiguous',
      ambiguity_reasons: ['缺少关键对象或动作'],
      confidence: 0.4,
      requires_confirmation: true
    });
    assistantText = '请补充你希望处理的具体对象或动作。';
  } else if (expected.domain === 'finance') {
    plan = basePlan({
      domain: 'finance',
      intent: 'create',
      action: 'create',
      value: { amount: String(expected.amount_minor / 100), direction: expected.direction },
      qualifiers: {
        relative_day_offset: expected.local_date === '2026-07-26' ? -1 : 0,
        category: Object.hasOwn(expected, 'category') ? expected.category : null
      },
      arguments: {
        transaction_candidate: {
          direction: expected.direction,
          amount_text: String(expected.amount_minor / 100),
          occurred_expression: expected.local_date === '2026-07-26' ? '昨天' : '今天'
        },
        metrics: [expected.direction]
      }
    });
  } else if (expected.domain === 'memory') {
    const action = expected.action.split('.').at(-1);
    const value = expected.unique_values || (
      expected.scalar_value !== undefined ? expected.scalar_value :
        expected.calendar_type ? {
          calendar_type: expected.calendar_type,
          month: expected.month,
          day: expected.day
        } : null
    );
    plan = basePlan({
      domain: 'memory',
      intent: action,
      action,
      entity: {
        type: 'person',
        reference: expected.relation_to_owner || 'self',
        relation_to_owner: expected.relation_to_owner || 'self'
      },
      relation_to_owner: expected.relation_to_owner || 'self',
      predicate: expected.predicate || null,
      value,
      qualifiers: expected.calendar_type ? {
        calendar_type: expected.calendar_type,
        month: expected.month,
        day: expected.day
      } : {}
    });
  } else if (expected.domain === 'tool') {
    const memory = definition.context.confirmed_memory;
    const sourceCalendar = memory.value.calendar_type;
    const action = expected.action === 'calendar.convert'
      ? 'convert_calendar_date'
      : expected.action.split('.').at(-1);
    plan = basePlan({
      domain: 'tool',
      intent: action,
      action,
      entity: {
        type: 'person',
        reference: '妈妈',
        relation_to_owner: expected.relation_to_owner
      },
      relation_to_owner: expected.relation_to_owner,
      predicate: expected.predicate,
      tool: 'calendar.convert',
      arguments: {
        source_calendar: sourceCalendar,
        target_calendar: 'gregorian',
        target_year_reference: action === 'convert_calendar_date' ? 'this_year' : 'next_occurrence',
        occurrence: action === 'convert_calendar_date' ? 'specified_year' : 'next_occurrence'
      },
      required_evidence: [{
        entity_relation: expected.relation_to_owner,
        predicate: expected.predicate,
        required_qualifiers: ['calendar_type', 'month', 'day']
      }],
      inherited_fields: expected.inherited_fields || []
    });
  }
  return JSON.stringify({ plan, assistant_text: assistantText });
}

function mockRuntime() {
  const providerTargets = FORMAL_PROVIDER_IDS.map((providerId) => ({
    provider_id: providerId,
    model_id: `mock-${providerId}`
  }));
  return {
    providerTargets,
    pricingByModel: {},
    metadata: { execution_environment: 'local_mock', provider_targets: providerTargets },
    async invoke({ caseDefinition }) {
      if (process.env.MODEL_EVAL_FAIL_IF_PROVIDER_CALLED === 'true') {
        throw new Error('PROVIDER_CALL_FORBIDDEN');
      }
      return {
        content: mockEnvelope(caseDefinition),
        httpStatus: 200,
        usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 }
      };
    }
  };
}

function printBudget(budget) {
  console.log(`INITIAL_CALLS=${budget.initial_calls}`);
  console.log(`HARD_CALLS=${budget.hard_calls}`);
  console.log(`ESTIMATED_INPUT_TOKENS_FORMAL=${budget.estimated_input_tokens_formal}`);
  console.log(`MAX_OUTPUT_TOKENS_FORMAL=${budget.max_output_tokens_formal}`);
  console.log(`ESTIMATED_TOTAL_TOKENS_HARD=${budget.estimated_total_tokens_hard}`);
  console.log(`HARD_TOKEN_BUDGET=${budget.hard_token_budget}`);
  console.log(`WITHIN_HARD_TOKEN_BUDGET=${budget.within_hard_token_budget ? 'YES' : 'NO'}`);
}

const args = argumentsMap(process.argv.slice(2));
const mode = String(args.mode || 'preflight');
validateFrozenEvaluationSuite(EVALUATION_CASES);
const preflight = buildPreflightBudget({ cases: EVALUATION_CASES });
if (mode === 'preflight') {
  printBudget(preflight);
  process.exit(0);
}
if (!['mock', 'canary', 'formal'].includes(mode)) throw new Error('EVALUATION_MODE_INVALID');
if (mode === 'formal' &&
    process.env.MODEL_EVAL_CONFIRM_FORMAL !== 'MODEL-EVALUATION-BASELINE-M12-B1-V1') {
  throw new Error('FORMAL_EVALUATION_CONFIRMATION_REQUIRED');
}
const output = path.resolve(String(args.output || ''));
if (!args.output) throw new Error('EVALUATION_OUTPUT_REQUIRED');
const runtime = mode === 'mock'
  ? mockRuntime()
  : await createVpsEvaluationRuntime(JSON.parse(await readFile(path.resolve(String(args['runtime-config'] || '')), 'utf8')));
const cases = mode === 'canary'
  ? [EVALUATION_CASES.find(({ id }) => id === 'F01')]
  : EVALUATION_CASES;
const cache = new EvaluationCache({ directory: output });
const manifest = {
  schema_version: 1,
  evaluation_version: EVALUATION_VERSION,
  mode,
  parameters: EVALUATION_PARAMETERS,
  ...runtime.metadata
};
if (mode === 'formal') printBudget(preflight);
const run = await runEvaluation({
  cases,
  providerTargets: runtime.providerTargets,
  invoke: runtime.invoke,
  cache,
  mode,
  manifest
});
const manualReviewPath = path.join(output, 'manual-review.json');
let manualReviews = {};
try { manualReviews = JSON.parse(await readFile(manualReviewPath, 'utf8')); } catch {}
const scored = await scoreCachedEvaluation(run.records, {
  cases,
  pricingByModel: runtime.pricingByModel,
  manualReviews
});
const result = buildMachineResult(scored);
await cache.writeJson('results.json', result);
await cache.writeText('report.md', renderEvaluationReport(result));
await cache.writeJson('run-manifest.json', {
  ...manifest,
  budget: run.budget,
  call_count: run.call_count,
  formal_run_completed: mode === 'formal',
  provider_targets: runtime.providerTargets
});
console.log(`CALL_COUNT=${run.call_count}`);
console.log(`OUTPUT=${output}`);
