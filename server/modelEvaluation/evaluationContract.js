export const EVALUATION_VERSION = 'model-evaluation-m12-b1-v1';
export const FORMAL_PROVIDER_IDS = Object.freeze(['deepseek', 'qwen', 'kimi', 'zhipu']);
export const FORMAL_INITIAL_CALLS = 96;
export const FORMAL_CALL_LIMIT = 96;
export const HARD_CALL_LIMIT = 120;

export const EVALUATION_PARAMETERS = Object.freeze({
  temperature: 0,
  max_tokens: 768,
  timeout_ms: 30000,
  timezone: 'Asia/Shanghai',
  now: '2026-07-27T12:00:00.000+08:00'
});

const EXPECTED_CATEGORY_COUNTS = Object.freeze({
  ordinary_chat: 4,
  semantic: 6,
  finance: 4,
  memory: 4,
  calendar: 4,
  stability: 2
});

const RAW_PLAN_FIELDS = [
  'domain', 'intent', 'action', 'entity', 'relation_to_owner', 'predicate',
  'value', 'qualifiers', 'tool', 'arguments', 'required_evidence',
  'explicit_fields', 'inherited_fields', 'ambiguity_reasons', 'confidence',
  'requires_confirmation', 'source_spans', 'source_message_id'
];

export const EVALUATION_SYSTEM_CONTRACT = `你是AI分身的统一语义评测入口。只输出一个JSON对象，不输出Markdown，不执行工具，不写数据库，不计算金额合计、日期换算或剩余天数。
顶层必须严格只有plan和assistant_text两个字段。plan必须严格包含${RAW_PLAN_FIELDS.join(',')}。
plan.domain只能是memory、finance、tool、ordinary_chat或ambiguous。plan.entity严格包含type、reference、relation_to_owner。source_message_id必须为null，不得输出任何owner字段。
当前消息明确表达的字段放入explicit_fields；只有给定可信上下文且当前消息省略的字段才放入inherited_fields；当前明确表达优先。
Memory区分新增、查询、补充、修正、否定和删除；完整出生日期用birth_date，每年生日用birthday；历法未说明用unknown。
Finance只描述create、query、update或delete意图及原始候选，不计算合计；相对自然日用qualifiers.relative_day_offset表示，当前日为0、前一日为-1、后一日为1。
Tool只能使用tool=calendar.convert，并以action=next_occurrence、days_until或convert_calendar_date区分动作；必须提供required_evidence，不提供工具结果。
ordinary_chat必须使用intent=ordinary_chat、action=ordinary_chat；assistant_text必须是自然、简洁、诚实的中文回答并保持AI分身身份。非ordinary_chat时assistant_text必须为null；ambiguous时可用一句最必要的澄清问题。
真正缺少关键对象或动作时必须输出ambiguous，ambiguity_reasons非空且requires_confirmation=true。无歧义时ambiguity_reasons=[]。
所有数组和对象必须使用JSON类型，不得增加字段。`;

export function buildEvaluationMessages(caseDefinition) {
  return [
    { role: 'system', content: EVALUATION_SYSTEM_CONTRACT },
    {
      role: 'user',
      content: JSON.stringify({
        evaluation_case_id: caseDefinition.id,
        message: caseDefinition.message,
        context: caseDefinition.context || {},
        runtime_context: {
          timezone: EVALUATION_PARAMETERS.timezone,
          current_time: EVALUATION_PARAMETERS.now,
          local_date: '2026-07-27'
        }
      })
    }
  ];
}

export function validateFrozenEvaluationSuite(cases) {
  if (!Array.isArray(cases) || cases.length !== 24) {
    throw new Error('EVALUATION_CASE_COUNT_INVALID');
  }
  const ids = cases.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('EVALUATION_CASE_ID_DUPLICATE');
  const counts = Object.fromEntries(
    Object.entries(Object.groupBy(cases, ({ category }) => category))
      .map(([category, entries]) => [category, entries.length])
  );
  if (JSON.stringify(counts) !== JSON.stringify(EXPECTED_CATEGORY_COUNTS)) {
    throw new Error('EVALUATION_CATEGORY_COUNTS_INVALID');
  }
  if (cases.some(({ synthetic }) => synthetic !== true)) {
    throw new Error('EVALUATION_CASE_NOT_SYNTHETIC');
  }
  const initial = cases.length * FORMAL_PROVIDER_IDS.length;
  if (initial !== FORMAL_INITIAL_CALLS || initial > FORMAL_CALL_LIMIT) {
    throw new Error('EVALUATION_FORMAL_CALL_COUNT_INVALID');
  }
  return {
    valid: true,
    case_count: cases.length,
    provider_count: FORMAL_PROVIDER_IDS.length,
    initial_call_count: initial
  };
}
