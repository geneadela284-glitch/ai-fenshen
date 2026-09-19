import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelRegistry } from './ModelRegistry.js';

function registryWithCapabilities(capabilities) {
  return new ModelRegistry({
    providers: {
      getCapabilities(providerId) {
        return capabilities[providerId];
      }
    }
  });
}

test('voice SSE requires native voice streaming while generic SSE keeps the bridge fallback', () => {
  const registry = registryWithCapabilities({
    native: {
      supportsChat: true,
      supportsStreaming: true,
      supportsSingleShotSseBridge: false
    },
    bridge: {
      supportsChat: true,
      supportsStreaming: false,
      supportsVoiceStreaming: false,
      supportsSingleShotSseBridge: true
    },
    voiceNative: {
      supportsChat: true,
      supportsStreaming: false,
      supportsVoiceStreaming: true,
      supportsSingleShotSseBridge: true
    }
  });

  assert.equal(registry.supportsDelivery('native', 'sse'), true);
  assert.equal(registry.supportsDelivery('native', 'voice_sse'), true);
  assert.equal(registry.supportsDelivery('bridge', 'sse'), true);
  assert.equal(registry.supportsDelivery('bridge', 'voice_sse'), false);
  assert.equal(registry.supportsDelivery('voiceNative', 'sse'), true);
  assert.equal(registry.supportsDelivery('voiceNative', 'voice_sse'), true);
  assert.equal(registry.supportsDelivery('bridge', 'chat'), true);
});
