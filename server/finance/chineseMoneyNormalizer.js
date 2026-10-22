const DIGITS = Object.freeze({
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9
});

const SMALL_UNITS = Object.freeze({ 十: 10, 百: 100, 千: 1_000 });
const LARGE_UNITS = Object.freeze({ 万: 10_000, 亿: 100_000_000 });
const MONEY_SUFFIX = /(?:人民币|块钱|元钱|块|元)$/u;
const MONEY_PREFIX = /^人民币/u;
const CHINESE_NUMBER = /^[零〇一二两三四五六七八九十百千万亿]+$/u;
const ARABIC_NUMBER = /^(\d+(?:\.\d+)?)\s*(十|百|千|万|亿)?$/u;

function decimalToMinor(value, multiplier = 1) {
  const match = String(value).match(/^(\d+)(?:\.(\d+))?$/u);
  if (!match) return null;
  const fraction = (match[2] || '').slice(0, 8);
  const scale = 10 ** fraction.length;
  const numerator = BigInt(match[1]) * BigInt(scale) + BigInt(fraction || '0');
  const scaled = numerator * BigInt(multiplier) * 100n;
  const minor = scaled / BigInt(scale);
  const remainder = scaled % BigInt(scale);
  // Money values with more than two decimal places are not silently rounded.
  if (remainder !== 0n && fraction.length > 2) return null;
  return minor >= 0n && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

function hasOralShorthandAmbiguity(value) {
  // “三千五”/“一万二” have no frozen product rule.  Keep two-digit forms such
  // as “二十五” deterministic, while requiring confirmation after a large unit.
  return /[百千万亿][零〇一二两三四五六七八九]$/u.test(value);
}

function parseChineseInteger(value) {
  if (!CHINESE_NUMBER.test(value) || hasOralShorthandAmbiguity(value)) {
    return { status: 'ambiguous', amount: null };
  }
  let total = 0;
  let section = 0;
  let digit = 0;
  let hasDigit = false;
  for (const char of value) {
    if (Object.hasOwn(DIGITS, char)) {
      digit = DIGITS[char];
      hasDigit = true;
      continue;
    }
    if (Object.hasOwn(SMALL_UNITS, char)) {
      const unit = SMALL_UNITS[char];
      section += (hasDigit ? digit : 1) * unit;
      digit = 0;
      hasDigit = false;
      continue;
    }
    if (Object.hasOwn(LARGE_UNITS, char)) {
      section += hasDigit ? digit : 0;
      const unit = LARGE_UNITS[char];
      total += (section || 1) * unit;
      section = 0;
      digit = 0;
      hasDigit = false;
    }
  }
  const amount = total + section + (hasDigit ? digit : 0);
  return amount > 0 ? { status: 'resolved', amount } : { status: 'resolved', amount: 0 };
}

function normalizeRaw(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/[\s,，]/gu, '')
    .replace(MONEY_PREFIX, '')
    .replace(MONEY_SUFFIX, '');
}

export function normalizeChineseMoney(raw) {
  const source = String(raw ?? '');
  const value = normalizeRaw(source);
  if (!value) return { status: 'absent', raw: source, amount: null, amountMinor: null, currency: 'CNY' };
  if (/^[-+负]/u.test(value)) {
    return { status: 'invalid', raw: source, amount: null, amountMinor: null, currency: 'CNY' };
  }

  const arabic = value.match(ARABIC_NUMBER);
  if (arabic) {
    const unit = arabic[2];
    const multiplier = unit ? (SMALL_UNITS[unit] || LARGE_UNITS[unit]) : 1;
    const amountMinor = decimalToMinor(arabic[1], multiplier);
    if (amountMinor === null) return { status: 'invalid', raw: source, amount: null, amountMinor: null, currency: 'CNY' };
    return { status: 'resolved', raw: source, amount: amountMinor / 100, amountMinor, currency: 'CNY' };
  }

  const chineseDecimal = value.match(/^([零〇一二两三四五六七八九十百千万亿]+)点([零〇一二两三四五六七八九]{1,2})$/u);
  if (chineseDecimal) {
    const integer = parseChineseInteger(chineseDecimal[1]);
    const cents = chineseDecimal[2].split('').map(char => DIGITS[char]).join('').padEnd(2, '0');
    const amountMinor = integer.amount * 100 + Number(cents);
    if (integer.status === 'resolved' && Number.isSafeInteger(amountMinor)) return {status:'resolved',raw:source,amount:amountMinor/100,amountMinor,currency:'CNY'};
  }

  if (!CHINESE_NUMBER.test(value)) {
    return { status: 'invalid', raw: source, amount: null, amountMinor: null, currency: 'CNY' };
  }
  const parsed = parseChineseInteger(value);
  if (parsed.status !== 'resolved') {
    return { status: parsed.status, raw: source, amount: null, amountMinor: null, currency: 'CNY' };
  }
  const amountMinor = parsed.amount * 100;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    return { status: 'invalid', raw: source, amount: null, amountMinor: null, currency: 'CNY' };
  }
  return { status: 'resolved', raw: source, amount: parsed.amount, amountMinor, currency: 'CNY' };
}

export function isMoneyToken(value) {
  const normalized = normalizeRaw(value);
  return Boolean(normalized) && (ARABIC_NUMBER.test(normalized) || CHINESE_NUMBER.test(normalized));
}

export class ChineseMoneyNormalizer {
  normalize(raw) {
    return normalizeChineseMoney(raw);
  }

  static normalize(raw) {
    return normalizeChineseMoney(raw);
  }
}

export default ChineseMoneyNormalizer;
