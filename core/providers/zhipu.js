import { createOpenAICompatibleProvider } from './providerFactory.js';

export default createOpenAICompatibleProvider({
  id: 'zhipu',
  name: '智谱 AI',
  type: 'cloud',
  region: 'cn',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  model: 'glm-4.5'
});
