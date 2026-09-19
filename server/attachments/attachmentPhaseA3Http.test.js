import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAttachmentsApi } from './httpApi.js';
import { handleConversationApi } from '../conversation/httpApi.js';

function responseHarness() {
  const result = {
    status: null,
    headers: null,
    body: null,
    destroyed: false,
    writableEnded: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
      this.writableEnded = true;
    }
  };
  return result;
}

function sendJson(res, status, payload, headers = {}) {
  res.status = status;
  res.headers = headers;
  res.body = payload;
  res.writableEnded = true;
}

test('feature flag is queryable and disabled mode blocks upload without touching storage', async () => {
  let serviceCalls = 0;
  const runtime = {
    limits: { maxFileBytes: 8 * 1024 * 1024, maxAttachmentsPerMessage: 3 },
    service: new Proxy({}, {
      get() {
        serviceCalls += 1;
        return () => {};
      }
    }),
    repository: {},
    storage: {}
  };
  const capabilities = responseHarness();
  await handleAttachmentsApi({
    req: { method: 'GET', headers: {} },
    res: capabilities,
    url: new URL('http://local/api/attachments/capabilities'),
    user: { id: 'user-a' },
    subject: { accountId: 'user-a' },
    accessControl: {},
    runtime,
    enabled: false,
    sendJson
  });
  assert.deepEqual(capabilities.body, {
    ok: true,
    enabled: false,
    supportedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    limits: { maxFileBytes: 8 * 1024 * 1024, maxAttachmentsPerMessage: 3 }
  });

  const upload = responseHarness();
  await handleAttachmentsApi({
    req: { method: 'POST', headers: {} },
    res: upload,
    url: new URL('http://local/api/attachments'),
    user: { id: 'user-a' },
    subject: { accountId: 'user-a' },
    accessControl: {},
    runtime,
    enabled: false,
    sendJson
  });
  assert.equal(upload.status, 404);
  assert.equal(upload.body.code, 'ATTACHMENT_FEATURE_DISABLED');
  assert.equal(serviceCalls, 0);
});

test('authenticated content preview returns owner bytes with no-store and no server path', async () => {
  const res = responseHarness();
  const file = Buffer.from('safe-image-bytes');
  const row = {
    attachmentId: 'att_a',
    userId: 'user-a',
    mimeType: 'image/png',
    byteSize: file.length,
    storageReference: 'objects/aa/att_a.png',
    processingState: 'processed'
  };
  await handleAttachmentsApi({
    req: { method: 'GET', headers: {} },
    res,
    url: new URL('http://local/api/attachments/att_a/content'),
    user: { id: 'user-a' },
    subject: { accountId: 'user-a' },
    accessControl: {},
    runtime: {
      limits: { maxFileBytes: 8, maxAttachmentsPerMessage: 3 },
      repository: {},
      service: { get: () => row },
      storage: { readObject: (reference) => {
        assert.equal(reference, row.storageReference);
        return file;
      } }
    },
    enabled: true,
    sendJson
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'image/png');
  assert.equal(res.headers['Cache-Control'], 'private, no-store');
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(res.body, file);
  assert.equal(JSON.stringify(res.headers).includes('objects/'), false);
});

test('conversation history restores only owner attachment metadata and safe processing state', async () => {
  const res = responseHarness();
  const message = {
    id: 'msg-a',
    conversationId: 'conv-a',
    role: 'user',
    content: '这张截图主要说了什么？',
    status: 'completed',
    clientRequestId: 'client-a',
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z'
  };
  await handleConversationApi({
    req: { method: 'GET' },
    res,
    url: new URL('http://local/api/ai/conversations/conv-a/messages'),
    user: { id: 'user-a' },
    subject: { accountId: 'user-a' },
    accessControl: {
      assertAuthenticatedSubject: () => ({ accountId: 'user-a' })
    },
    runtime: {
      service: {},
      conversations: {
        getByIdForOwner: (id, owner) => id === 'conv-a' && owner === 'user-a'
          ? { id, title: 'image', status: 'active' }
          : null
      },
      messages: {
        listForConversationOwner: () => [message]
      }
    },
    attachmentRuntime: {
      repository: {
        listForMessageOwner: (owner, conversationId, messageId) => {
          assert.deepEqual([owner, conversationId, messageId], ['user-a', 'conv-a', 'msg-a']);
          return [{
            attachmentId: 'att_a',
            userId: 'user-a',
            originalFilename: 'screen.png',
            mimeType: 'image/png',
            byteSize: 128,
            processingState: 'processed',
            storageReference: 'objects/private.png'
          }];
        }
      },
      processingService: {
        publicResultForMessage: () => ({
          status: 'processed',
          answerMode: 'combined',
          limitations: [],
          evidenceRefs: [{ type: 'ocr', attachmentIds: ['att_a'] }]
        })
      }
    },
    readJson: async () => ({}),
    sendJson
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.messages[0].attachments, [{
    attachmentId: 'att_a',
    conversationId: null,
    messageId: null,
    originalFilename: 'screen.png',
    safeFilename: undefined,
    mimeType: 'image/png',
    mediaKind: undefined,
    byteSize: 128,
    width: undefined,
    height: undefined,
    checksumSha256: undefined,
    processingState: 'processed',
    parserType: null,
    createdAt: undefined,
    expiresAt: null,
    deletedAt: null
  }]);
  assert.equal(JSON.stringify(res.body).includes('storageReference'), false);
  assert.equal(JSON.stringify(res.body).includes('qwen'), false);
});
