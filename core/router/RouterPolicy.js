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

export function resolveRouterPolicy(domain = '', metadata = {}) {
  const normalized = normalizeDomain(domain);
  if (normalized === ROUTER_DOMAINS.ORDINARY_CHAT && metadata.voiceRealtimeOnly === true && metadata.voiceAnswerContext) {
    return Object.freeze({version:'voice-answer-candidate-v1',domain:normalized,candidates:[{providerId:'qwen',modelId:metadata.voiceAnswerContext.protocol==='checked-v1' ? (metadata.voiceAnswerContext.phase==='review'&&(metadata.voiceAnswerContext.requireResourcePlan||metadata.voiceAnswerContext.simplePublicLookup||metadata.voiceAnswerContext.citationPassages?.length>0)?'qwen3.7-max':{plan:'qwen3.7-max',search:'qwen3.7-plus',review:'qwen3.7-flash',prepare:'qwen3.7-max',draft:'qwen3.7-flash'}[metadata.voiceAnswerContext.phase] || 'qwen3.7-max') : 'qwen3.7-max'}],allowFallback:false,maxAttempts:1,requirePreBusinessExecution:true});
  }
  return Object.freeze({
    version: 'router-core-m12-b2-v1',
    domain: normalized,
    candidates: APPROVED_ROUTER_CANDIDATES,
    allowFallback: FALLBACK_DOMAINS.has(normalized),
    maxAttempts: FALLBACK_DOMAINS.has(normalized) ? 2 : 1,
    requirePreBusinessExecution: true
  });
}

