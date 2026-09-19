import { extractAmount, extractTime } from './memoryExtractor.js';
import { normalizeMemoryInput } from './memoryNormalizer.js';
import { isAiResultText, isCorrectionRequest, isQueryLikeInput } from '../inputRouter/inputSafetyGuards.js';

const lowValuePatterns = [
  /^你?好[。！!]*$/,
  /^谢谢[。！!]*$/,
  /^哈哈+[。！!]*$/,
  /帮我翻译这句话/,
  /天气怎么样/,
  /^$/
];

const sensitivePatterns = [
  { type: 'bank_card', pattern: /(?:银行卡号|银行卡|卡号)(?:.{0,12}\d{12,19}|.{0,8}…+|.{0,8}\.\.\.)?/ },
  { type: 'id_card', pattern: /(?:身份证号|身份证).{0,12}\d{15,18}[\dXx]?/ },
  { type: 'password', pattern: /(?:密码|passcode|password).{0,20}/i },
  { type: 'precise_address', pattern: /(?:住址|地址).{0,40}(?:号|室|单元|栋)/ },
  { type: 'health_privacy', pattern: /(?:病历|诊断|抑郁|癌症|传染病|体检报告)/ }
];

function proposedType(text = '', context = {}) {
  if (/喜欢|偏好|习惯|常用|不喜欢/.test(text)) return 'preference';
  if (/报价|价格/.test(text)) return 'quote';
  if (/收入|收到|收款|到账|货款|回款|进账|营收/.test(text)) return 'income';
  if (/支出|(?:又|再|另外|还)?花(?:了)?|花费|消费|付款|买|支付|成本|停车|零食|买菜|超市|购物|吃饭|午饭|晚饭|早饭|早餐|午餐|晚餐|饭钱|餐饮|外卖|打车|车费/.test(text)) return 'expense';
  if (/提醒|记得|别忘/.test(text)) return 'reminder';
  if (/待办|要做|需要完成|提交|处理/.test(text)) return 'todo';
  if (extractTime(text, context)) return 'schedule';
  if (/客户|张总|李总|王总|赵总/.test(text)) return 'customer_fact';
  if (/项目|方案|版本|上线|交付/.test(text)) return 'project_fact';
  if (/记住|记一下|记录一下|保存一下|帮我保存/.test(text)) return 'generic_memory';
  return 'generic_memory';
}

export function detectSensitivity(input = '') {
  const text = normalizeMemoryInput(input);
  const matches = sensitivePatterns.filter((item) => item.pattern.test(text)).map((item) => item.type);
  return {
    sensitivity: matches.length ? 'high' : 'low',
    types: matches
  };
}

export function shouldRemember(input = '', context = {}) {
  const normalizedInput = normalizeMemoryInput(input);
  const sensitivity = detectSensitivity(normalizedInput);
  if (!normalizedInput) {
    return { remember: false, confidence: 1, reason: 'empty_input', proposedType: 'generic_memory', needsConfirmation: false };
  }
  if (sensitivity.sensitivity === 'high') {
    return {
      remember: true,
      confidence: 0.9,
      reason: 'sensitive_information_requires_confirmation',
      proposedType: proposedType(normalizedInput, context),
      needsConfirmation: true
    };
  }
  if (lowValuePatterns.some((pattern) => pattern.test(normalizedInput))) {
    return { remember: false, confidence: 0.92, reason: 'low_long_term_value', proposedType: 'generic_memory', needsConfirmation: false };
  }
  if (context.historyLoad || context.isHistoryLoad || context.sourceType === 'history') {
    return { remember: false, confidence: 0.95, reason: 'history_load_not_new_input', proposedType: 'generic_memory', needsConfirmation: false };
  }
  if (isQueryLikeInput(normalizedInput)) {
    return { remember: false, confidence: 0.94, reason: 'query_or_explanation_not_memory', proposedType: 'generic_memory', needsConfirmation: false };
  }
  if (isCorrectionRequest(normalizedInput) && !context.allowCorrectionMemory) {
    return { remember: false, confidence: 0.9, reason: 'correction_request_not_memory', proposedType: 'generic_memory', needsConfirmation: false };
  }

  const hasExplicitRemember = /记住|记一下|记录一下|保存一下|帮我保存/.test(normalizedInput);
  const hasAmount = Boolean(extractAmount(normalizedInput));
  const hasTime = Boolean(extractTime(normalizedInput, context));
  const type = proposedType(normalizedInput, context);
  if (isAiResultText(normalizedInput) && !hasExplicitRemember) {
    return { remember: false, confidence: 0.94, reason: 'ai_result_text_not_memory', proposedType: type, needsConfirmation: false };
  }
  const isBusinessAmount = hasAmount && ['expense', 'income', 'quote'].includes(type);
  const worthRemembering = hasExplicitRemember
    || isBusinessAmount
    || hasTime
    || ['customer_fact', 'project_fact', 'quote', 'preference', 'todo', 'reminder'].includes(type);

  return {
    remember: worthRemembering,
    confidence: worthRemembering ? 0.84 : 0.52,
    reason: worthRemembering ? 'matches_memory_policy' : 'no_durable_signal',
    proposedType: type,
    needsConfirmation: false
  };
}
