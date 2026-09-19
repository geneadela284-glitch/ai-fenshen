import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FEATURE_KEYS, FEATURE_REGISTRY, getFeature } from './featureRegistry.js';

test('AI大脑 uses one fixed registry for all seven discoverable features', () => {
  assert.deepEqual(FEATURE_KEYS, ['chat', 'memory', 'meeting', 'health', 'finance', 'documents', 'settings']);
  assert.deepEqual(FEATURE_REGISTRY.map((item) => item.key), FEATURE_KEYS);
  assert.equal(getFeature('chat').status, 'available');
  assert.equal(getFeature('memory').status, 'available_after_m9_2');
  assert.equal(getFeature('settings').status, 'available');
  assert.equal(getFeature('settings').route, 'settings');
  assert.equal(getFeature('settings').view, 'settings');
  assert.equal(getFeature('finance').status, 'available');
  assert.equal(getFeature('finance').view, 'finance');
  assert.equal(getFeature('meeting').status, 'available_phase1a');
  assert.equal(getFeature('meeting').view, 'meeting');
  for (const key of ['health', 'documents']) {
    assert.equal(getFeature(key).status, 'coming_soon');
    assert.equal(getFeature(key).view, 'placeholder');
  }
});

test('real mode routes meeting to Phase 1A and reuses one placeholder view for later features', async () => {
  const root = new URL('.', import.meta.url);
  const app = await readFile(new URL('AIFenshenRealApp.jsx', root), 'utf8');
  const placeholder = await readFile(new URL('FeaturePlaceholderView.jsx', root), 'utf8');
  const memory = await readFile(new URL('MemoryFeatureView.jsx', root), 'utf8');
  assert.match(app, /getFeature\(featureKey\)/);
  assert.match(app, /import MeetingCenter from ['"]\.\.\/\.\.\/components\/MeetingCenter\.jsx['"]/);
  assert.match(app, /featureView === ['"]meeting['"]/);
  assert.match(app, /FeaturePlaceholderView/);
  assert.match(app, /MemoryFeatureView/);
  assert.match(app, /dispatch\(\{ type: 'CLOSE_BRAIN' \}\)/);
  assert.match(placeholder, /该功能正在完善，将在后续版本开放。/);
  assert.match(placeholder, /onBack/);
  assert.match(memory, /长期记忆已启用/);
  assert.match(memory, /开始对话/);
});
