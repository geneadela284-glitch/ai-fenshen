import { CAPABILITIES } from '../../core/router/CapabilityMap.js';
import { parseAssistantToolPlanResponse } from './assistantToolPlanSchema.js';

function withoutOwner(value) {
  if (Array.isArray(value)) return value.map(withoutOwner);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id'].includes(key))
    .map(([key, child]) => [key, withoutOwner(child)]));
}

function systemPrompt(toolDescriptors) {
  return `你是AI分身的通用工具语义规划器。只输出一个JSON对象，不输出Markdown，不执行工具，不计算工具结果。\n`
    + `根据用户目标、可信对话上下文和已注册工具描述，决定是否需要工具。工具清单：${JSON.stringify(toolDescriptors)}。\n`
    + `输出必须严格包含domain,action,tool,arguments,required_evidence,inherited_context,confidence,ambiguity,requires_confirmation,source_message_id。\n`
    + `domain只能是tool或ordinary_chat。无需工具时action=ordinary_chat,tool=null,arguments={},required_evidence=[]。\n`
    + `required_evidence每项严格包含entity_relation,predicate,required_qualifiers：entity_relation和predicate必须是字符串，required_qualifiers必须是字符串数组，三者都不能是对象。entity_relation只能复制可信memory_context.relation_to_owner，不能使用Evidence来源名称。inherited_context严格包含previous_entity,previous_predicate,previous_tool，值只能是字符串或null。\n`
    + `confidence必须是0到1的数字，不能写high或medium。ambiguity必须是字符串数组，无歧义时必须是[]，不能写none或单个字符串。requires_confirmation必须是布尔值。source_message_id必须是null，由服务端绑定。\n`
    + `只能选择工具清单中的tool；arguments只描述用户请求，不得提供工具最终结果；不得输出任何owner字段。`;
}

export function createAssistantToolPlanner({ aiService, toolDescriptors = [], validatePlan = null, timeoutMs = 8000 } = {}) {
  if (!aiService || typeof aiService.run !== 'function') throw new TypeError('Assistant Tool Planner requires aiService.run().');
  const descriptors = structuredClone(toolDescriptors);
  return Object.freeze({
    async plan({ message, sourceMessageId = null, contextPack = {}, invocation = {} } = {}) {
      const text = String(message || '').trim();
      if (!text) return { ok: false, code: 'ASSISTANT_TOOL_INPUT_REQUIRED', attempts: 0 };
      let errors = [];
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let result;
        try {
          result = await aiService.run({
            input: text,
            capability: CAPABILITIES.CHAT,
            messages: [
              { role: 'system', content: systemPrompt(descriptors) },
              { role: 'user', content: JSON.stringify({ message: text, context: withoutOwner(contextPack) }) },
              ...(attempt === 2 ? [{ role: 'system', content: `上一次输出未通过Schema：${errors.join(',')}。只返回修正后的完整JSON。` }] : [])
            ],
            metadata: { purpose: 'assistant_tool_planner_v1', memoryPolicy: 'disabled' },
            options: { timeoutMs }
          }, invocation);
        } catch {
          result = { ok: false };
        }
        if (!result?.ok) return { ok: false, code: 'ASSISTANT_TOOL_PLANNER_UNAVAILABLE', attempts: attempt };
        const parsed = parseAssistantToolPlanResponse(result.content);
        if (!parsed.valid) { errors = parsed.errors; continue; }
        if (parsed.value.domain === 'tool' && typeof validatePlan === 'function') {
          const toolValidation = validatePlan(parsed.value.tool, parsed.value, { message: text, contextPack: withoutOwner(contextPack) });
          if (!toolValidation?.ok) { errors = toolValidation?.errors || ['tool plan invalid']; continue; }
        }
        return {
          ok: true,
          plan: Object.freeze({ ...structuredClone(parsed.value), source_message_id: sourceMessageId || null }),
          attempts: attempt,
          source: 'model'
        };
      }
      return { ok: false, code: 'ASSISTANT_TOOL_PLAN_INVALID', attempts: 2, errors };
    }
  });
}
