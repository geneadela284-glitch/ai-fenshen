import assert from 'node:assert/strict';
import test from 'node:test';

async function subject() {
  try {
    return await import('./realConversationSelection.js');
  } catch {
    return null;
  }
}

test('fresh-conversation marker prevents refresh from restoring an older conversation', async () => {
  const selection = await subject();
  assert.equal(typeof selection?.selectRestorableConversation, 'function');
  assert.equal(selection.selectRestorableConversation([{ id: 'old-1' }], selection.NEW_CONVERSATION_MARKER), null);
});

test('normal restore prefers remembered conversation and otherwise latest conversation', async () => {
  const selection = await subject();
  const conversations = [{ id: 'latest' }, { id: 'remembered' }];
  assert.equal(selection.selectRestorableConversation(conversations, 'remembered').id, 'remembered');
  assert.equal(selection.selectRestorableConversation(conversations, '').id, 'latest');
});

