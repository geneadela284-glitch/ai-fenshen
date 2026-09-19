import { createAnthropicProvider } from './providerFactory.js';

export default createAnthropicProvider({
  id: 'claude',
  name: 'Claude',
  type: 'cloud',
  region: 'global',
  reserved: true,
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-20250514'
});
