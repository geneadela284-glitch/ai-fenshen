import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CaptureIntent,
  CaptureReasonCode,
  MemoryIntentAnalyzer
} from './index.js';

const analyzer = new MemoryIntentAnalyzer();

test('Capture intent and reason enums are frozen', () => {
  assert.ok(Object.isFrozen(CaptureIntent));
  assert.ok(Object.isFrozen(CaptureReasonCode));
});

for (const text of ['', '你好', '谢谢', '今天天气怎么样？', '帮我翻译这句话']) {
  test(`non-memory input is rejected deterministically: ${text || '<empty>'}`, () => {
    const result = analyzer.analyze(text);
    assert.equal(result.intent, CaptureIntent.NOT_MEMORY);
    assert.equal(result.reasonCode, CaptureReasonCode.NOT_MEMORY);
  });
}

test('an explicit opt-out never becomes a memory instruction', () => {
  const result = analyzer.analyze('不要记住我今天说的话');
  assert.equal(result.intent, CaptureIntent.NOT_MEMORY);
  assert.equal(result.reasonCode, CaptureReasonCode.USER_OPTED_OUT);
});

for (const text of ['忘掉这条记忆', '忘记我之前的城市', '删除这条记忆', '不要再记得这个偏好']) {
  test(`forget wording becomes an explicit forget intent: ${text}`, () => {
    const result = analyzer.analyze(text);
    assert.equal(result.intent, CaptureIntent.FORGET);
    assert.equal(result.reasonCode, CaptureReasonCode.FORGET_INTENT);
  });
}

for (const text of ['这次请用简短回答', '当前任务先不要生成表格', '暂时称呼我为小王']) {
  test(`temporary wording becomes context only: ${text}`, () => {
    const result = analyzer.analyze(text);
    assert.equal(result.intent, CaptureIntent.CONTEXT_ONLY);
    assert.equal(result.reasonCode, CaptureReasonCode.CONTEXT_ONLY);
  });
}

for (const text of ['我喜欢喝乌龙茶', '我不吃香菜', '我的偏好是简短回答']) {
  test(`durable preference becomes an authorized high-value intent: ${text}`, () => {
    const result = analyzer.analyze(text);
    assert.equal(result.intent, CaptureIntent.LONG_TERM_MEMORY);
    assert.equal(result.memoryType, 'preference');
    assert.equal(result.reasonCode, CaptureReasonCode.PROACTIVE_HIGH_VALUE_SIGNAL);
    assert.equal(result.directSaveAuthorized, true);
    assert.equal(result.userExplicitStatement, true);
  });
}

for (const [text, expected] of [
  ['我妈是阴历7月16生日', { relation: 'mother', calendarType: 'lunar', year: null, month: 7, day: 16, content: '我妈妈的生日是农历七月十六日' }],
  ['我妈妈阴历七月十六生日', { relation: 'mother', calendarType: 'lunar', year: null, month: 7, day: 16, content: '我妈妈的生日是农历七月十六日' }],
  ['我妈生日是农历七月十六', { relation: 'mother', calendarType: 'lunar', year: null, month: 7, day: 16, content: '我妈妈的生日是农历七月十六日' }],
  ['我母亲的生日是阴历7月16', { relation: 'mother', calendarType: 'lunar', year: null, month: 7, day: 16, content: '我妈妈的生日是农历七月十六日' }],
  ['我爸阳历3月8号生日', { relation: 'father', calendarType: 'solar', year: null, month: 3, day: 8, content: '我爸爸的生日是公历三月八日' }],
  ['我老婆生日是农历八月初五', { relation: 'wife', calendarType: 'lunar', year: null, month: 8, day: 5, content: '我妻子的生日是农历八月初五日' }],
  ['我儿子生日是2020年5月1日', { relation: 'son', calendarType: null, year: 2020, month: 5, day: 1, content: '我儿子的生日是2020年五月一日' }]
]) {
  test(`natural family birthday is semantically normalized: ${text}`, () => {
    const result = analyzer.analyze(text);
    const { content, ...semantic } = expected;
    assert.equal(result.intent, CaptureIntent.LONG_TERM_MEMORY);
    assert.equal(result.memoryType, 'relationship');
    assert.equal(result.reasonCode, CaptureReasonCode.PROACTIVE_HIGH_VALUE_SIGNAL);
    assert.equal(result.directSaveAuthorized, true);
    assert.equal(result.content, content);
    assert.deepEqual(result.semantic, {
      kind: 'family_birthday',
      factType: 'birthday',
      relationship: semantic.relation,
      personReference: content.match(/^我(.+?)的生日/)?.[1],
      ...semantic
    });
  });
}

test('natural birthday parsing does not mutate the user input value', () => {
  const input = ' 我妈是阴历7月16生日。 ';
  analyzer.analyze(input);
  assert.equal(input, ' 我妈是阴历7月16生日。 ');
});

test('uncertain family birthday is never directly authorized', () => {
  const result = analyzer.analyze('我妈生日好像是农历七月十六');
  assert.equal(result.intent, CaptureIntent.LONG_TERM_MEMORY);
  assert.equal(result.reasonCode, CaptureReasonCode.UNCERTAIN_USER_STATEMENT);
  assert.equal(result.directSaveAuthorized, false);
  assert.equal(result.uncertain, true);
});

for (const text of ['我记得可能是七月十六', '大概七月十六']) {
  test(`uncertain date fragment is not directly saved: ${text}`, () => {
    const result = analyzer.analyze(text);
    assert.equal(result.directSaveAuthorized, false);
  });
}

test('a recent temporary condition is not a durable memory', () => {
  const result = analyzer.analyze('我最近有点累');
  assert.notEqual(result.intent, CaptureIntent.LONG_TERM_MEMORY);
  assert.equal(result.directSaveAuthorized, false);
});

for (const [text, expectedType] of [
  ['我的长期目标是跑完马拉松', 'goal'],
  ['我每天七点起床', 'habit_routine'],
  ['我不能吃花生', 'constraint'],
  ['我们的结婚纪念日是5月8日', 'life_event'],
  ['小王是我的朋友', 'relationship']
]) {
  test(`other clear high-value facts are directly authorized: ${text}`, () => {
    const result = analyzer.analyze(text);
    assert.equal(result.intent, CaptureIntent.LONG_TERM_MEMORY);
    assert.equal(result.memoryType, expectedType);
    assert.equal(result.directSaveAuthorized, true);
  });
}

for (const text of ['记住我喜欢喝乌龙茶', '以后记得我不吃香菜', '请保存我的常住城市是深圳', '帮我保存我喜欢吃辣']) {
  test(`explicit remember wording enters the formal flow: ${text}`, () => {
    const result = analyzer.analyze(text);
    assert.equal(result.intent, CaptureIntent.EXPLICIT_REMEMBER);
    assert.equal(result.reasonCode, CaptureReasonCode.EXPLICIT_REMEMBER);
    assert.ok(result.content.length > 0);
  });
}

test('an empty remember directive is not a valid memory', () => {
  const result = analyzer.analyze('记住');
  assert.equal(result.intent, CaptureIntent.NOT_MEMORY);
  assert.equal(result.reasonCode, CaptureReasonCode.INVALID_INPUT);
});
