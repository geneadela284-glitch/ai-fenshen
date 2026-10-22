import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { EvaluationCache } from '../../server/modelEvaluation/evaluationCache.js';
import { EVALUATION_CASES } from '../../server/modelEvaluation/evaluationCases.js';
import { renderEvaluationReport } from '../../server/modelEvaluation/evaluationReport.js';
import {
  buildMachineResult,
  scoreCachedEvaluation
} from '../../server/modelEvaluation/evaluationScorer.js';

function outputArgument(argv) {
  const index = argv.indexOf('--output');
  return index === -1 ? null : argv[index + 1];
}

const output = outputArgument(process.argv.slice(2));
if (!output) throw new Error('EVALUATION_OUTPUT_REQUIRED');
const directory = path.resolve(output);
const cache = new EvaluationCache({ directory });
const records = await cache.readAll();
let manifest = {};
let manualReviews = {};
try { manifest = JSON.parse(await readFile(path.join(directory, 'run-manifest.json'), 'utf8')); } catch {}
try { manualReviews = JSON.parse(await readFile(path.join(directory, 'manual-review.json'), 'utf8')); } catch {}
const pricingByModel = Object.fromEntries(
  (manifest.provider_targets || []).map((target) => [
    `${target.provider_id}:${target.model_id}`,
    target.pricing || {}
  ])
);
const scored = await scoreCachedEvaluation(records, {
  cases: EVALUATION_CASES,
  pricingByModel,
  manualReviews
});
const result = buildMachineResult(scored);
await cache.writeJson('results.json', result);
await cache.writeText('report.md', renderEvaluationReport(result));
console.log('PROVIDER_CALLS=0');
console.log(`CACHE_RECORDS=${records.length}`);
