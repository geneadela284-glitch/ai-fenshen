import { MemoryType } from '../kernel/index.js';
import { CaptureIntent, CaptureReasonCode } from './contracts.js';
import { parseFamilyBirthdayStatement } from './familyBirthdayParser.js';

const OPT_OUT = /(?:不要|别|无需|不用)(?:再)?(?:记住|记录|保存)/;
const FORGET = /^(?:忘掉|忘记|删除(?:这条)?记忆|不要再记得)(?:[，,。.:：\s]*)/;
const EXPLICIT = /^(?:(?:请|帮我)\s*)?(?:记住|以后记得|保存(?:一下)?|记一下)(?:[，,。.:：\s]*)/;
const TEMPORARY = /^(?:这次|本次|当前任务|暂时|今天(?:先)?|接下来)/;
const TEMPORARY_STATE = /^(?:我)?(?:最近|今天|现在|这会儿|目前)(?:有点|比较|很)?(?:累|困|忙|饿|渴|烦|不舒服|心情不好)/;
const PREFERENCE = /(?:我(?:一直|通常|平时)?(?:更)?(?:喜欢|偏好|不喜欢|讨厌|不吃|爱吃|常用)|我的偏好是)/;
const UNCERTAIN = /(?:好像|可能|大概|也许|似乎|不确定|记不清|没记错的话)/;
const FAMILY_MEMBER = '(?:妈妈|母亲|妈|爸爸|父亲|爸|女儿|儿子|妻子|老婆|丈夫|老公)';
const RELATION_LABEL = '(?:妈妈|母亲|妈|爸爸|父亲|爸|女儿|儿子|妻子|老婆|丈夫|老公|朋友|同事|客户)';
const GOAL = /^(?:我(?:的)?(?:长期|未来|今年)?目标是|我的重点目标是|我希望长期|我计划在未来)/;
const ROUTINE = /^(?:我(?:每天|每周|每月|通常|固定|长期|习惯)|我的(?:固定)?作息是|我的习惯是)/;
const CONSTRAINT = /^(?:我(?:长期)?(?:不能|不可以|需要避免)|我的(?:长期)?(?:限制|禁忌)是)/;
const RELATIONSHIP = new RegExp(`^(?:[^，。！？]{1,30}是我的${RELATION_LABEL}|我的${RELATION_LABEL}是[^，。！？]{1,30})$`);
const SENSITIVE_FAMILY_FACT = new RegExp(`^我${FAMILY_MEMBER}(?:的)?(?:健康|病历|诊断|疾病|收入|财务|资产|住址|地址|私密关系).+$`);
const ANNIVERSARY = /^(?:我(?:们)?的)?[^，。！？]{1,30}(?:纪念日|周年日)是.+/;
const QUESTION = /[?？]$|^(?:什么|怎么|怎样|为什么|是否|请问|能否|可否)/;
const LOW_VALUE = /^(?:你好|您好|谢谢|哈哈+|收到|好的)[。！!\s]*$/;

function normalize(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function result(values = {}) {
  return {
    intent: CaptureIntent.NOT_MEMORY,
    reasonCode: CaptureReasonCode.NOT_MEMORY,
    content: '',
    memoryType: null,
    explicit: false,
    userExplicitStatement: false,
    directSaveAuthorized: false,
    uncertain: false,
    semantic: null,
    ...values
  };
}

function familyBirthday(value) {
  const parsed = parseFamilyBirthdayStatement(value);
  if (!parsed) return null;
  return {
    content: parsed.content,
    memoryType: MemoryType.RELATIONSHIP,
    semantic: parsed.semantic,
    uncertain: parsed.uncertain
  };
}

function highValue(value) {
  const birthday = familyBirthday(value);
  if (birthday) return birthday;
  if (SENSITIVE_FAMILY_FACT.test(value)) return { content: value, memoryType: MemoryType.RELATIONSHIP, semantic: { kind: 'sensitive_family_fact' } };
  if (PREFERENCE.test(value)) return { content: value, memoryType: MemoryType.PREFERENCE, semantic: { kind: 'preference' } };
  if (GOAL.test(value)) return { content: value, memoryType: MemoryType.GOAL, semantic: { kind: 'goal' } };
  if (ROUTINE.test(value)) return { content: value, memoryType: MemoryType.HABIT_ROUTINE, semantic: { kind: 'routine' } };
  if (CONSTRAINT.test(value)) return { content: value, memoryType: MemoryType.CONSTRAINT, semantic: { kind: 'constraint' } };
  if (ANNIVERSARY.test(value)) return { content: value, memoryType: MemoryType.LIFE_EVENT, semantic: { kind: 'anniversary' } };
  if (RELATIONSHIP.test(value)) return { content: value, memoryType: MemoryType.RELATIONSHIP, semantic: { kind: 'relationship' } };
  return null;
}

function memoryType(content) {
  if (PREFERENCE.test(content)) return MemoryType.PREFERENCE;
  if (/(?:女儿|儿子|父亲|母亲|爸爸|妈妈|妻子|丈夫|家人|朋友|同事)/.test(content)) return MemoryType.RELATIONSHIP;
  if (/(?:目标|希望长期|计划在)/.test(content)) return MemoryType.GOAL;
  if (/(?:搬到|搬家|结婚|毕业|出生)/.test(content)) return MemoryType.LIFE_EVENT;
  return MemoryType.FACT;
}

export class MemoryIntentAnalyzer {
  analyze(input) {
    const text = normalize(input);
    if (!text) return result();
    if (FORGET.test(text)) {
      return result({
        intent: CaptureIntent.FORGET,
        reasonCode: CaptureReasonCode.FORGET_INTENT,
        content: normalize(text.replace(FORGET, '')),
        explicit: true
      });
    }
    if (OPT_OUT.test(text)) {
      return result({ reasonCode: CaptureReasonCode.USER_OPTED_OUT });
    }
    if (EXPLICIT.test(text)) {
      const originalContent = normalize(text.replace(EXPLICIT, ''));
      if (!originalContent) return result({ reasonCode: CaptureReasonCode.INVALID_INPUT });
      const durable = highValue(originalContent);
      return result({
        intent: CaptureIntent.EXPLICIT_REMEMBER,
        reasonCode: CaptureReasonCode.EXPLICIT_REMEMBER,
        content: durable?.content || originalContent,
        memoryType: durable?.memoryType || memoryType(originalContent),
        explicit: true,
        userExplicitStatement: true,
        directSaveAuthorized: true,
        semantic: durable?.semantic || null
      });
    }
    if (QUESTION.test(text) || LOW_VALUE.test(text)) {
      return result();
    }
    if (TEMPORARY.test(text) || TEMPORARY_STATE.test(text)) {
      return result({ intent: CaptureIntent.CONTEXT_ONLY, reasonCode: CaptureReasonCode.CONTEXT_ONLY, content: text, memoryType: MemoryType.CONTEXT });
    }
    const durable = highValue(text);
    if (durable) {
      const uncertain = durable.uncertain === true || UNCERTAIN.test(text);
      return result({
        intent: CaptureIntent.LONG_TERM_MEMORY,
        reasonCode: uncertain ? CaptureReasonCode.UNCERTAIN_USER_STATEMENT : CaptureReasonCode.PROACTIVE_HIGH_VALUE_SIGNAL,
        content: durable.content,
        memoryType: durable.memoryType,
        userExplicitStatement: true,
        directSaveAuthorized: !uncertain,
        uncertain,
        semantic: durable.semantic
      });
    }
    return result();
  }
}
