import { MemorySensitivity } from '../kernel/index.js';
import { CaptureIntent, ConfirmationDecision } from './contracts.js';
import { parseFamilyBirthdayStatement } from './familyBirthdayParser.js';

const PROHIBITED = Object.freeze([
  ['password', /(?:密码|password|passcode)/i],
  ['api_key', /api[\s_-]*key/i],
  ['cookie', /cookie/i],
  ['session_token', /session[\s_-]*token/i],
  ['access_token', /access[\s_-]*token/i],
  ['refresh_token', /refresh[\s_-]*token/i],
  ['private_key', /(?:私钥|private[\s_-]*key)/i],
  ['recovery_code', /(?:恢复码|recovery[\s_-]*code)/i],
  ['full_bank_card', /(?:完整)?(?:银行卡号|银行卡|卡号).{0,16}\d(?:[\s-]?\d){11,18}/i],
  ['full_identity_number', /(?:完整)?(?:身份证件号码|身份证号码|身份证号|证件号码).{0,16}\d{15,17}[\dXx]/i]
]);

const HIGH_SENSITIVITY = Object.freeze([
  ['health', /(?:过敏|健康|病历|诊断|疾病|用药|体检|手术)/],
  ['finance', /(?:收入|工资|财务|资产|负债|存款|投资|欠款)/],
  ['family_relationship', /(?:女儿|儿子|父亲|母亲|爸爸|妈妈|妻子|丈夫|家庭关系)/],
  ['precise_address', /(?:家庭住址|住址|详细地址|家庭地址).{0,60}(?:号|室|栋|单元)/],
  ['precise_location', /(?:长期住在|精确位置|测试坐标|经度|纬度).{0,60}(?:\d|号)/],
  ['private_relationship', /(?:私密关系|亲密关系|婚外关系)/]
]);

export class SensitivePolicy {
  evaluate(input) {
    const text = String(input ?? '');
    const prohibitedCategories = PROHIBITED.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
    if (prohibitedCategories.length) {
      return { sensitivity: MemorySensitivity.RESTRICTED, prohibited: true, categories: prohibitedCategories };
    }
    const lowRiskFamilyBirthday = Boolean(parseFamilyBirthdayStatement(text));
    const categories = HIGH_SENSITIVITY
      .filter(([category, pattern]) => pattern.test(text) && !(category === 'family_relationship' && lowRiskFamilyBirthday))
      .map(([category]) => category);
    return {
      sensitivity: categories.length ? MemorySensitivity.HIGH : MemorySensitivity.LOW,
      prohibited: false,
      categories
    };
  }
}

export class MemoryCapturePolicy {
  evaluate(analysis) {
    if (analysis.intent === CaptureIntent.NOT_MEMORY) return 'reject';
    if (analysis.intent === CaptureIntent.CONTEXT_ONLY) return 'context_only';
    if (analysis.intent === CaptureIntent.FORGET) return 'forget';
    return 'candidate';
  }
}

export class ConfirmationPolicy {
  evaluate({ explicit, directSaveAuthorized = false, sensitivity, prohibited }) {
    if (prohibited || sensitivity === MemorySensitivity.RESTRICTED) return ConfirmationDecision.REJECTED;
    if (sensitivity === MemorySensitivity.HIGH) return ConfirmationDecision.REQUIRED;
    return explicit || directSaveAuthorized ? ConfirmationDecision.AUTHORIZED : ConfirmationDecision.REQUIRED;
  }
}
