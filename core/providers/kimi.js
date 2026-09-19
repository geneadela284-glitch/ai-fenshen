import { createOpenAICompatibleProvider } from './providerFactory.js';

export default createOpenAICompatibleProvider({
  id: 'kimi',
  name: 'Kimi',
  type: 'cloud',
  region: 'cn',
  baseUrl: 'https://api.moonshot.cn/v1',
  model: 'moonshot-v1-32k'
});
