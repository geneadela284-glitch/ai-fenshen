import { CAPABILITIES } from '../../core/router/CapabilityMap.js';
import { parseSemanticMemoryPlanResponse } from './semanticMemoryPlanSchema.js';

const SYSTEM_PROMPT = `你是长期记忆语义规划器，只输出一个JSON对象，不输出Markdown。\n你的输出必须严格包含：intent, subject, predicate, value, qualifiers, confidence, source_spans, ambiguity_reasons, requires_confirmation, inherited_context。\nintent只能是memory_candidate,memory_query,memory_correction,memory_negation,memory_delete,ordinary_chat,ambiguous。\nsubject严格包含entity_type,relation_to_owner,normalized_reference,resolved_entity_hint；不得输出owner_id。entity_type和normalized_reference必须是非空字符串；relation_to_owner只能是self,mother,father,daughter,son,spouse,other,unknown；resolved_entity_hint只能是非空字符串或null。\npredicate必须是规范英文键：生日只用birthday，普通喜欢用likes_加类别（例likes_food、likes_activity），最喜欢用favorite_加类别（例favorite_food）；ordinary_chat或无法确定时可用null；不得使用中文谓词。value可为null、字符串、数字、对象或数组。\nqualifiers严格包含calendar_type,year,month,day,lunar_leap_month,temporal_scope,recurrence,degree,cardinality,negation,uncertainty。calendar_type只能是gregorian,lunar,unknown；year/month/day只能是整数或null；temporal_scope必须是非空字符串，稳定事实用stable；recurrence只能是yearly,one_time,unknown；degree必须是非空字符串，无特殊程度时用normal；cardinality只能是single,multiple,unknown；lunar_leap_month只能是JSON布尔true、false或字符串unknown；negation和uncertainty必须是JSON布尔值。\nconfidence必须是0到1的数字；ambiguity_reasons必须是字符串数组，无原因时用[]；requires_confirmation必须是JSON布尔值。\ninherited_context严格包含previous_entity,previous_predicate,previously_returned_values。previous_entity和previous_predicate只能是非空字符串或null；previously_returned_values必须是字符串数组，无值时用[]。\nsource_spans必须是非空数组，每项严格包含text,start,end，必须逐字来自当前用户消息，start包含、end不包含，按JavaScript字符串索引计数。如无法确信局部索引，必须用完整当前消息，text等于完整消息、start为0、end为消息长度。\n不确定人物、日期、谓词或否定范围时输出ambiguous并只给一个最必要原因。`;

function withoutOwner(value) {
  if (Array.isArray(value)) return value.map(withoutOwner);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id'].includes(key))
    .map(([key, child]) => [key, withoutOwner(child)]));
}

function repairPrompt(errors, text) {
  const exactSpan = JSON.stringify([{ text, start: 0, end: text.length }]);
  const predicateCorrection = /最(?:喜欢|爱)/.test(text)
    ? `当前原文明示“最喜欢”或“最爱”程度，必须使用favorite_谓词。`
    : `当前原文没有“最喜欢”或“最爱”程度，必须使用likes_谓词。`;
  const negationCorrection = errors.includes('intent:explicit_preference_negation_conflict')
    ? `当前用户原文优先于继承上下文；继承的previous_predicate只用于消解省略，不能覆盖当前明确语义。`
      + `该错误表示当前原文已明确否定一项偏好，必须改为intent=memory_negation、qualifiers.negation=true，`
      + `不得继续输出memory_correction。${predicateCorrection}`
    : errors.includes('predicate:explicit_negation_degree_conflict')
      ? `当前用户原文优先于继承上下文。${predicateCorrection}`
    : '';
  return `上一次JSON未通过Schema。错误代码：${errors.join(',')}。`
    + negationCorrection
    + `未知年份必须用year=null，未知月或日也必须用null，不得将unknown字符串放入年月日。`
    + `稳定事实必须用temporal_scope=stable，temporal_scope不得为null。`
    + `生日语义必须用predicate=birthday，喜欢食物用likes_food，最喜欢食物用favorite_food，不得使用中文谓词。`
    + `明确表达不喜欢、不再喜欢或讨厌某项时必须用intent=memory_negation且negation=true；普通修正必须negation=false。`
    + `无特殊程度时必须用degree=normal；单值事实必须用cardinality=single，多值集合用cardinality=multiple，其他用unknown。`
    + `negation=false、uncertainty=false、requires_confirmation=false都必须是JSON布尔值；无继承值时必须用previously_returned_values=[]，无歧义时必须用ambiguity_reasons=[]。`
    + `本次请直接使用source_spans=${exactSpan}。只返回修正后的完整JSON对象。`;
}

function ambiguityReviewPrompt(plan, text) {
  const reasons = Array.isArray(plan?.ambiguity_reasons) ? plan.ambiguity_reasons.join(',') : 'unspecified';
  const exactSpan = JSON.stringify([{ text, start: 0, end: text.length }]);
  return `上一次JSON结构合法但语义被标为需要确认。歧义原因：${reasons}。`
    + `请只依据当前用户原文和提供的可信上下文重新复核一次，不得补充原文中没有的信息。`
    + `若人物、谓词、值和限定条件已经能从原文或可信继承上下文明确确定，应选择准确intent，设置requires_confirmation=false且ambiguity_reasons=[]；否则保持ambiguous。`
    + `本次请使用source_spans=${exactSpan}。只返回复核后的完整JSON对象。`;
}

export function createSemanticMemoryPlanner({ aiService, timeoutMs = 8000 } = {}) {
  if (!aiService || typeof aiService.run !== 'function') throw new TypeError('Semantic planner requires aiService.run().');
  return Object.freeze({
    async plan({ message, contextPack = {}, invocation = {} } = {}) {
      const text = String(message || '').trim();
      if (!text) return Object.freeze({ ok: false, code: 'SEMANTIC_INPUT_REQUIRED', attempts: 0 });
      let errors = [];
      let retryInstruction = '';
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        let result;
        try {
          result = await aiService.run({
            input: text,
            capability: CAPABILITIES.CHAT,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: JSON.stringify({ message: text, context: withoutOwner(contextPack) }) },
              ...(attempt === 2 ? [{ role: 'system', content: retryInstruction || repairPrompt(errors, text) }] : [])
            ],
            metadata: { purpose: 'semantic_memory_planner_v1', memoryPolicy: 'disabled' },
            options: { timeoutMs }
          }, invocation);
        } catch {
          result = { ok: false };
        }
        if (!result?.ok) {
          return Object.freeze({ ok: false, code: 'SEMANTIC_PLANNER_UNAVAILABLE', attempts: attempt });
        }
        const parsed = parseSemanticMemoryPlanResponse(result.content, { text });
        if (parsed.valid) {
          const ambiguous = parsed.value.intent === 'ambiguous' || parsed.value.requires_confirmation;
          if (!ambiguous || attempt === 2) {
            return Object.freeze({ ok: true, plan: parsed.value, attempts: attempt, source: 'model' });
          }
          retryInstruction = ambiguityReviewPrompt(parsed.value, text);
          continue;
        }
        errors = [...parsed.errors];
        retryInstruction = repairPrompt(errors, text);
      }
      return Object.freeze({ ok: false, code: 'SEMANTIC_PLAN_INVALID', attempts: 2, errors: Object.freeze(errors) });
    }
  });
}
