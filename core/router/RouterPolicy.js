export const ROUTER_DOMAINS = Object.freeze({
  ORDINARY_CHAT: 'ordinary_chat',
  SEMANTIC_PLANNER: 'semantic_planner',
  FINANCE: 'finance',
  MEMORY: 'memory',
  CALENDAR: 'calendar'
});

export const APPROVED_ROUTER_CANDIDATES = Object.freeze([
  Object.freeze({ providerId: 'deepseek', modelId: 'deepseek-v4-flash' }),
  Object.freeze({ providerId: 'qwen', modelId: 'qwen-max' })
]);

const FALLBACK_DOMAINS = new Set([
  ROUTER_DOMAINS.ORDINARY_CHAT,
  ROUTER_DOMAINS.SEMANTIC_PLANNER,
  ROUTER_DOMAINS.FINANCE
]);

function normalizeDomain(domain = '') {
  const value = String(domain || '').trim().toLowerCase();
  return Object.values(ROUTER_DOMAINS).includes(value) ? value : '';
}

export function resolveRouterPolicy(domain = '') {
  const normalized = normalizeDomain(domain);
  return Object.freeze({
    version: 'router-core-m12-b2-v1',
    domain: normalized,
    candidates: APPROVED_ROUTER_CANDIDATES,
    allowFallback: FALLBACK_DOMAINS.has(normalized),
    maxAttempts: FALLBACK_DOMAINS.has(normalized) ? 2 : 1,
    requirePreBusinessExecution: true
  });
}

