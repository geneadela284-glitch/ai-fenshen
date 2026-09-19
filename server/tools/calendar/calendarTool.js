import lunar from 'lunar-javascript';
import { evaluateCalendarToolContract } from './calendarToolContract.js';

const MONTHS = Object.freeze(['', '正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊']);
const DAYS = Object.freeze(['', '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十']);
const RELATION_LABELS = Object.freeze({ self: '', mother: '妈妈', father: '爸爸', daughter: '女儿' });

function defaultEngine() {
  return Object.freeze({
    getLeapMonth: (year) => lunar.LunarYear.fromYear(year).getLeapMonth(),
    convertLunarToGregorian({ year, month, day, leap }) {
      const solar = lunar.Lunar.fromYmd(year, leap ? -month : month, day).getSolar();
      return { year: solar.getYear(), month: solar.getMonth(), day: solar.getDay() };
    }
  });
}

function resultSchema(value) {
  return Boolean(value?.ok && value.tool === 'calendar.convert' && value.action &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.data?.gregorian_date || '') &&
    Number.isInteger(value.data?.target_year) && typeof value.safe_user_message === 'string' && value.safe_user_message);
}

function planSchema(plan, { contextPack = null } = {}) {
  const errors = [];
  if (!['convert_calendar_date', 'next_occurrence', 'days_until'].includes(plan?.action)) errors.push('calendar.action: invalid');
  const args = plan?.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      !['gregorian', 'solar', 'lunar'].includes(args.source_calendar) || args.target_calendar !== 'gregorian' ||
      !['this_year', 'next_year', 'explicit_year', 'next_occurrence'].includes(args.target_year_reference) ||
      !['specified_year', 'next_occurrence'].includes(args.occurrence)) errors.push('calendar.arguments: invalid');
  const requirements = Array.isArray(plan?.required_evidence) ? plan.required_evidence : [];
  if (requirements.length !== 1 || requirements[0]?.predicate !== 'birthday' ||
      !['self', 'mother', 'father', 'daughter'].includes(requirements[0]?.entity_relation)) errors.push('calendar.evidence: invalid');
  if (contextPack) {
    const memory = contextPack.memory_context;
    const continuation = contextPack.tool_context;
    const hasSpecificOccurrence = Number.isInteger(memory?.qualifiers?.year) ||
      ![null, undefined, 'unknown', 'stable'].includes(memory?.qualifiers?.temporal_scope);
    const currentConversionGoal = memory?.intent === 'memory_query' && memory?.predicate === 'birthday' &&
      memory?.relation_to_owner === requirements[0]?.entity_relation &&
      (memory?.qualifiers?.calendar_type === 'gregorian' || hasSpecificOccurrence);
    const trustedContinuation = continuation?.previous_tool === 'calendar.convert' &&
      continuation?.previous_predicate === 'birthday' && continuation?.previous_entity === requirements[0]?.entity_relation;
    const explicitAgentGoal = plan?.confidence >= 0.85 && plan?.requires_confirmation === false &&
      Array.isArray(plan?.ambiguity) && plan.ambiguity.length === 0;
    if (!currentConversionGoal && !trustedContinuation && !explicitAgentGoal) {
      errors.push('calendar.goal: no trusted conversion intent');
    }
  }
  return { ok: errors.length === 0, errors };
}

export function createCalendarTool({ engine = defaultEngine() } = {}) {
  const tool = {
    id: 'calendar.convert',
    description: '使用可信记忆证据确定性地计算公历或农历生日的目标日期与剩余天数。正式action仅为convert_calendar_date、next_occurrence、days_until；结果日期和天数必须由工具计算。',
    actions: ['convert_calendar_date', 'next_occurrence', 'days_until'],
    argumentSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        source_calendar: { enum: ['gregorian', 'solar', 'lunar'] }, target_calendar: { enum: ['gregorian'] },
        target_year_reference: { enum: ['this_year', 'next_year', 'explicit_year', 'next_occurrence'] },
        target_year: { type: ['integer', 'null'] }, occurrence: { enum: ['specified_year', 'next_occurrence'] }
      },
      required: ['source_calendar', 'target_calendar', 'target_year_reference', 'occurrence']
    },
    evidenceSchema: {
      source: 'owner_scoped_memory', predicates: ['birthday'],
      qualifiers: ['calendar_type', 'month', 'day', 'lunar_leap_month'], status: 'confirmed_current'
    },
    permissions: ['authenticated_session', 'owner_scoped_memory_evidence'],
    planSchema,
    resultSchema,
    failureBehavior: 'fail_closed_without_unverified_date',
    contract(input) { return evaluateCalendarToolContract({ ...input, engine }); },
    execute(input) {
      const { calendarType, converted, targetYear, month, day, daysUntil, evidenceId, entityRelation, action } = input;
      const date = `${targetYear}-${String(converted.month).padStart(2, '0')}-${String(converted.day).padStart(2, '0')}`;
      const subject = RELATION_LABELS[entityRelation] || '这位家人';
      if (calendarType === 'gregorian') {
        const prefix = entityRelation === 'self'
          ? `你是公历${month}月${day}日生日`
          : `你${subject}是公历${month}月${day}日生日`;
        const message = daysUntil === null
          ? `${prefix}，${targetYear}年的生日是${converted.month}月${converted.day}日。`
          : `${prefix}，下一次生日是${targetYear}年${converted.month}月${converted.day}日，还有${daysUntil}天。`;
        return {
          ok: true, tool: 'calendar.convert', action, evidence_ids: [evidenceId],
          data: { gregorian_date: date, target_year: targetYear, days_until: daysUntil },
          safe_user_message: message
        };
      }
      const lunarDate = `${input.leap ? '闰' : ''}${MONTHS[month] || month}月${DAYS[day] || day}`;
      const prefix = `你${subject}是农历${lunarDate}生日`;
      const message = daysUntil === null
        ? `${prefix}，${targetYear}年对应的公历日期是${converted.month}月${converted.day}日。`
        : `${prefix}，下一次对应公历${targetYear}年${converted.month}月${converted.day}日，还有${daysUntil}天。`;
      return {
        ok: true, tool: 'calendar.convert', action, evidence_ids: [evidenceId],
        data: { gregorian_date: date, target_year: targetYear, days_until: daysUntil },
        safe_user_message: message
      };
    }
  };
  return Object.freeze({
    ...tool,
    async run(input) {
      const contract = await tool.contract(input);
      if (contract.decision !== 'ACCEPT') return contract;
      try {
        const result = await tool.execute(contract.input);
        return resultSchema(result) ? { decision: 'ACCEPT', result } : { decision: 'ERROR', code: 'CALENDAR_TOOL_FAILED', content: '暂时无法完成日期换算，请稍后再试。' };
      } catch {
        return { decision: 'ERROR', code: 'CALENDAR_TOOL_FAILED', content: '暂时无法完成日期换算，请稍后再试。' };
      }
    }
  });
}
