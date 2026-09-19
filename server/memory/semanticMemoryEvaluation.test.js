import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateSemanticMemoryCorpus } from './semanticMemoryEvaluation.js';
import { SEMANTIC_MEMORY_EVALUATION_V1 } from './fixtures/semanticMemoryEvaluationV1.js';

test('Semantic Memory Evaluation V1 contains and evaluates exactly 100 natural-language cases', async () => {
  assert.equal(SEMANTIC_MEMORY_EVALUATION_V1.length, 100);
  const result = await evaluateSemanticMemoryCorpus({
    cases: SEMANTIC_MEMORY_EVALUATION_V1,
    planCase: async (entry) => ({ ok: true, semantic: entry.expected })
  });
  assert.equal(result.total, 100);
  assert.equal(result.passed, 100);
  assert.deepEqual(result.failures, []);
});

test('evaluation reports semantic mismatches without leaking full source messages', async () => {
  const result = await evaluateSemanticMemoryCorpus({
    cases: SEMANTIC_MEMORY_EVALUATION_V1.slice(0, 1),
    planCase: async () => ({ ok: true, semantic: { intent: 'ordinary_chat' } })
  });
  assert.equal(result.passed, 0);
  assert.equal(result.failures[0].id, 'lunar-01');
  assert.equal(Object.hasOwn(result.failures[0], 'input'), false);
});
