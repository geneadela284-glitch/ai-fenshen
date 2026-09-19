import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationService } from './conversationService.js';

async function policy() {
  try {
    return await import('./productPolicy.js');
  } catch {
    return null;
  }
}

test('AI分身 product policy fixes public identity and hides model internals', async () => {
  const subject = await policy();
  assert.equal(typeof subject?.buildAIFenshenMessages, 'function');
  const messages = subject.buildAIFenshenMessages([{ role: 'user', content: '你是谁？' }]);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /对外身份永远是“AI分身”/);
  assert.match(messages[0].content, /底层能力会根据任务自动调度/);
  assert.match(messages[0].content, /年份未知时不得补充或猜测年份/);
  assert.match(messages[0].content, /背景长期事实.*静默/);
  assert.match(messages[0].content, /不得声称.*记住/);
  assert.match(messages[0].content, /不得声称.*已保存.*已写入/);
  for (const forbidden of ['DeepSeek', 'Provider', '模型版本', '知识截止日期', 'Token']) {
    assert.match(messages[0].content, new RegExp(`不得.*${forbidden}|不.*${forbidden}`));
  }
});

test('AI分身 capability whitelist distinguishes available and planned features', async () => {
  const subject = await policy();
  assert.deepEqual(subject?.AI_FENSHEN_AVAILABLE_CAPABILITIES, [
    '真实文字对话', '流式回复', '停止生成', '当前对话保存', '刷新恢复', '新建对话',
    '经用户授权的长期记忆', '确定性个人记账与收支查询', '整理、分析、撰写和规划文本内容'
  ]);
  const prompt = subject.buildAIFenshenMessages([{ role: 'user', content: '你能为我做什么？' }])[0].content;
  assert.match(prompt, /经用户授权的长期记忆/);
  assert.match(prompt, /确定性个人记账与收支查询/);
  for (const planned of ['文件上传', '图片识别', '语音识别', '真实人脸识别', '日程自动执行', '健康管理', '完整对话历史界面', '正式设置中心']) {
    assert.match(prompt, new RegExp(planned));
  }
  assert.match(prompt, /最多5项/);
  assert.match(prompt, /150.*250/);
  assert.match(prompt, /不得声称.*完全免费/);
  assert.match(prompt, /不得声称.*官方.*App/);
});

test('ConversationService injects the trusted product system prompt server-side', async () => {
  const calls = [];
  const messages = {
    listForConversationOwner: () => [
      { id: 'u1', role: 'user', content: '你是谁？' },
      { id: 'a1', role: 'assistant', content: '旧回答' },
      { id: 'a2', role: 'assistant', content: '' }
    ],
    completeAssistantMessage: () => true,
    stopAssistantMessage: () => true,
    failAssistantMessage: () => true
  };
  const service = new ConversationService({
    conversations: { touchForOwner: () => true },
    messages,
    registry: { settle: () => true },
    aiService: {
      async stream(task, { onDelta }) {
        calls.push(task);
        await onDelta('我是你的AI分身。');
        return { ok: true, content: '我是你的AI分身。' };
      }
    }
  });
  await service.execute({
    deduplicated: false,
    controller: new AbortController(),
    ownerId: 'owner-a',
    assistantMessage: { id: 'a2' },
    conversation: { id: 'conversation-a' },
    userMessage: { id: 'u1', content: '你是谁？' },
    requestId: 'request-a'
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].messages[0].role, 'system');
  assert.match(calls[0].messages[0].content, /AI分身/);
  assert.equal(calls[0].metadata.memoryPolicy, 'disabled');
});

test('both chat channels send the authorized creator facts to the model for open-ended questions',async()=>{
 const {buildAIFenshenMessages}=await policy();
 const messages=buildAIFenshenMessages([{role:'user',content:'聊聊你的诞生过程吧。'}]);
 assert.match(messages[0].content,/我是由示例维护者创建的。/);
 assert.match(messages[0].content,/示例维护者，身份信息已脱敏。/);
 assert.match(messages[0].content,/本产品.*创造者/);
 assert.match(messages[0].content,/不得编造.*团队|不得.*编造.*开发经历/);
 assert.equal(messages[1].content,'聊聊你的诞生过程吧。');
});
