import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PromptBuilder } from './PromptBuilder.js';

test('injects trusted application time and session context into the system message', () => {
  const builder = new PromptBuilder({ now: () => new Date('2026-07-14T09:30:00+08:00') });
  const result = builder.build({
    messages: [
      { role: 'system', content: '你是 AI秘书。' },
      { role: 'user', content: '帮我安排今天的工作' }
    ],
    metadata: {
      currentTime: '2026-07-14T09:30:00+08:00',
      timeZone: 'Asia/Shanghai',
      pageContext: 'home',
      conversationId: 'conversation-1'
    }
  }, { capability: 'CHAT', model: 'deepseek-chat' });

  assert.match(result.messages[0].content, /2026年7月14日/);
  assert.match(result.messages[0].content, /Asia\/Shanghai/);
  assert.match(result.messages[0].content, /home/);
  assert.match(result.messages[0].content, /conversation-1/);
  assert.match(result.messages[0].content, /应用提供的日期、时间和程序计算结果是可信事实/);
});
