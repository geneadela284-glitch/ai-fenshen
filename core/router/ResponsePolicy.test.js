import test from 'node:test';
import assert from 'node:assert/strict';

import { applyResponsePolicy } from './ResponsePolicy.js';

test('Response Policy 将企业工作秘书身份统一为 AI分身', () => {
  assert.equal(
    applyResponsePolicy('我是企业工作秘书，可以帮你安排今天。'),
    '我是AI分身，可以帮你安排今天。'
  );
});

test('Response Policy 将 AI Work Center 工作秘书身份统一为 AI分身', () => {
  assert.equal(
    applyResponsePolicy('我是 AI Work Center 工作秘书，可以帮你记录生活开支。'),
    '我是AI分身，可以帮你记录生活开支。'
  );
});

test('Response Policy 移除模型自报身份', () => {
  assert.equal(
    applyResponsePolicy('我是DeepSeek模型，可以帮你总结。'),
    '可以帮你总结。'
  );
  assert.equal(
    applyResponsePolicy('我是某某模型，可以帮你分析。'),
    '可以帮你分析。'
  );
});

test('Response Policy 不透出 Provider 自报身份', () => {
  assert.equal(
    applyResponsePolicy('我是 DeepSeek，可以帮你安排今天。'),
    '我是AI分身，可以帮你安排今天。'
  );
});

test('Response Policy 移除语言模型自报身份', () => {
  assert.equal(
    applyResponsePolicy('我是一个语言模型，可以回答问题。'),
    '可以回答问题。'
  );
});

test('程序可信结果仍优先，但同样遵守统一身份', () => {
  assert.equal(
    applyResponsePolicy('模型自由表达', { programResult: '我是语言模型，今天支出 20 元。' }),
    '今天支出 20 元。'
  );
});
