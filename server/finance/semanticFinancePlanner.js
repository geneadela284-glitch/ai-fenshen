import { CAPABILITIES } from '../../core/router/CapabilityMap.js';
import { bindFinancePlanEvidence } from './financeEvidenceBinder.js';
import { canonicalizeFinancePlan } from './financePlanCanonicalizer.js';
import { validateSemanticFinancePlan } from './financeToolContract.js';

const SYSTEM_PROMPT = `你是AI分身的财务工具语义规划器。只输出一个JSON对象，不输出Markdown，也不计算任何金额合计。\n`
  + `先理解完整语义与当前对话上下文，再决定domain。domain只能是finance,memory,ordinary_chat,ambiguous。\n`
  + `输出必须严格包含domain,action,metrics,period_type,period_expression,category,counterparty,keyword,transaction_candidate,entry_reference,changes,inherited_context,confidence,source_spans,requires_confirmation。\n`
  + `action只能是query,create,update,delete,ambiguous,ordinary_chat。查询已有账本是query；陈述一笔已发生且有具体金额的事实才是create。\n`
  + `metrics是数组，元素只能是income,expense,net,entries；用户同时要求多个指标时必须全部保留。收入和支出同时请求时metrics必须同时包含income和expense。\n`
  + `period_type只能是today,yesterday,day_before_yesterday,this_week,last_week,this_month,last_month,last_7_days,last_30_days,explicit_day,explicit_range,all_time或null。`
  + `本周是自然周，最近7天是连续七个自然日；本月是自然月，最近30天是连续三十个自然日。只输出period_type和原文时间片段，不输出时间戳。\n`
  + `transaction_candidate严格包含direction,amount_text,occurred_expression；direction只能是income,expense或null。amount_text必须是原文片段，不得换算。\n`
  + `inherited_context严格包含previous_action,previous_metrics,previous_period_type，只能继承提供的可信当前会话上下文。不得输出owner_id或任何owner字段。\n`
  + `confidence必须是0到1。source_spans必须是非空数组，每项严格包含text,start,end，且逐字来自当前消息；不能确定时用整条当前消息。`;

function withoutOwner(value) {
  if (Array.isArray(value)) return value.map(withoutOwner);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id'].includes(key))
    .map(([key, child]) => [key, withoutOwner(child)]));
}

function parse(content) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(raw); } catch { return null; }
}

export function createSemanticFinancePlanner({ aiService, timeoutMs = 8000 } = {}) {
  if (!aiService || typeof aiService.run !== 'function') throw new TypeError('Semantic Finance Planner requires aiService.run().');
  return Object.freeze({
    async plan({ message, contextPack = {}, timezone = 'Asia/Shanghai', now = new Date(), invocation = {} } = {}) {
      const text = String(message || '').trim();
      if (!text) return { ok: false, code: 'SEMANTIC_FINANCE_INPUT_REQUIRED', attempts: 0 };
      let errors = [];
      let failureCode = 'SEMANTIC_FINANCE_PLAN_INVALID';
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let result;
        try {
          result = await aiService.run({
            input: text,
            capability: CAPABILITIES.CHAT,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify({ message: text, context: withoutOwner(contextPack) }) },
              ...(attempt === 2 ? [{ role: 'system', content: `上一次输出未通过Schema：${errors.join(',')}。只返回修正后的完整JSON；source_spans可使用整条当前消息。` }] : [])
            ],
            metadata: { purpose: 'semantic_finance_planner_v1', memoryPolicy: 'disabled' },
            options: { timeoutMs }
          }, invocation);
        } catch {
          result = { ok: false };
        }
        if (!result?.ok) return { ok: false, code: 'SEMANTIC_FINANCE_PLANNER_UNAVAILABLE', attempts: attempt };
        const value = canonicalizeFinancePlan(parse(result.content));
        const structure = value
          ? validateSemanticFinancePlan(value, { message: text, sourceSpansAsHints: true })
          : { ok: false, errors: ['response_invalid_json'] };
        if (!structure.ok) {
          errors = structure.errors;
          failureCode = 'SEMANTIC_FINANCE_PLAN_INVALID';
          continue;
        }
        const evidence = bindFinancePlanEvidence(value, { message: text, timezone, now });
        if (!evidence.ok) {
          errors = [evidence.reasonCode];
          failureCode = 'SEMANTIC_FINANCE_EVIDENCE_INVALID';
          continue;
        }
        const validation = validateSemanticFinancePlan(evidence.plan, { message: text });
        if (validation.ok) {
          return {
            ok: true,
            plan: Object.freeze(structuredClone(evidence.plan)),
            evidenceAudit: Object.freeze([...evidence.auditReasons]),
            attempts: attempt,
            source: 'model'
          };
        }
        errors = validation.errors;
        failureCode = 'SEMANTIC_FINANCE_PLAN_INVALID';
      }
      return { ok: false, code: failureCode, attempts: 2, errors };
    }
  });
}
