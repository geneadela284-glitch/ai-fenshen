import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBetaServer } from '../betaServer.js';
import { createConversationRuntime } from '../conversation/runtime.js';
import {
  createMockStreamingAiService,
  createMockStreamingProvider
} from '../conversation/testing/mockStreamingProvider.js';
import {
  ATTACHMENT_LIMITS,
  ATTACHMENT_STATES
} from './contract.js';

const COOKIE_SECRET = 'attachment-foundation-test-secret-over-32-bytes';
const PRIVACY_VERSION = 'closed-beta-privacy-v1';
const TERMS_VERSION = 'closed-beta-terms-v1';
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
);
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z',
  'base64'
);
const WEBP_1X1 = Buffer.from(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJQBOgCHwAP7/4QAAAA==',
  'base64'
);

function disabledMemoryRuntime() {
  return {
    initialize: async () => ({ status: 'disabled', pathSummary: 'attachment-test-memory.sqlite' }),
    close: async () => {},
    service: {}
  };
}

function oversizedPng(width, height) {
  const value = Buffer.from(PNG_1X1);
  value.writeUInt32BE(width, 16);
  value.writeUInt32BE(height, 20);
  return value;
}

async function jsonRequest(baseUrl, pathname, {
  method = 'GET',
  cookie = '',
  body,
  headers = {}
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const contentType = response.headers.get('content-type') || '';
  return {
    status: response.status,
    headers: response.headers,
    body: contentType.includes('application/json') ? await response.json() : await response.text()
  };
}

async function upload(harness, {
  cookie = harness.loginA.setCookie,
  requestId,
  files = [{ name: 'photo.png', type: 'image/png', bytes: PNG_1X1 }],
  fields = {}
} = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  for (const file of files) {
    form.append('files', new Blob([file.bytes], { type: file.type }), file.name);
  }
  const response = await fetch(`${harness.baseUrl}/api/attachments`, {
    method: 'POST',
    headers: {
      cookie,
      'x-client-request-id': requestId || `upload-${crypto.randomUUID()}`
    },
    body: form
  });
  return {
    status: response.status,
    body: await response.json()
  };
}

async function createHarness({
  limits,
  cleanupIntervalMs = 60_000,
  clock: initialClock = new Date('2026-07-29T08:00:00.000Z'),
  logs = []
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'attachment-foundation-'));
  const publicDir = path.join(directory, 'public');
  mkdirSync(publicDir);
  writeFileSync(path.join(publicDir, 'index.html'), '<main>attachment test</main>');
  let now = new Date(initialClock);
  const provider = createMockStreamingProvider({ chunks: ['unused'] });
  const conversationRuntime = createConversationRuntime({
    databasePath: path.join(directory, 'conversations.sqlite'),
    aiService: createMockStreamingAiService(provider),
    applyMigrations: true
  });
  const instance = await createBetaServer({
    config: {
      publicDir,
      authDb: path.join(directory, 'auth.sqlite'),
      accessControlDb: path.join(directory, 'access.sqlite'),
      conversationDb: path.join(directory, 'unused-conversations.sqlite'),
      privacyDb: path.join(directory, 'privacy.sqlite'),
      privacyExportDir: path.join(directory, 'privacy-exports'),
      privacyRequired: true,
      privacyNotice: {
        privacyNoticeVersion: PRIVACY_VERSION,
        termsVersion: TERMS_VERSION,
        locale: 'zh-CN',
        retentionDays: 30,
        contact: 'privacy@example.test'
      },
      attachmentsDb: path.join(directory, 'attachments', 'attachments.sqlite'),
      attachmentStorageRoot: path.join(directory, 'attachments', 'storage'),
      attachmentImageUnderstandingEnabled: true,
      attachmentLimits: limits,
      attachmentCleanupIntervalMs: cleanupIntervalMs,
      attachmentClock: () => new Date(now),
      attachmentLogger: (event) => logs.push(structuredClone(event)),
      cookieSecret: COOKIE_SECRET,
      secureCookie: false,
      host: '127.0.0.1',
      port: 0
    },
    aiService: {
      getStatus: () => ({ available: false }),
      run: async () => ({ ok: false }),
      stream: async () => ({ ok: false })
    },
    memoryRuntime: disabledMemoryRuntime(),
    protectedMemoryRuntime: null,
    conversationRuntime,
    financeRuntime: null,
    tasksRuntime: null
  });
  const accountA = await instance.auth.createAccount({
    username: 'attachment_a',
    displayName: 'Attachment A',
    password: 'AttachmentPasswordA1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  const accountB = await instance.auth.createAccount({
    username: 'attachment_b',
    displayName: 'Attachment B',
    password: 'AttachmentPasswordB1!',
    role: 'beta_user',
    quotaProfileId: 'closed_beta_user_v1'
  });
  const loginA = await instance.auth.login({
    username: 'attachment_a',
    password: 'AttachmentPasswordA1!'
  });
  const loginB = await instance.auth.login({
    username: 'attachment_b',
    password: 'AttachmentPasswordB1!'
  });
  const conversationA = conversationRuntime.conversations.createForOwner(accountA.id);
  const conversationB = conversationRuntime.conversations.createForOwner(accountB.id);
  const messageA = conversationRuntime.messages.createUserMessage({
    ownerId: accountA.id,
    conversationId: conversationA.id,
    content: 'attachment fixture A',
    clientRequestId: 'attachment-message-a'
  });
  const messageB = conversationRuntime.messages.createUserMessage({
    ownerId: accountB.id,
    conversationId: conversationB.id,
    content: 'attachment fixture B',
    clientRequestId: 'attachment-message-b'
  });
  await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${instance.server.address().port}`;
  const accept = (cookie) => jsonRequest(baseUrl, '/api/privacy/consent', {
    method: 'POST',
    cookie,
    body: {
      accepted: true,
      privacyNoticeVersion: PRIVACY_VERSION,
      termsVersion: TERMS_VERSION,
      locale: 'zh-CN',
      source: 'attachment_test'
    }
  });
  return {
    directory,
    baseUrl,
    instance,
    accountA,
    accountB,
    loginA,
    loginB,
    conversationA,
    conversationB,
    messageA,
    messageB,
    logs,
    setNow(value) { now = new Date(value); },
    accept,
    async close() {
      await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test('RED: authenticated multipart upload trusts Session ownership and isolates A from B', async () => {
  const h = await createHarness();
  try {
    const beforeConsent = await upload(h, { requestId: 'before-consent' });
    assert.equal(beforeConsent.status, 403);
    assert.equal(beforeConsent.body.code, 'PRIVACY_CONSENT_REQUIRED');
    await h.accept(h.loginA.setCookie);
    await h.accept(h.loginB.setCookie);

    const created = await upload(h, {
      requestId: 'owner-isolation',
      fields: {
        conversation_id: h.conversationA.id,
        userId: h.accountB.id,
        ownerId: h.accountB.id,
        storage_reference: '/tmp/forged'
      },
      files: [{ name: '../../private\u0000name.png', type: 'image/png', bytes: PNG_1X1 }]
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.attachments.length, 1);
    const attachmentId = created.body.attachments[0].attachmentId;
    assert.equal(created.body.attachments[0].processingState, ATTACHMENT_STATES.READY);
    assert.equal(JSON.stringify(created.body).includes('/tmp/forged'), false);

    const own = await jsonRequest(h.baseUrl, `/api/attachments/${attachmentId}`, {
      cookie: h.loginA.setCookie
    });
    assert.equal(own.status, 200);
    assert.equal(own.body.attachment.conversationId, h.conversationA.id);
    assert.equal(Object.hasOwn(own.body.attachment, 'storageReference'), false);
    assert.equal(Object.hasOwn(own.body.attachment, 'userId'), false);

    const crossOwner = await jsonRequest(h.baseUrl, `/api/attachments/${attachmentId}`, {
      cookie: h.loginB.setCookie
    });
    assert.equal(crossOwner.status, 403);
    assert.equal(crossOwner.body.code, 'ATTACHMENT_FORBIDDEN');
    const crossDelete = await jsonRequest(h.baseUrl, `/api/attachments/${attachmentId}`, {
      method: 'DELETE',
      cookie: h.loginB.setCookie
    });
    assert.equal(crossDelete.status, 403);
    assert.equal(crossDelete.body.code, 'ATTACHMENT_FORBIDDEN');
    const guessed = await jsonRequest(h.baseUrl, '/api/attachments/att_unknown', {
      cookie: h.loginB.setCookie
    });
    assert.equal(guessed.status, 404);
    assert.equal(guessed.body.code, 'ATTACHMENT_NOT_FOUND');

    const foreignConversation = await upload(h, {
      requestId: 'foreign-conversation',
      fields: { conversation_id: h.conversationB.id }
    });
    assert.equal(foreignConversation.status, 403);
    assert.equal(foreignConversation.body.code, 'ATTACHMENT_FORBIDDEN');

    const stored = h.instance.attachmentRuntime.repository.getForOwner(
      h.accountA.id,
      attachmentId,
      { includeDeleted: true }
    );
    const filePath = h.instance.attachmentRuntime.storage.resolveReference(stored.storageReference);
    assert.equal(statSync(h.instance.attachmentRuntime.storage.root).mode & 0o777, 0o700);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.deepEqual(
      h.instance.attachmentRuntime.repository.listStateHistory(attachmentId),
      ['uploading', 'uploaded', 'validating', 'ready_for_processing']
    );
  } finally {
    await h.close();
  }
});

test('RED: image validation accepts JPEG/PNG/WebP and rejects unsafe or invalid inputs', async (t) => {
  const h = await createHarness();
  try {
    await h.accept(h.loginA.setCookie);
    const clearRateWindow = () => h.instance.accessControlStore.database.prepare(
      'DELETE FROM request_leases WHERE account_id = ?'
    ).run(h.accountA.id);
    for (const [name, type, bytes] of [
      ['photo.jpg', 'image/jpeg', JPEG_1X1],
      ['photo.png', 'image/png', PNG_1X1],
      ['photo.webp', 'image/webp', WEBP_1X1]
    ]) {
      const result = await upload(h, {
        requestId: `valid-${type}`,
        files: [{ name, type, bytes }]
      });
      await t.test(`${type} succeeds`, () => {
        assert.equal(result.status, 201);
        assert.equal(result.body.attachments[0].mimeType, type);
      });
      clearRateWindow();
    }

    const rejectionCases = [
      ['MIME mismatch', 'MIME_SIGNATURE_MISMATCH',
        [{ name: 'mismatch.jpg', type: 'image/jpeg', bytes: PNG_1X1 }]],
      ['SVG', 'UNSUPPORTED_FILE_TYPE',
        [{ name: 'vector.svg', type: 'image/svg+xml', bytes: Buffer.from('<svg/>') }]],
      ['GIF', 'UNSUPPORTED_FILE_TYPE',
        [{ name: 'moving.gif', type: 'image/gif', bytes: Buffer.from('GIF89a') }]],
      ['HEIC', 'UNSUPPORTED_FILE_TYPE',
        [{ name: 'phone.heic', type: 'image/heic', bytes: Buffer.from('fake-heic') }]],
      ['PDF', 'UNSUPPORTED_FILE_TYPE',
        [{ name: 'document.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.7') }]],
      ['ZIP', 'UNSUPPORTED_FILE_TYPE',
        [{ name: 'archive.zip', type: 'application/zip', bytes: Buffer.from('PK\u0003\u0004') }]],
      ['executable', 'UNSUPPORTED_FILE_TYPE',
        [{ name: 'program.exe', type: 'application/octet-stream', bytes: Buffer.from('MZ') }]],
      ['double extension', 'UNSUPPORTED_FILE_TYPE',
        [{ name: 'invoice.pdf.png', type: 'image/png', bytes: PNG_1X1 }]],
      ['empty', 'FILE_EMPTY',
        [{ name: 'empty.png', type: 'image/png', bytes: Buffer.alloc(0) }]],
      ['corrupt', 'FILE_CORRUPT',
        [{ name: 'broken.png', type: 'image/png', bytes: PNG_1X1.subarray(0, 20) }]],
      ['too large', 'FILE_TOO_LARGE',
        [{ name: 'huge.png', type: 'image/png', bytes: Buffer.alloc(ATTACHMENT_LIMITS.maxFileBytes + 1) }]],
      ['too many', 'TOO_MANY_ATTACHMENTS',
        Array.from({ length: 4 }, (_, index) => ({
          name: `photo-${index}.png`,
          type: 'image/png',
          bytes: PNG_1X1
        }))],
      ['too many pixels', 'IMAGE_DIMENSION_LIMIT_EXCEEDED',
        [{ name: 'pixels.png', type: 'image/png', bytes: oversizedPng(5000, 5000) }]]
    ];
    for (const [label, code, files] of rejectionCases) {
      const result = await upload(h, {
        requestId: `reject-${label.replaceAll(' ', '-')}`,
        files
      });
      await t.test(`${label} is rejected`, () => {
        assert.equal(result.status, code === 'FILE_TOO_LARGE' ? 413 : 400);
        assert.equal(result.body.code, code);
        assert.equal(result.body.ok, false);
      });
      clearRateWindow();
    }
  } finally {
    await h.close();
  }
});

test('RED: quotas, idempotency, lease release, fail-closed storage and safe logs are enforced', async () => {
  const logs = [];
  const h = await createHarness({
    limits: {
      ...ATTACHMENT_LIMITS,
      dailyUploadBytes: PNG_1X1.length * 2
    },
    logs
  });
  try {
    await h.accept(h.loginA.setCookie);
    await h.accept(h.loginB.setCookie);
    const first = await upload(h, {
      requestId: 'idempotent-upload',
      files: [{ name: 'private-secret-name.png', type: 'image/png', bytes: PNG_1X1 }]
    });
    assert.equal(first.status, 201);
    const retry = await upload(h, {
      requestId: 'idempotent-upload',
      files: [{ name: 'changed-name.png', type: 'image/png', bytes: PNG_1X1 }]
    });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.attachments[0].attachmentId, first.body.attachments[0].attachmentId);
    assert.equal(h.instance.attachmentRuntime.repository.exportMetadataForOwner(h.accountA.id).length, 1);

    const second = await upload(h, { requestId: 'daily-second' });
    assert.equal(second.status, 201);
    const overDaily = await upload(h, { requestId: 'daily-over-limit' });
    assert.equal(overDaily.status, 429);
    assert.equal(overDaily.body.code, 'DAILY_UPLOAD_LIMIT_EXCEEDED');

    const leaseRows = h.instance.accessControlStore.database.prepare(`
      SELECT completed_at FROM request_leases
      WHERE account_id = ? AND request_id LIKE 'attachment:%'
    `).all(h.accountA.id);
    assert.equal(leaseRows.length >= 3, true);
    assert.equal(leaseRows.every((row) => Boolean(row.completed_at)), true);

    h.instance.attachmentRuntime.storage.writeObject = () => {
      throw Object.assign(new Error('do not leak /private/storage/path'), {
        code: 'ATTACHMENT_STORE_UNAVAILABLE'
      });
    };
    const storeFailure = await upload(h, {
      cookie: h.loginB.setCookie,
      requestId: 'store-failure',
      files: [{
        name: 'credential-API-Key-secret.png',
        type: 'image/png',
        bytes: PNG_1X1
      }]
    });
    assert.equal(storeFailure.status, 503);
    assert.equal(storeFailure.body.code, 'ATTACHMENT_STORE_UNAVAILABLE');
    const failedLease = h.instance.accessControlStore.database.prepare(`
      SELECT completed_at FROM request_leases
      WHERE account_id = ? AND request_id = ?
    `).get(h.accountB.id, 'attachment:store-failure');
    assert.ok(failedLease.completed_at);

    const originalDailyBytes = h.instance.attachmentRuntime.repository.currentDailyBytes.bind(
      h.instance.attachmentRuntime.repository
    );
    h.instance.attachmentRuntime.repository.currentDailyBytes = () => {
      throw new Error('private sqlite failure');
    };
    const databaseFailure = await upload(h, {
      cookie: h.loginB.setCookie,
      requestId: 'database-failure'
    });
    assert.equal(databaseFailure.status, 503);
    assert.equal(databaseFailure.body.code, 'ATTACHMENT_STORE_UNAVAILABLE');
    h.instance.attachmentRuntime.repository.currentDailyBytes = originalDailyBytes;
    const databaseFailureLease = h.instance.accessControlStore.database.prepare(`
      SELECT completed_at FROM request_leases
      WHERE account_id = ? AND request_id = ?
    `).get(h.accountB.id, 'attachment:database-failure');
    assert.ok(databaseFailureLease.completed_at);

    const serializedLogs = JSON.stringify(logs);
    assert.doesNotMatch(serializedLogs, /private-secret-name|credential-API-Key|base64|storage\/path|AttachmentPassword/i);
    assert.equal(logs.every((entry) => Object.hasOwn(entry, 'code') || Object.hasOwn(entry, 'state')), true);
  } finally {
    await h.close();
  }
});

test('RED: binding, explicit deletion and one-hour expiry remove bytes and preserve anonymous tombstones', async () => {
  const h = await createHarness();
  try {
    await h.accept(h.loginA.setCookie);
    await h.accept(h.loginB.setCookie);
    const unbound = await upload(h, { requestId: 'ttl-unbound' });
    const bound = await upload(h, {
      requestId: 'bound-a'
    });
    const b = await upload(h, {
      cookie: h.loginB.setCookie,
      requestId: 'bound-b',
      fields: { conversation_id: h.conversationB.id }
    });
    const boundId = bound.body.attachments[0].attachmentId;
    h.instance.attachmentRuntime.service.bindAttachmentToMessage({
      userId: h.accountA.id,
      conversationId: h.conversationA.id,
      messageId: h.messageA.id,
      attachmentIds: [boundId]
    });
    h.instance.attachmentRuntime.service.bindAttachmentToMessage({
      userId: h.accountB.id,
      conversationId: h.conversationB.id,
      messageId: h.messageB.id,
      attachmentIds: [b.body.attachments[0].attachmentId]
    });

    const orphan = path.join(h.instance.attachmentRuntime.storage.temporaryRoot, 'orphan.upload');
    writeFileSync(orphan, 'temporary');
    chmodSync(orphan, 0o600);
    const oldTime = new Date('2026-07-29T07:00:00.000Z');
    utimesSync(orphan, oldTime, oldTime);
    h.setNow('2026-07-29T09:01:00.000Z');
    const cleanup = h.instance.attachmentRuntime.service.cleanupExpired();
    assert.equal(cleanup.expired, 1);
    assert.equal(cleanup.temporary, 1);
    assert.equal(cleanup.failed, 0);
    assert.deepEqual(h.instance.attachmentRuntime.service.cleanupExpired(), {
      expired: 0,
      temporary: 0,
      failed: 0
    });
    const expiredId = unbound.body.attachments[0].attachmentId;
    const expired = await jsonRequest(h.baseUrl, `/api/attachments/${expiredId}`, {
      cookie: h.loginA.setCookie
    });
    assert.equal(expired.status, 410);
    assert.equal(expired.body.code, 'ATTACHMENT_EXPIRED');
    assert.equal(h.instance.attachmentRuntime.service.get(h.accountA.id, boundId).messageId, h.messageA.id);

    const retryCleanup = await upload(h, { requestId: 'cleanup-retry' });
    const retryId = retryCleanup.body.attachments[0].attachmentId;
    const retryRow = h.instance.attachmentRuntime.repository.getForOwner(h.accountA.id, retryId);
    const originalDelete = h.instance.attachmentRuntime.storage.deleteReference.bind(
      h.instance.attachmentRuntime.storage
    );
    h.setNow('2026-07-29T10:02:00.000Z');
    h.instance.attachmentRuntime.storage.deleteReference = (reference) => {
      if (reference === retryRow.storageReference) {
        throw Object.assign(new Error('cleanup failure'), {
          code: 'ATTACHMENT_STORE_UNAVAILABLE'
        });
      }
      return originalDelete(reference);
    };
    const failedCleanup = h.instance.attachmentRuntime.service.cleanupExpired();
    assert.equal(failedCleanup.failed, 1);
    assert.equal(
      h.instance.attachmentRuntime.repository.getForOwner(h.accountA.id, retryId).failureCode,
      'ATTACHMENT_STORE_UNAVAILABLE'
    );
    h.instance.attachmentRuntime.storage.deleteReference = originalDelete;
    const recoveredCleanup = h.instance.attachmentRuntime.service.cleanupExpired();
    assert.equal(recoveredCleanup.expired, 1);
    assert.equal(recoveredCleanup.failed, 0);

    const deleted = await jsonRequest(h.baseUrl, `/api/attachments/${boundId}`, {
      method: 'DELETE',
      cookie: h.loginA.setCookie
    });
    assert.equal(deleted.status, 200);
    const afterDelete = await jsonRequest(h.baseUrl, `/api/attachments/${boundId}`, {
      cookie: h.loginA.setCookie
    });
    assert.equal(afterDelete.status, 410);
    assert.equal(afterDelete.body.code, 'ATTACHMENT_DELETED');
    assert.equal(
      h.instance.attachmentRuntime.repository.exportMetadataForOwner(h.accountB.id)[0].attachmentId,
      b.body.attachments[0].attachmentId
    );
    const tombstones = h.instance.attachmentRuntime.repository.listTombstones();
    assert.equal(tombstones.length >= 1, true);
    assert.equal(JSON.stringify(tombstones).includes(h.accountA.id), false);
    assert.equal(JSON.stringify(tombstones).includes(boundId), false);
  } finally {
    await h.close();
  }
});

test('RED: privacy export includes only owner attachment bytes and account deletion removes A without affecting B', async () => {
  const h = await createHarness();
  try {
    await h.accept(h.loginA.setCookie);
    await h.accept(h.loginB.setCookie);
    const a = await upload(h, {
      requestId: 'privacy-a',
      files: [{ name: 'A-private.png', type: 'image/png', bytes: PNG_1X1 }]
    });
    const b = await upload(h, {
      cookie: h.loginB.setCookie,
      requestId: 'privacy-b',
      files: [{ name: 'B-private.webp', type: 'image/webp', bytes: WEBP_1X1 }]
    });
    const aId = a.body.attachments[0].attachmentId;
    const bId = b.body.attachments[0].attachmentId;
    const aRow = h.instance.attachmentRuntime.repository.getForOwner(
      h.accountA.id,
      aId,
      { includeDeleted: true }
    );
    const aPath = h.instance.attachmentRuntime.storage.resolveReference(aRow.storageReference);

    const exportGrant = await jsonRequest(h.baseUrl, '/api/privacy/exports', {
      method: 'POST',
      cookie: h.loginA.setCookie
    });
    assert.equal(exportGrant.status, 201);
    const exported = await jsonRequest(h.baseUrl, exportGrant.body.downloadUrl, {
      cookie: h.loginA.setCookie
    });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.attachments.length, 1);
    assert.equal(exported.body.attachments[0].attachmentId, aId);
    assert.equal(exported.body.attachments[0].originalFile.encoding, 'base64');
    assert.deepEqual(
      Buffer.from(exported.body.attachments[0].originalFile.data, 'base64'),
      PNG_1X1
    );
    assert.equal(JSON.stringify(exported.body.attachments).includes(bId), false);
    assert.equal(JSON.stringify(exported.body.attachments).includes('storageReference'), false);
    assert.equal(JSON.stringify(exported.body.attachments).includes(h.instance.attachmentRuntime.storage.root), false);

    const initiated = await jsonRequest(h.baseUrl, '/api/privacy/deletion-requests', {
      method: 'POST',
      cookie: h.loginA.setCookie
    });
    assert.equal(initiated.body.impact.attachments, true);
    const completed = await jsonRequest(h.baseUrl, '/api/privacy/deletion-requests/confirm', {
      method: 'POST',
      cookie: h.loginA.setCookie,
      body: {
        confirmation: 'DELETE_MY_ACCOUNT',
        confirmationToken: initiated.body.confirmationToken
      }
    });
    assert.equal(completed.status, 200);
    assert.equal(existsSync(aPath), false);
    assert.equal(h.instance.attachmentRuntime.service.verifyOwnerDeleted(h.accountA.id), true);
    assert.equal(h.instance.attachmentRuntime.repository.exportMetadataForOwner(h.accountB.id).length, 1);
    assert.equal(
      h.instance.attachmentRuntime.repository.exportMetadataForOwner(h.accountB.id)[0].attachmentId,
      bId
    );
    assert.equal(h.instance.attachmentRuntime.service.get(h.accountB.id, bId).processingState, ATTACHMENT_STATES.READY);
  } finally {
    await h.close();
  }
});

test('RED: attachment storage failure remains fail-closed when its root is not writable', async () => {
  const h = await createHarness();
  try {
    await h.accept(h.loginA.setCookie);
    chmodSync(h.instance.attachmentRuntime.storage.objectsRoot, 0o500);
    const original = h.instance.attachmentRuntime.storage.writeObject;
    h.instance.attachmentRuntime.storage.writeObject = (...args) => {
      if ((statSync(h.instance.attachmentRuntime.storage.objectsRoot).mode & 0o200) === 0) {
        throw Object.assign(new Error('storage unavailable'), { code: 'ATTACHMENT_STORE_UNAVAILABLE' });
      }
      return original.call(h.instance.attachmentRuntime.storage, ...args);
    };
    const response = await upload(h, { requestId: 'readonly-store' });
    assert.equal(response.status, 503);
    assert.equal(response.body.code, 'ATTACHMENT_STORE_UNAVAILABLE');
    chmodSync(h.instance.attachmentRuntime.storage.objectsRoot, 0o700);
    assert.equal(
      h.instance.attachmentRuntime.repository.exportMetadataForOwner(h.accountA.id)
        .some((item) => item.processingState === 'ready_for_processing'),
      false
    );
  } finally {
    if (h.instance.attachmentRuntime?.storage?.objectsRoot &&
        existsSync(h.instance.attachmentRuntime.storage.objectsRoot)) {
      chmodSync(h.instance.attachmentRuntime.storage.objectsRoot, 0o700);
    }
    await h.close();
  }
});
