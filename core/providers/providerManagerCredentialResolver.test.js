import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderManager } from './providerManager.js';

function fakeProvider(calls) {
  return {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'cloud',
    status: 'available',
    region: 'cn-mainland',
    supportsStreaming: true,
    async generate(request) { calls.push(['generate', request]); return { content: 'ok' }; },
    async chat(request) { calls.push(['chat', request]); return { content: 'ok' }; },
    async streamChat(request) { calls.push(['streamChat', request]); return { content: 'ok' }; },
    async image(request) { calls.push(['image', request]); return { content: 'ok' }; },
    async embedding(request) { calls.push(['embedding', request]); return { content: 'ok' }; }
  };
}

test('Vault mode obtains API Key only inside Resolver callback and keeps manager config secret-free', async () => {
  const calls = [];
  const resolverCalls = [];
  const manager = new ProviderManager({
    providers: [fakeProvider(calls)],
    credentialMode: 'vault_v1',
    credentialResolver: {
      async withCredentials(context, callback) {
        resolverCalls.push(context);
        const credentials = { api_key: 'runtime-only-secret' };
        try {
          return await callback(credentials);
        } finally {
          credentials.api_key = '';
        }
      }
    },
    config: {
      providerConfigs: {
        deepseek: {
          enabled: true,
          apiKeyConfigured: true,
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-v4-flash',
          temperature: 0.2
        }
      }
    }
  });

  await manager.chat({ provider: 'deepseek', input: '你好' });

  assert.deepEqual(resolverCalls, [{ providerId: 'deepseek', purpose: 'invoke' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].options.apiKey, 'runtime-only-secret');
  assert.equal(calls[0][1].options.baseUrl, 'https://api.deepseek.com');
  assert.equal(calls[0][1].options.model, 'deepseek-v4-flash');
  assert.doesNotMatch(JSON.stringify(manager.getConfig()), /runtime-only-secret/);
  assert.equal('apiKey' in manager.getConfig().providerConfigs.deepseek, false);
});

test('Vault mode applies Resolver to generate, stream, image, and embedding calls', async () => {
  const calls = [];
  let resolverCalls = 0;
  const manager = new ProviderManager({
    providers: [fakeProvider(calls)],
    credentialMode: 'vault_v1',
    credentialResolver: {
      withCredentials(_context, callback) {
        resolverCalls += 1;
        return callback({ api_key: 'runtime-only-secret' });
      }
    },
    config: {
      providerConfigs: {
        deepseek: {
          enabled: true,
          apiKeyConfigured: true,
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-v4-flash'
        }
      }
    }
  });
  await manager.generate({ provider: 'deepseek' });
  await manager.streamChat({ provider: 'deepseek' });
  await manager.image({ provider: 'deepseek' });
  await manager.embedding({ provider: 'deepseek' });
  assert.equal(resolverCalls, 4);
  assert.deepEqual(calls.map(([method]) => method), ['generate', 'streamChat', 'image', 'embedding']);
});

test('feature-off legacy mode keeps the existing direct configuration path', async () => {
  const calls = [];
  const manager = new ProviderManager({
    providers: [fakeProvider(calls)],
    credentialMode: 'legacy_settings_v1',
    config: {
      providerConfigs: {
        deepseek: {
          apiKey: 'legacy-secret',
          baseUrl: 'https://api.deepseek.com',
          defaultModel: 'deepseek-v4-flash'
        }
      }
    }
  });
  await manager.chat({ provider: 'deepseek' });
  assert.equal(calls[0][1].options.apiKey, 'legacy-secret');
});

test('Resolver denial fails safely before the Provider adapter is called', async () => {
  const calls = [];
  const manager = new ProviderManager({
    providers: [fakeProvider(calls)],
    credentialMode: 'vault_v1',
    credentialResolver: {
      async withCredentials() {
        const error = new Error('PROVIDER_DISABLED');
        error.code = 'PROVIDER_DISABLED';
        throw error;
      }
    }
  });
  await assert.rejects(
    manager.chat({ provider: 'deepseek' }),
    (error) => error.code === 'PROVIDER_DISABLED'
  );
  assert.equal(calls.length, 0);
});
