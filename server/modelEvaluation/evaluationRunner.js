import {
  buildEvaluationMessages,
  EVALUATION_PARAMETERS,
  FORMAL_INITIAL_CALLS,
  FORMAL_PROVIDER_IDS,
  HARD_CALL_LIMIT
} from './evaluationContract.js';

const RETRYABLE = new Set(['timeout', 'network_error', 'http_502', 'http_503', 'http_504']);

export function classifyEvaluationError(error = {}) {
  const code = String(error.code || 'UNKNOWN');
  const status = Number(error.status || error.httpStatus || 0) || null;
  let errorType = 'provider_error';
  if (code === 'TIMEOUT' || status === 408 || status === 504) errorType = 'timeout';
  else if (code === 'NETWORK_ERROR') errorType = 'network_error';
  else if (status === 429) errorType = 'rate_limit';
  else if (code === 'INVALID_API_KEY' || status === 401 || status === 403) errorType = 'auth_failed';
  else if (code === 'INSUFFICIENT_BALANCE' || status === 402) errorType = 'quota_exhausted';
  else if ([502, 503, 504].includes(status)) errorType = `http_${status}`;
  else if (status === 400 || code === 'INVALID_REQUEST') errorType = 'invalid_request';
  return { error_type: errorType, error_code: code, http_status: status };
}

export function shouldRetryTechnicalFailure(result, retryCount) {
  return retryCount < 1 && RETRYABLE.has(result?.error_type);
}

function normalizedUsage(usage = null) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0);
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? 0);
  const total = Number(usage.total_tokens ?? input + output);
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
    total_tokens: Number.isFinite(total) ? total : input + output
  };
}

export function buildPreflightBudget({ cases, providerIds = FORMAL_PROVIDER_IDS } = {}) {
  const initialCalls = cases.length * providerIds.length;
  const formalInput = cases.reduce((sum, definition) => {
    const serialized = JSON.stringify(buildEvaluationMessages(definition));
    return sum + [...serialized].length;
  }, 0) * providerIds.length;
  const hardInput = Math.ceil(formalInput * (HARD_CALL_LIMIT / Math.max(1, initialCalls)));
  const formalOutput = initialCalls * EVALUATION_PARAMETERS.max_tokens;
  const hardOutput = HARD_CALL_LIMIT * EVALUATION_PARAMETERS.max_tokens;
  const hardTokenBudget = 500000;
  return {
    initial_calls: initialCalls,
    hard_calls: HARD_CALL_LIMIT,
    estimated_input_tokens_formal: formalInput,
    estimated_input_tokens_hard: hardInput,
    max_output_tokens_formal: formalOutput,
    max_output_tokens_hard: hardOutput,
    estimated_total_tokens_formal: formalInput + formalOutput,
    estimated_total_tokens_hard: hardInput + hardOutput,
    hard_token_budget: hardTokenBudget,
    within_hard_token_budget: hardInput + hardOutput <= hardTokenBudget
  };
}

export async function runEvaluation({
  cases,
  providerTargets,
  invoke,
  cache,
  mode = 'formal',
  manifest = {}
} = {}) {
  if (!Array.isArray(cases) || !Array.isArray(providerTargets) ||
      typeof invoke !== 'function' || !cache?.append) {
    throw new Error('EVALUATION_DEPENDENCY_MISSING');
  }
  const initialCalls = cases.length * providerTargets.length;
  if (initialCalls > HARD_CALL_LIMIT) throw new Error('EVALUATION_HARD_CALL_LIMIT_EXCEEDED');
  if (mode === 'formal' && initialCalls !== FORMAL_INITIAL_CALLS) {
    throw new Error('FORMAL_EVALUATION_CALL_COUNT_INVALID');
  }
  const budget = buildPreflightBudget({
    cases,
    providerIds: providerTargets.map(({ provider_id: providerId }) => providerId)
  });
  if (!budget.within_hard_token_budget) throw new Error('EVALUATION_HARD_TOKEN_BUDGET_EXCEEDED');
  if (mode === 'formal') {
    if (!cache.beginFormalRun) throw new Error('FORMAL_EVALUATION_CACHE_INVALID');
    await cache.beginFormalRun({ ...manifest, budget });
  }

  let callCount = 0;
  const records = [];
  for (const target of providerTargets) {
    for (const definition of cases) {
      let retryCount = 0;
      while (true) {
        if (callCount >= HARD_CALL_LIMIT) throw new Error('EVALUATION_HARD_CALL_LIMIT_EXCEEDED');
        callCount += 1;
        const attempt = retryCount + 1;
        const started = performance.now();
        let record;
        try {
          const result = await invoke({
            providerTarget: target,
            caseDefinition: definition,
            messages: buildEvaluationMessages(definition),
            options: EVALUATION_PARAMETERS,
            attempt
          });
          record = {
            evaluation_version: manifest.evaluation_version || null,
            mode,
            provider_id: target.provider_id,
            model_id: target.model_id,
            case_id: definition.id,
            category: definition.category || null,
            attempt,
            call_index: callCount,
            http_success: true,
            http_status: Number(result.httpStatus || 200),
            latency_ms: Math.round(performance.now() - started),
            usage: normalizedUsage(result.usage),
            content: String(result.content || ''),
            error_type: null,
            error_code: null,
            recorded_at: new Date().toISOString()
          };
        } catch (error) {
          record = {
            evaluation_version: manifest.evaluation_version || null,
            mode,
            provider_id: target.provider_id,
            model_id: target.model_id,
            case_id: definition.id,
            category: definition.category || null,
            attempt,
            call_index: callCount,
            http_success: false,
            http_status: Number(error?.status || 0) || null,
            latency_ms: Math.round(performance.now() - started),
            usage: null,
            content: '',
            ...classifyEvaluationError(error),
            recorded_at: new Date().toISOString()
          };
        }
        const safe = await cache.append(record);
        records.push(safe || record);
        if (record.http_success || !shouldRetryTechnicalFailure(record, retryCount)) break;
        retryCount += 1;
      }
    }
  }
  return { call_count: callCount, records, budget };
}
