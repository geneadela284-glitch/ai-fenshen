import { createOpenAICompatibleProvider } from './providerFactory.js';

export default createOpenAICompatibleProvider({
  id: 'openai',
  name: 'OpenAI',
  type: 'cloud',
  region: 'global',
  reserved: true,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5'
});
