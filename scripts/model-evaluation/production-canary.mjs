import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createAssistantToolRegistry } from '../../server/tools/assistantToolRegistry.js';
import { createCalendarTool } from '../../server/tools/calendar/calendarTool.js';
import { redactEvaluationValue } from '../../server/modelEvaluation/evaluationCache.js';
import { runProductionPlannerCanary } from '../../server/modelEvaluation/productionCanary.js';
import { createVpsEvaluationRuntime } from '../../server/modelEvaluation/vpsEvaluationRuntime.js';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1];
}

const runtimeConfigPath = argument('runtime-config');
const outputPath = argument('output');
if (!runtimeConfigPath || !outputPath) {
  throw new Error('PRODUCTION_CANARY_RUNTIME_CONFIG_AND_OUTPUT_REQUIRED');
}

const runtime = await createVpsEvaluationRuntime(
  JSON.parse(await readFile(path.resolve(runtimeConfigPath), 'utf8'))
);
const target = runtime.providerTargets.find(({ provider_id: providerId }) => providerId === 'qwen');
if (!target) throw new Error('PRODUCTION_CANARY_QWEN_TARGET_MISSING');

const registry = createAssistantToolRegistry();
registry.register(createCalendarTool());
const cases = [
  { id: 'D01', message: '请记住我妈妈是公历5月20日生日', contextPack: {} },
  { id: 'D02', message: '我妈妈生日是哪天？', contextPack: {} },
  { id: 'E01', message: '妈妈的下一个生日是哪天？', contextPack: {} },
  { id: 'E02', message: '距离妈妈下一个生日还有多少天？', contextPack: {} },
  { id: 'E03', message: '妈妈今年的农历生日换成公历是哪天？', contextPack: {} }
];
const result = await runProductionPlannerCanary({
  cases,
  providerTarget: target,
  invoke: runtime.invoke,
  toolDescriptors: registry.descriptors(),
  maxCalls: 8
});
const safe = redactEvaluationValue({
  schema_version: 1,
  canary_version: 'model-evaluation-validity-router-policy-gate-v1',
  parameters: {
    initial_case_count: cases.length,
    hard_call_limit: 8,
    max_output_tokens_hard: 6144,
    production_prompt: true,
    production_schema_repair: true
  },
  runtime: runtime.metadata,
  ...result
});
await writeFile(path.resolve(outputPath), `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
await chmod(path.resolve(outputPath), 0o600);
console.log(`PROVIDER_CALLS=${safe.call_count}`);
console.log(`CALL_LIMIT=${safe.call_limit}`);
console.log(`STOPPED_AT_LIMIT=${safe.stopped_at_limit ? 'YES' : 'NO'}`);
console.log(`OUTPUT=${path.resolve(outputPath)}`);
