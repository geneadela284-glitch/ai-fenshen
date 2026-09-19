export const ASSISTANT_PROVIDER_PLAN_SCHEMA_ID = 'assistant-provider-plan-candidate-v1';

const CONTRACT = `只把给定Raw结果转换为一个严格JSON对象。不得重新解释用户目标，不得增加、删除或替换任何语义事实。
输出字段必须且只能是：
domain,intent,action,entity,relation_to_owner,predicate,value,qualifiers,tool,arguments,required_evidence,explicit_fields,inherited_fields,ambiguity_reasons,confidence,requires_confirmation,source_spans,source_message_id。
entity必须是仅含type,reference,relation_to_owner的对象。
qualifiers和arguments必须是对象。
required_evidence、explicit_fields、inherited_fields、ambiguity_reasons、source_spans必须是数组。
缺失的纯结构容器只能补为null、{}、[]或false；不得补充新事实、实体、金额、日期、关系、动作、Evidence或Calendar qualifier。
不得调用工具，不得输出Markdown或解释，只输出修复后的完整JSON对象。`;

function boundedErrors(errors = []) {
  return (Array.isArray(errors) ? errors : [])
    .filter((value) => typeof value === 'string')
    .slice(0, 24)
    .map((value) => value.slice(0, 240));
}

export function buildSchemaRepairMessages({
  schemaContract,
  rawContent,
  errors = []
} = {}) {
  if (schemaContract !== ASSISTANT_PROVIDER_PLAN_SCHEMA_ID) {
    throw Object.assign(new Error('unsupported schema repair contract'), {
      code: 'SCHEMA_REPAIR_CONTRACT_UNSUPPORTED'
    });
  }
  return Object.freeze([
    Object.freeze({ role: 'system', content: CONTRACT }),
    Object.freeze({
      role: 'user',
      content: JSON.stringify({
        schema_id: ASSISTANT_PROVIDER_PLAN_SCHEMA_ID,
        schema_errors: boundedErrors(errors),
        raw_result: String(rawContent || '')
      })
    })
  ]);
}
