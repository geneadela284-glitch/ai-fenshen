import { createGeminiProvider } from './providerFactory.js';

export default createGeminiProvider({
  id: 'gemini',
  name: 'Gemini',
  type: 'cloud',
  region: 'global',
  reserved: true,
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  model: 'gemini-2.5-pro'
});
