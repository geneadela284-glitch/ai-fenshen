import { createOpenAICompatibleProvider } from './providerFactory.js';

export default createOpenAICompatibleProvider({
  id: 'qwen',
  name: '通义千问',
  type: 'cloud',
  region: 'cn',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-plus',
  nativeVoiceStreaming: true
});
