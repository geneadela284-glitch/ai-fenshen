import assert from 'node:assert/strict';
import test from 'node:test';

import {
  confirmMemoryCapture,
  correctMemory,
  deleteMemory,
  fetchMemoryHistory,
  fetchMemoryList,
  permanentlyDeleteMemory,
  processConversationMemory,
  restoreMemory
} from './memoryClient.js';

test('memory client never sends a userId and uses authenticated cookies', async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { status: 'completed', data: { items: [] } } }) };
  };
  try {
    await processConversationMemory({ input: 'fake input', sourceId: 'fake-source' });
    await confirmMemoryCapture({ confirmationId: 'fake-confirm', action: 'confirm' });
    await fetchMemoryList();
    await fetchMemoryHistory('fake-memory');
    await correctMemory('fake-memory', { expectedVersion: 1, value: 'fake correction' });
    await deleteMemory('fake-memory', { expectedVersion: 1 });
    await restoreMemory('fake-memory', { expectedVersion: 2 });
    await permanentlyDeleteMemory('fake-memory', { expectedVersion: 3, confirmationToken: 'fake-confirm' });
    assert.equal(calls.every((call) => call.options.credentials === 'include'), true);
    assert.equal(calls.some((call) => String(call.options.body || '').includes('userId')), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('memory client exposes transparent service errors', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 503, json: async () => ({ ok: false, code: 'MEMORY_TEMPORARILY_UNAVAILABLE', message: '记忆暂时不可用，其他功能仍可继续。' })
  });
  try {
    await assert.rejects(() => fetchMemoryList(), (error) => error?.code === 'MEMORY_TEMPORARILY_UNAVAILABLE' && error?.status === 503);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
