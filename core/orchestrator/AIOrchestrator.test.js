import assert from 'node:assert/strict';
import { AIOrchestrator } from './AIOrchestrator.js';
import { TaskRouter } from './TaskRouter.js';

function createProvider({ id, shouldFail = false, model = `${id}-model` }) {
  return {
    id,
    name: id,
    type: 'cloud',
    status: 'test',
    region: 'cn',
    async generate(request = {}) {
      if (shouldFail) throw new Error(`${id} unavailable`);
      return {
        provider: id,
        mode: 'generate',
        model,
        content: `ok:${id}:${request.input || request.prompt || ''}`,
        usage: { inputTokens: 12, outputTokens: 8 },
        mocked: true
      };
    },
    async chat(request = {}) {
      if (shouldFail) throw new Error(`${id} unavailable`);
      return {
        provider: id,
        mode: 'chat',
        model,
        content: `ok:${id}:${request.input || request.prompt || ''}`,
        usage: { inputTokens: 12, outputTokens: 8 },
        mocked: true
      };
    }
  };
}

function createProviders({ qwenFails = false, qwenMissing = false, deepseekFails = false, kimiFails = false } = {}) {
  const providers = new Map([
    ['deepseek', createProvider({ id: 'deepseek', shouldFail: deepseekFails, model: 'deepseek-chat' })],
    ['kimi', createProvider({ id: 'kimi', shouldFail: kimiFails, model: 'moonshot-v1-32k' })]
  ]);

  if (!qwenMissing) {
    providers.set('qwen', createProvider({ id: 'qwen', shouldFail: qwenFails, model: 'qwen-plus' }));
  }

  return {
    activeProvider: 'deepseek',
    defaultProvider: 'deepseek',
    settings: { model: 'deepseek-chat' },
    providerConfigs: {
      deepseek: {
        id: 'deepseek',
        enabled: true,
        apiKey: 'local',
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
        reasoningModel: 'deepseek-reasoner',
        priority: 1,
        status: '可用',
        healthy: true,
        tags: ['Writing', 'Reasoning', 'Table Analysis', 'Tool Call'],
        reasoningSupported: true,
        toolCallSupported: true,
        fallbackProviders: ['qwen', 'kimi']
      },
      ...(!qwenMissing ? {
        qwen: {
          id: 'qwen',
          enabled: true,
          apiKey: 'local',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          defaultModel: 'qwen-plus',
          priority: 2,
          status: '可用',
          healthy: true,
          tags: ['Writing', 'Reasoning', 'Presentation', 'Vision', 'Tool Call'],
          reasoningSupported: true,
          visionSupported: true,
          toolCallSupported: true,
          fallbackProviders: ['deepseek', 'kimi']
        }
      } : {}),
      kimi: {
        id: 'kimi',
        enabled: true,
        apiKey: 'local',
        baseUrl: 'https://api.moonshot.cn/v1',
        defaultModel: 'moonshot-v1-32k',
        priority: 3,
        status: '可用',
        healthy: true,
        tags: ['Long Context', 'Knowledge', 'Writing'],
        maxContext: 128000,
        fallbackProviders: ['deepseek']
      }
    },
    getConfig() {
      return {
        activeProvider: this.activeProvider,
        defaultProvider: this.defaultProvider,
        settings: this.settings,
        providerConfigs: this.providerConfigs,
        costStrategy: 'Balanced'
      };
    },
    getProvider(id) {
      const provider = providers.get(id);
      if (!provider) throw new Error(`Provider not found: ${id}`);
      return provider;
    },
    async generate(request = {}) {
      return this.getProvider(request.provider).generate(request);
    },
    async chat(request = {}) {
      return this.getProvider(request.provider).chat(request);
    }
  };
}

const router = new TaskRouter();

const taskCases = [
  ['帮我写一篇产品介绍', 'writing'],
  ['分析这份方案有哪些风险', 'reasoning'],
  ['统计各门店销售额和单品排行', 'data_analysis'],
  ['生成一份季度汇报PPT大纲', 'presentation'],
  ['今天上海天气怎么样', 'general']
];

for (const [input, expected] of taskCases) {
  const route = router.route({ input });
  assert.equal(route.taskType, expected, `${input} should route to ${expected}`);
}

const orchestrator = new AIOrchestrator({ providers: createProviders() });

const writing = await orchestrator.generate({ input: '帮我写一篇产品介绍' });
assert.equal(writing.taskType, 'writing');
assert.equal(writing.selectedProvider, 'deepseek');
assert.equal(writing.selectedModel, 'deepseek-chat');
assert.equal(writing.fallbackUsed, false);
assert.equal(writing.error, null);
assert.ok(Number.isFinite(writing.latency));
assert.deepEqual(writing.usage, { inputTokens: 12, outputTokens: 8 });

const reasoning = await orchestrator.generate({ input: '分析这份方案有哪些风险' });
assert.equal(reasoning.taskType, 'reasoning');
assert.equal(reasoning.selectedProvider, 'deepseek');

const dataAnalysis = await orchestrator.generate({ input: '统计各门店销售额和单品排行' });
assert.equal(dataAnalysis.taskType, 'data_analysis');
assert.equal(dataAnalysis.selectedProvider, 'deepseek');

const presentation = await orchestrator.generate({ input: '生成一份季度汇报PPT大纲' });
assert.equal(presentation.taskType, 'presentation');
assert.equal(presentation.selectedProvider, 'qwen');

const presentationWithStoreKeyword = await orchestrator.generate({ input: '生成一份家具门店季度经营汇报PPT大纲' });
assert.equal(presentationWithStoreKeyword.taskType, 'presentation');

const general = await orchestrator.generate({ input: '普通问答' });
assert.equal(general.taskType, 'general');
assert.equal(general.selectedProvider, 'deepseek');

const fallback = await new AIOrchestrator({ providers: createProviders({ qwenFails: true }) }).generate({
  input: '生成一份季度汇报PPT大纲'
});
assert.equal(fallback.taskType, 'presentation');
assert.equal(fallback.selectedProvider, 'deepseek');
assert.equal(fallback.fallbackUsed, true);
assert.equal(fallback.error, null);

const qwenNotConfigured = await new AIOrchestrator({ providers: createProviders({ qwenMissing: true }) }).generate({
  input: '生成一份季度汇报PPT大纲'
});
assert.equal(qwenNotConfigured.taskType, 'presentation');
assert.equal(qwenNotConfigured.selectedProvider, 'deepseek');
assert.equal(qwenNotConfigured.fallbackUsed, false);
assert.equal(qwenNotConfigured.error, null);

const deepseekUnavailable = await new AIOrchestrator({
  providers: createProviders({ qwenFails: true, deepseekFails: true })
}).generate({ input: '生成一份季度汇报PPT大纲' });
assert.equal(deepseekUnavailable.taskType, 'presentation');
assert.equal(deepseekUnavailable.selectedProvider, 'kimi');
assert.equal(deepseekUnavailable.fallbackUsed, true);
assert.equal(deepseekUnavailable.error, null);

let providerCalls = 0;
const mockOnlyProviders = createProviders({ qwenFails: true, deepseekFails: true });
mockOnlyProviders.generate = async () => {
  providerCalls += 1;
  throw new Error('Provider should not be called in mock-only mode');
};
mockOnlyProviders.chat = async () => {
  providerCalls += 1;
  throw new Error('Provider should not be called in mock-only mode');
};

const mockOnly = await new AIOrchestrator({ providers: mockOnlyProviders }).generate({
  input: '帮我统计销售数据',
  metadata: { mockOnly: true, source: 'work-secretary' }
});
assert.equal(mockOnly.taskType, 'data_analysis');
assert.equal(mockOnly.error, null);
assert.equal(mockOnly.mocked, true);
assert.equal(providerCalls, 0);
assert.match(mockOnly.content, /销售数据/);

console.log('AI Orchestrator routing tests PASS');
