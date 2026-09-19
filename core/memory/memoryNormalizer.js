const chineseDigits = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
};

export function normalizeMemoryInput(input = '') {
  return String(input || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/今早|今晨/g, '今天上午')
    .replace(/今下午/g, '今天下午')
    .replace(/今晚|今夜/g, '今天晚上')
    .replace(/明早/g, '明天上午')
    .replace(/明晚/g, '明天晚上')
    .replace(/后天早上/g, '后天上午');
}

export function toDateParts(date = new Date()) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate()
  };
}

export function formatDate(date = new Date()) {
  const { year, month, day } = toDateParts(date);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function formatTime(hour = 0, minute = 0) {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function baseDateFromContext(context = {}) {
  const date = context.now ? new Date(context.now) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function parseChineseNumber(value = '') {
  const text = String(value || '').trim();
  if (!text) return NaN;
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text.includes('点')) {
    const [integer, decimal] = text.split('点');
    const integerValue = parseChineseNumber(integer);
    const decimalText = decimal.split('').map((char) => chineseDigits[char]).join('');
    return Number(`${integerValue}.${decimalText}`);
  }
  if (text === '十') return 10;
  if (text.includes('百')) {
    const [hundreds, rest = ''] = text.split('百');
    return (parseChineseNumber(hundreds) || 1) * 100 + (rest ? parseChineseNumber(rest) : 0);
  }
  if (text.includes('十')) {
    const [tens, ones = ''] = text.split('十');
    return (tens ? parseChineseNumber(tens) : 1) * 10 + (ones ? parseChineseNumber(ones) : 0);
  }
  if (text.length > 1) {
    const digits = text.split('').map((char) => chineseDigits[char]);
    if (digits.every((number) => Number.isInteger(number))) return Number(digits.join(''));
  }
  return chineseDigits[text] ?? NaN;
}

export function removeTrailingPunctuation(text = '') {
  return String(text || '').replace(/[，,。；;：:\s]+$/g, '').trim();
}
