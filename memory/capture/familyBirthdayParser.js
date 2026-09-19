const RELATIONSHIPS = Object.freeze([
  { aliases: ['妈妈', '母亲', '妈'], relation: 'mother', personReference: '妈妈' },
  { aliases: ['爸爸', '父亲', '爸'], relation: 'father', personReference: '爸爸' },
  { aliases: ['老婆', '妻子'], relation: 'wife', personReference: '妻子' },
  { aliases: ['老公', '丈夫'], relation: 'husband', personReference: '丈夫' },
  { aliases: ['女儿'], relation: 'daughter', personReference: '女儿' },
  { aliases: ['儿子'], relation: 'son', personReference: '儿子' }
]);

const CALENDARS = Object.freeze({
  农历: { calendarType: 'lunar', label: '农历' },
  阴历: { calendarType: 'lunar', label: '农历' },
  公历: { calendarType: 'solar', label: '公历' },
  阳历: { calendarType: 'solar', label: '公历' }
});

const UNCERTAIN = /(?:好像|可能|大概|也许|似乎|不确定|记不清|没记错的话)/;
const DATE = /(?:(?<year>\d{4}|[〇零一二三四五六七八九]{4})年)?(?<month>\d{1,2}|正|冬|腊|十二|十一|十|[一二三四五六七八九])月(?<day>\d{1,2}|初[一二三四五六七八九十]|十[一二三四五六七八九]?|二十[一二三四五六七八九]?|廿[一二三四五六七八九]?|三十|卅|[一二三四五六七八九])(?:日|号)?/;
const DIGITS = Object.freeze({ 零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 });
const SMALL_NUMBERS = Object.freeze(['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十', '二十一', '二十二', '二十三', '二十四', '二十五', '二十六', '二十七', '二十八', '二十九', '三十', '三十一']);

function compact(value) {
  return String(value ?? '').trim().replace(/\s+/g, '').replace(/[。！!，,；;]$/, '');
}
function chineseNumber(value) {
  const text = String(value);
  if (/^\d+$/.test(text)) return Number(text);
  if (text === '正') return 1;
  if (text === '冬') return 11;
  if (text === '腊') return 12;
  if (text.startsWith('初')) return chineseNumber(text.slice(1));
  if (text === '卅') return 30;
  if (text.startsWith('廿')) return 20 + chineseNumber(text.slice(1) || '零');
  if (text.startsWith('二十')) return 20 + chineseNumber(text.slice(2) || '零');
  if (text.startsWith('十')) return 10 + chineseNumber(text.slice(1) || '零');
  return DIGITS[text] ?? Number.NaN;
}

function yearNumber(value) {
  if (!value) return null;
  if (/^\d{4}$/.test(value)) return Number(value);
  const digits = [...value].map((character) => DIGITS[character]);
  return digits.some((digit) => digit === undefined) ? Number.NaN : Number(digits.join(''));
}

function validDate({ calendarType, year, month, day }) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > (calendarType === 'lunar' ? 30 : 31)) return false;
  if (!year || calendarType === 'lunar') return true;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function displayDate({ calendarType, calendarLabel, year, month, day }) {
  const monthText = SMALL_NUMBERS[month];
  const dayText = calendarType === 'lunar' && day <= 10
    ? `初${SMALL_NUMBERS[day]}`
    : SMALL_NUMBERS[day];
  return `${calendarLabel}${year ? `${year}年` : ''}${monthText}月${dayText}日`;
}

function relationshipAtStart(text) {
  if (!text.startsWith('我')) return null;
  const rest = text.slice(1);
  for (const relationship of RELATIONSHIPS) {
    const alias = relationship.aliases.find((candidate) => rest.startsWith(candidate));
    if (alias) return { ...relationship, alias, rest: rest.slice(alias.length) };
  }
  return null;
}

export function parseFamilyBirthdayStatement(input) {
  const text = compact(input);
  const person = relationshipAtStart(text);
  if (!person || (!person.rest.includes('生日') && !person.rest.includes('出生'))) return null;

  const dateMatch = person.rest.match(DATE);
  if (!dateMatch?.groups) return null;
  const calendarToken = Object.keys(CALENDARS).find((token) => person.rest.includes(token)) || null;
  const calendar = calendarToken ? CALENDARS[calendarToken] : { calendarType: null, label: '' };
  const year = yearNumber(dateMatch.groups.year);
  const month = chineseNumber(dateMatch.groups.month);
  const day = chineseNumber(dateMatch.groups.day);
  if (!validDate({ calendarType: calendar.calendarType, year, month, day })) return null;

  const residue = person.rest
    .replace(dateMatch[0], '')
    .replace(calendarToken || '', '')
    .replace('生日', '')
    .replace(/出生日期|出生/g, '')
    .replace(UNCERTAIN, '')
    .replace(/[的是在于]/g, '');
  if (residue) return null;

  const normalizedDate = displayDate({
    calendarType: calendar.calendarType,
    calendarLabel: calendar.label,
    year,
    month,
    day
  });
  return Object.freeze({
    content: `我${person.personReference}的生日是${normalizedDate}`,
    uncertain: UNCERTAIN.test(text),
    semantic: Object.freeze({
      kind: 'family_birthday',
      factType: 'birthday',
      relation: person.relation,
      relationship: person.relation,
      personReference: person.personReference,
      calendarType: calendar.calendarType,
      year,
      month,
      day
    })
  });
}
