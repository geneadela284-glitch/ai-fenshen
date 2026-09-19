import assert from 'node:assert/strict';
import { AIRouter } from './AIRouter.js';
import { allowingAccessControl } from './testing/allowingAccessControl.js';
import { CAPABILITIES } from './CapabilityMap.js';

function createProviders({ deepseekFails = false } = {}) {
  const calls = [];
  const providerImpl = (id) => ({
    async generate(request = {}) {
      calls.push({ id, method: 'generate', request });
      if (id === 'deepseek' && deepseekFails) throw new Error('deepseek timeout');
      return { provider: id, model: request.options?.model, content: `ok:${id}`, usage: { total_tokens: 10 } };
    },
    async chat(request = {}) {
      calls.push({ id, method: 'chat', request });
      if (id === 'deepseek' && deepseekFails) throw new Error('deepseek timeout');
      return { provider: id, model: request.options?.model, content: `ok:${id}`, usage: { total_tokens: 10 } };
    }
  });
  const impls = {
    deepseek: providerImpl('deepseek'),
    qwen: providerImpl('qwen')
  };
  return {
    calls,
    async generate(request = {}) {
      return impls[request.provider].generate(request);
    },
    async chat(request = {}) {
      return impls[request.provider].chat(request);
    }
  };
}

function createSettings() {
  return {
    load() {
      return {
        provider: 'deepseek',
        router: {
          routes: {
            WRITE: { providerId: 'deepseek', model: 'deepseek-chat' },
            OCR: { providerId: 'qwen', model: 'qwen3.5-ocr' }
          }
        },
        providers: {
          deepseek: {
            id: 'deepseek',
            name: 'DeepSeek',
            enabled: true,
            apiKey: 'local',
            baseUrl: 'https://api.deepseek.com',
            defaultModel: 'deepseek-chat',
            status: '可用',
            healthy: true,
            fallbackProviders: ['qwen']
          },
          qwen: {
            id: 'qwen',
            name: '通义千问',
            enabled: true,
            apiKey: 'local-qwen',
            baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
            defaultModel: 'qwen-plus',
            modelOptions: [
              { value: 'qwen-plus' },
              { value: 'qwen3.5-ocr' }
            ],
            status: '可用',
            healthy: true,
            fallbackProviders: ['deepseek']
          }
        }
      };
    }
  };
}

const providers = createProviders();
const router = new AIRouter({ providers, settings: createSettings(), accessControl: allowingAccessControl });

const write = await router.run({ capability: CAPABILITIES.WRITE, input: '写一篇产品介绍', method: 'generate' });
assert.equal(write.capability, 'WRITE');
assert.equal(write.selectedProvider, 'deepseek');
assert.equal(write.selectedModel, 'deepseek-chat');
assert.equal(write.error, null);
assert.equal(providers.calls.at(-1).request.provider, 'deepseek');

const ocr = await router.run({ capability: CAPABILITIES.OCR, input: '识别图片文字', method: 'chat' });
assert.equal(ocr.capability, 'OCR');
assert.equal(ocr.selectedProvider, 'qwen');
assert.equal(ocr.selectedModel, 'qwen3.5-ocr');

const classifierRoute = await router.run({ input: '请总结这份会议记录', method: 'chat' });
assert.equal(classifierRoute.capability, 'MEETING_SUMMARY');
assert.equal(classifierRoute.selectedProvider, 'deepseek');
assert.equal(classifierRoute.selectedModel, 'deepseek-chat');

const fallbackProviders = createProviders({ deepseekFails: true });
const fallback = await new AIRouter({
  providers: fallbackProviders,
  settings: createSettings(),
  accessControl: allowingAccessControl
}).run({ capability: 'WRITE', input: '写介绍', method: 'chat' });
assert.equal(fallback.selectedProvider, 'qwen');
assert.equal(fallback.fallbackUsed, true);
assert.equal(fallback.error, null);

const mockOnly = await router.run({ input: '测试', metadata: { mockOnly: true }, capability: 'CHAT' });
assert.equal(mockOnly.mocked, true);
assert.equal(mockOnly.selectedProvider, 'deepseek');

console.log('AI Router tests PASS');
