import test from 'node:test';
import assert from 'node:assert/strict';

import { FakeMemoryRecallAssistant, MemoryRecallEngine } from './index.js';
import { fakeRecallContext, staticRepository } from './testing/fixtures.js';

test('Fake Assistant may suggest a valid intent for an ambiguous request', async () => {
  const assistant = new FakeMemoryRecallAssistant({ intent: 'personal_preference' });
  const engine = new MemoryRecallEngine({ repository: staticRepository([]), assistant });
  const result = await engine.analyzeRecallIntent(fakeRecallContext(), { text: '你还记得那件事吗' });
  assert.equal(result.intent, 'personal_preference');
  assert.equal(result.reasonCode, 'RECALL_ASSISTANT_SUGGESTION');
});

test('invalid Assistant intent is ignored', async () => {
  const assistant = new FakeMemoryRecallAssistant({ intent: 'bypass_security' });
  const engine = new MemoryRecallEngine({ repository: staticRepository([]), assistant });
  const result = await engine.analyzeRecallIntent(fakeRecallContext(), { text: '你还记得那件事吗' });
  assert.equal(result.intent, 'ambiguous');
});

test('Assistant failure falls back to deterministic rules', async () => {
  const assistant = { async suggestIntent() { throw new Error('fake provider unavailable'); } };
  const engine = new MemoryRecallEngine({ repository: staticRepository([]), assistant });
  const result = await engine.analyzeRecallIntent(fakeRecallContext(), { text: '按我的偏好推荐' });
  assert.equal(result.intent, 'personal_preference');
});

test('Fake Assistant has no Repository or mutation capability', () => {
  const assistant = new FakeMemoryRecallAssistant({ intent: 'personal_fact' });
  assert.equal('repository' in assistant, false);
  assert.equal(typeof assistant.create, 'undefined');
  assert.equal(typeof assistant.update, 'undefined');
});

test('Provider label changes do not change Assistant output contract', async () => {
  const first = await new FakeMemoryRecallAssistant({ intent: 'personal_fact', provider: 'a' }).suggestIntent({ text: 'x' });
  const second = await new FakeMemoryRecallAssistant({ intent: 'personal_fact', provider: 'b' }).suggestIntent({ text: 'x' });
  assert.deepEqual(first, second);
});
