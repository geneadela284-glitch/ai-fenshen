import test from 'node:test';
import assert from 'node:assert/strict';
import { getAssistantConversationText, getConversationText, isNearConversationBottom, shouldCollapseAssistantResponse, shouldRenderUserMessage } from './conversationDisplay.js';

test('keeps a user question visible and never collapsible', () => {
  const question = getConversationText({ userInput: '你是什么模型？' }, ['userInput']);

  assert.equal(question, '你是什么模型？');
  assert.equal(shouldRenderUserMessage(question), true);
  assert.equal(shouldCollapseAssistantResponse(question), false);
});

test('uses legacy assistant response fields without rendering object text', () => {
  assert.equal(getConversationText({ text: '这是旧记录的回答。' }), '这是旧记录的回答。');
  assert.equal(getConversationText({ result: { content: '从对象中读取正文。' } }), '从对象中读取正文。');
  assert.equal(getConversationText({ result: {} }), '');
});

test('normalizes legacy assistant identity before display, copy, or export', () => {
  assert.equal(
    getAssistantConversationText({ result: '我是 AI Work Center 的企业工作秘书，可以帮你安排今天。' }),
    '我是AI分身，可以帮你安排今天。'
  );
});

test('only shows expand controls when the assistant has a long real response', () => {
  assert.equal(shouldCollapseAssistantResponse('简短回答。'), false);
  assert.equal(shouldCollapseAssistantResponse('第一行\n第二行\n第三行\n第四行'), true);
  assert.equal(shouldCollapseAssistantResponse(''), false);
});

test('does not render empty user messages', () => {
  assert.equal(shouldRenderUserMessage(''), false);
  assert.equal(shouldRenderUserMessage('   '), false);
});

test('shows the return-to-latest action only when the reader has left the conversation bottom', () => {
  assert.equal(isNearConversationBottom({ scrollTop: 640, clientHeight: 300, scrollHeight: 980 }), true);
  assert.equal(isNearConversationBottom({ scrollTop: 120, clientHeight: 300, scrollHeight: 980 }), false);
});
