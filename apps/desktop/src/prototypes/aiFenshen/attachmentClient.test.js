import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACHMENT_DEFAULT_QUESTION,
  createAttachmentClient
} from './attachmentClient.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('attachment client uploads multipart with Session identity only and reuses the caller request id', async () => {
  const calls = [];
  const client = createAttachmentClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      return jsonResponse({
        ok: true,
        replayed: false,
        attachments: [{
          attachmentId: 'att_a',
          originalFilename: 'screen.png',
          mimeType: 'image/png',
          processingState: 'ready_for_processing'
        }]
      }, 201);
    }
  });
  const file = new File([new Uint8Array([1, 2, 3])], 'screen.png', {
    type: 'image/png',
    lastModified: 1
  });

  const result = await client.upload({
    files: [file],
    conversationId: 'conv-a',
    clientRequestId: 'upload-request-a'
  });

  assert.equal(result.attachments[0].attachmentId, 'att_a');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/attachments');
  assert.equal(calls[0].options.credentials, 'include');
  assert.equal(calls[0].options.headers['X-Client-Request-Id'], 'upload-request-a');
  assert.equal(calls[0].options.body instanceof FormData, true);
  assert.equal(calls[0].options.body.get('conversation_id'), 'conv-a');
  assert.equal(calls[0].options.body.getAll('files').length, 1);
  assert.equal(
    [...calls[0].options.body.keys()].some((key) => /owner|user|provider|model|path/i.test(key)),
    false
  );
});

test('attachment client exposes feature capability, authenticated metadata/content and deletion without permanent URL data', async () => {
  const calls = [];
  const client = createAttachmentClient({
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/attachments/capabilities') {
        return jsonResponse({ ok: true, enabled: true, limits: { maxAttachmentsPerMessage: 3 } });
      }
      if (options.method === 'DELETE') return jsonResponse({ ok: true, deleted: true });
      return jsonResponse({ ok: true, attachment: { attachmentId: 'att_a' } });
    }
  });

  assert.equal((await client.getCapabilities()).enabled, true);
  assert.equal((await client.get('att_a')).attachmentId, 'att_a');
  assert.deepEqual(await client.delete('att_a'), { ok: true, deleted: true });
  assert.equal(client.contentUrl('att_a'), '/api/attachments/att_a/content');
  assert.equal(calls.every((call) => call.options.credentials === 'include'), true);
});

test('attachment-only messages use a visible deterministic question', () => {
  assert.equal(ATTACHMENT_DEFAULT_QUESTION.one, '请描述这张图片的主要内容。');
  assert.equal(ATTACHMENT_DEFAULT_QUESTION.many, '请概括这些图片，并说明主要区别。');
});

test('attachment errors are stable and never expose Provider or server paths', async () => {
  const client = createAttachmentClient({
    fetchImpl: async () => jsonResponse({
      ok: false,
      code: 'FILE_TOO_LARGE',
      message: '单个附件不能超过8 MiB。',
      provider: 'qwen',
      path: '/opt/private/image.png'
    }, 413)
  });
  await assert.rejects(
    client.upload({
      files: [new File(['x'], 'x.png', { type: 'image/png' })],
      clientRequestId: 'upload-failure'
    }),
    (error) => {
      assert.equal(error.code, 'FILE_TOO_LARGE');
      assert.equal(error.message, '单个附件不能超过8 MiB。');
      assert.doesNotMatch(error.message, /qwen|opt|provider|path/i);
      return true;
    }
  );
});
