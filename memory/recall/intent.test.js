import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryRecallIntent, MemoryRecallIntentAnalyzer } from './index.js';
import { fakeRecallContext } from './testing/fixtures.js';

const SCENARIOS = [
  ['', MemoryRecallIntent.NO_MEMORY_NEEDED],
  ['你好', MemoryRecallIntent.NO_MEMORY_NEEDED],
  ['今天几号', MemoryRecallIntent.NO_MEMORY_NEEDED],
  ['今天天气怎么样', MemoryRecallIntent.NO_MEMORY_NEEDED],
  ['解释一下量子计算', MemoryRecallIntent.NO_MEMORY_NEEDED],
  ['帮我计算 2 加 2', MemoryRecallIntent.NO_MEMORY_NEEDED],
  ['按我的偏好推荐咖啡', MemoryRecallIntent.PERSONAL_PREFERENCE],
  ['我平时喜欢喝什么', MemoryRecallIntent.PERSONAL_PREFERENCE],
  ['我喜欢吃什么？', MemoryRecallIntent.PERSONAL_PREFERENCE],
  ['我不喜欢什么食物', MemoryRecallIntent.PERSONAL_PREFERENCE],
  ['我现在住在哪个城市', MemoryRecallIntent.PERSONAL_FACT],
  ['你记得我的名字吗', MemoryRecallIntent.PERSONAL_FACT],
  ['关于我的基本信息', MemoryRecallIntent.PERSONAL_FACT],
  ['我女儿的生日是什么时候', MemoryRecallIntent.RELATIONSHIP_CONTEXT],
  ['我妈妈生日是哪天？', MemoryRecallIntent.RELATIONSHIP_CONTEXT],
  ['我和那位同事是什么关系', MemoryRecallIntent.RELATIONSHIP_CONTEXT],
  ['我的长期目标是什么', MemoryRecallIntent.GOAL_CONTEXT],
  ['提醒我正在追求的目标', MemoryRecallIntent.GOAL_CONTEXT],
  ['我通常几点睡觉', MemoryRecallIntent.HABIT_OR_ROUTINE],
  ['我的作息习惯是什么', MemoryRecallIntent.HABIT_OR_ROUTINE],
  ['我之前做过什么决定', MemoryRecallIntent.PRIOR_DECISION],
  ['上次为什么决定搬家', MemoryRecallIntent.PRIOR_DECISION],
  ['我经历过哪些重要事件', MemoryRecallIntent.LIFE_EVENT_CONTEXT],
  ['我什么时候毕业的', MemoryRecallIntent.LIFE_EVENT_CONTEXT],
  ['我答应过要做什么', MemoryRecallIntent.COMMITMENT_OR_CONSTRAINT],
  ['我有什么饮食限制', MemoryRecallIntent.COMMITMENT_OR_CONSTRAINT],
  ['最近我在关注什么', MemoryRecallIntent.RECENT_CONTEXT],
  ['刚才的临时要求是什么', MemoryRecallIntent.RECENT_CONTEXT],
  ['我以前住在哪里', MemoryRecallIntent.HISTORICAL_CONTEXT],
  ['回顾过去的城市记录', MemoryRecallIntent.HISTORICAL_CONTEXT],
  ['我的健康记录是什么', MemoryRecallIntent.SENSITIVE_CONTEXT],
  ['我的详细家庭地址是什么', MemoryRecallIntent.SENSITIVE_CONTEXT],
  ['你还记得那件事吗', MemoryRecallIntent.AMBIGUOUS],
  ['以前那个是什么', MemoryRecallIntent.AMBIGUOUS]
];

for (const [request, intent] of SCENARIOS) {
  test(`Recall intent: ${request || '<empty>'} -> ${intent}`, async () => {
    const result = await new MemoryRecallIntentAnalyzer().analyze(fakeRecallContext(), { text: request });
    assert.equal(result.intent, intent);
    assert.match(result.reasonCode, /^RECALL_/);
  });
}

test('ambiguous recall asks one concise clarification question', async () => {
  const result = await new MemoryRecallIntentAnalyzer().analyze(fakeRecallContext(), { text: '你还记得那件事吗' });
  assert.equal(result.needsClarification, true);
  assert.equal(typeof result.clarificationQuestion, 'string');
  assert.equal(Array.isArray(result.clarificationQuestions), false);
});

test('caller-provided memory type does not override automatic intent', async () => {
  const result = await new MemoryRecallIntentAnalyzer().analyze(fakeRecallContext(), { text: '今天天气怎么样', memoryType: 'preference' });
  assert.equal(result.intent, MemoryRecallIntent.NO_MEMORY_NEEDED);
});
