import { createOpenAICompatibleProvider } from './providerFactory.js';

export default createOpenAICompatibleProvider({
  id: 'doubao',
  name: '豆包',
  type: 'cloud',
  region: 'cn',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seed-2-0-lite-260215'
});
