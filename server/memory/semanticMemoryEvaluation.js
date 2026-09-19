function comparable(value) {
  if (Array.isArray(value)) return value.map(comparable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, comparable(value[key])]));
}

function includesExpected(actual, expected) {
  if (Array.isArray(expected)) return JSON.stringify(comparable(actual)) === JSON.stringify(comparable(expected));
  if (!expected || typeof expected !== 'object') return actual === expected;
  if (!actual || typeof actual !== 'object') return false;
  return Object.entries(expected).every(([key, value]) => includesExpected(actual[key], value));
}

export async function evaluateSemanticMemoryCorpus({ cases, planCase }) {
  if (!Array.isArray(cases) || typeof planCase !== 'function') throw new TypeError('cases and planCase are required.');
  const failures = [];
  let passed = 0;
  for (const entry of cases) {
    let result;
    try {
      result = await planCase(entry);
    } catch (error) {
      result = { ok: false, code: error?.code || 'EVALUATION_ERROR' };
    }
    if (result?.ok && includesExpected(result.semantic, entry.expected)) passed += 1;
    else failures.push(Object.freeze({ id: entry.id, code: result?.code || 'SEMANTIC_MISMATCH' }));
  }
  return Object.freeze({ total: cases.length, passed, failed: failures.length, failures: Object.freeze(failures) });
}
