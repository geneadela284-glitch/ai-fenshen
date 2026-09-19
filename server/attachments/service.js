import crypto from 'node:crypto';

import {
  ATTACHMENT_STATES,
  attachmentError,
  publicAttachment
} from './contract.js';
import { validateImageFile } from './imageValidation.js';

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw attachmentError(code);
  return normalized;
}

function safeLog(logger, value) {
  try { logger(value); } catch {}
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function storeCall(callback) {
  try {
    return callback();
  } catch (error) {
    if (error?.code) throw error;
    throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503, cause: error });
  }
}

export class AttachmentService {
  constructor({
    repository,
    storage,
    accessControl,
    conversationRuntime,
    limits,
    clock = () => new Date(),
    logger = () => {}
  } = {}) {
    this.repository = repository;
    this.storage = storage;
    this.accessControl = accessControl;
    this.conversationRuntime = conversationRuntime;
    this.limits = limits;
    this.clock = clock;
    this.logger = logger;
    this.processingService = null;
    this.activeOwners = new Map();
    this.cancelledOwners = new Set();
  }

  setProcessingService(processingService) {
    this.processingService = processingService || null;
  }

  now() {
    const value = new Date(this.clock());
    if (!Number.isFinite(value.getTime())) {
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 });
    }
    return value;
  }

  assertSubject(userId, subject) {
    const actor = this.accessControl.assertAuthenticatedSubject(subject);
    if (actor.accountId !== required(userId, 'ATTACHMENT_FORBIDDEN')) {
      throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
    }
    return actor;
  }

  dayKey() {
    return this.now().toISOString().slice(0, 10);
  }

  replay(userId, clientRequestId) {
    const batch = storeCall(() => this.repository.findBatch(userId, clientRequestId));
    if (!batch) return null;
    if (batch.status === 'failed') {
      throw attachmentError(batch.failureCode || 'UPLOAD_FAILED', {
        status: batch.failureCode === 'ATTACHMENT_STORE_UNAVAILABLE' ? 503 : 400
      });
    }
    if (batch.status !== 'completed') {
      throw attachmentError('UPLOAD_FAILED', { status: 409 });
    }
    return {
      replayed: true,
      attachments: storeCall(() =>
        this.repository.listBatchAttachments(userId, clientRequestId)
      )
        .map(publicAttachment)
    };
  }

  preflight(userId, clientRequestId, contentLength) {
    const replay = this.replay(userId, clientRequestId);
    if (replay) return replay;
    const dayKey = this.dayKey();
    const used = storeCall(() => this.repository.currentDailyBytes(userId, dayKey));
    const remaining = Math.max(0, this.limits.dailyUploadBytes - used);
    if (remaining <= 0 ||
        Number(contentLength) > remaining + this.limits.multipartOverheadBytes) {
      throw attachmentError('DAILY_UPLOAD_LIMIT_EXCEEDED', { status: 429 });
    }
    return {
      maxReceiveBytes: remaining + this.limits.multipartOverheadBytes
    };
  }

  assertConversationOwner(userId, conversationId) {
    if (!conversationId) return null;
    const conversation = this.conversationRuntime?.conversations?.getByIdForOwner?.(
      conversationId,
      userId
    );
    if (!conversation) throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
    return conversation.id;
  }

  upload({
    userId,
    subject,
    clientRequestId,
    conversationId = null,
    files,
    reservedBytes = 0
  } = {}) {
    const started = Date.now();
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    const requestId = required(clientRequestId, 'UPLOAD_FAILED');
    this.assertSubject(owner, subject);
    const replay = this.replay(owner, requestId);
    if (replay) return replay;
    if (this.cancelledOwners.has(owner)) {
      throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
    }
    if (!Array.isArray(files) || files.length === 0) throw attachmentError('FILE_EMPTY');
    if (files.length > this.limits.maxAttachmentsPerMessage) {
      throw attachmentError('TOO_MANY_ATTACHMENTS');
    }
    const ownedConversation = this.assertConversationOwner(owner, conversationId);
    const validated = files.map((file) => ({
      ...validateImageFile({
        name: file.name,
        declaredMimeType: file.type,
        buffer: file.buffer,
        limits: this.limits
      }),
      attachmentId: `att_${crypto.randomUUID()}`
    }));
    const actualBytes = validated.reduce((sum, file) => sum + file.byteSize, 0);
    const expiresAt = new Date(this.now().getTime() + this.limits.unboundTtlMs).toISOString();
    const prepared = validated.map((file) => ({
      ...file,
      safeFilename: `${file.attachmentId}.${file.extension}`
    }));
    this.activeOwners.set(owner, (this.activeOwners.get(owner) || 0) + 1);
    let begun = false;
    const writtenReferences = new Set();
    try {
      const result = this.repository.beginUpload({
        userId: owner,
        clientRequestId: requestId,
        dayKey: this.dayKey(),
        reservedBytes: Math.max(Number(reservedBytes) || 0, actualBytes),
        actualBytes,
        dailyLimit: this.limits.dailyUploadBytes,
        conversationId: ownedConversation,
        expiresAt,
        files: prepared
      });
      if (result.replayed) {
        return {
          replayed: true,
          attachments: result.attachments.map(publicAttachment)
        };
      }
      begun = true;
      const completed = [];
      for (const file of prepared) {
        if (this.cancelledOwners.has(owner)) {
          throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
        }
        this.repository.transition(file.attachmentId, ATTACHMENT_STATES.UPLOADED);
        this.repository.transition(file.attachmentId, ATTACHMENT_STATES.VALIDATING);
        const storageReference = this.storage.writeObject({
          attachmentId: file.attachmentId,
          extension: file.extension,
          buffer: file.buffer
        });
        writtenReferences.add(storageReference);
        completed.push(this.repository.transition(
          file.attachmentId,
          ATTACHMENT_STATES.READY,
          { storageReference }
        ));
        safeLog(this.logger, {
          event: 'attachment_upload',
          attachmentRef: digest(file.attachmentId),
          userRef: digest(owner),
          mime: file.mimeType,
          bytes: file.byteSize,
          state: ATTACHMENT_STATES.READY,
          elapsedMs: Date.now() - started
        });
      }
      this.repository.completeBatch(owner, requestId);
      return { replayed: false, attachments: completed.map(publicAttachment) };
    } catch (error) {
      if (begun) {
        for (const reference of writtenReferences) {
          try { this.storage.deleteReference(reference); } catch {}
        }
        for (const row of this.repository.listBatchAttachments(owner, requestId)) {
          if (row.storageReference) {
            try { this.storage.deleteReference(row.storageReference); } catch {}
          }
          if (![ATTACHMENT_STATES.FAILED, ATTACHMENT_STATES.REJECTED].includes(row.processingState)) {
            try {
              this.repository.transition(row.attachmentId, ATTACHMENT_STATES.FAILED, {
                failureCode: error?.code || 'UPLOAD_FAILED'
              });
            } catch {}
          }
        }
        try { this.repository.failBatch(owner, requestId, error?.code || 'UPLOAD_FAILED'); } catch {}
      }
      safeLog(this.logger, {
        event: 'attachment_upload',
        userRef: digest(owner),
        code: String(error?.code || 'UPLOAD_FAILED'),
        state: ATTACHMENT_STATES.FAILED,
        elapsedMs: Date.now() - started
      });
      if (error?.code) throw error;
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503, cause: error });
    } finally {
      const remaining = Math.max(0, (this.activeOwners.get(owner) || 1) - 1);
      if (remaining) this.activeOwners.set(owner, remaining);
      else this.activeOwners.delete(owner);
    }
  }

  get(userId, attachmentId) {
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    const id = required(attachmentId, 'ATTACHMENT_NOT_FOUND');
    const row = storeCall(() => this.repository.getAny(id));
    if (!row) {
      const tombstone = storeCall(() => this.repository.findTombstone(id));
      if (tombstone) throw attachmentError('ATTACHMENT_DELETED', { status: 410 });
      throw attachmentError('ATTACHMENT_NOT_FOUND', { status: 404 });
    }
    if (row.userId !== owner) throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
    if (row.processingState === ATTACHMENT_STATES.EXPIRED) {
      throw attachmentError('ATTACHMENT_EXPIRED', { status: 410 });
    }
    if (row.processingState === ATTACHMENT_STATES.DELETED) {
      throw attachmentError('ATTACHMENT_DELETED', { status: 410 });
    }
    return row;
  }

  delete(userId, attachmentId) {
    const row = this.get(userId, attachmentId);
    this.processingService?.deleteDerivedForAttachment?.(row.attachmentId);
    for (const reference of [
      row.storageReference,
      row.extractedTextReference,
      row.structuredContentReference
    ]) {
      this.storage.deleteReference(reference);
    }
    this.repository.removeWithTombstone(row.attachmentId, 'deleted');
    safeLog(this.logger, {
      event: 'attachment_delete',
      attachmentRef: digest(row.attachmentId),
      userRef: digest(userId),
      state: ATTACHMENT_STATES.DELETED,
      code: 'ATTACHMENT_DELETED'
    });
    return true;
  }

  bindAttachmentToMessage({
    userId,
    conversationId,
    messageId,
    attachmentIds
  } = {}) {
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    const conversation = this.assertConversationOwner(owner, conversationId);
    const messages = this.conversationRuntime?.messages?.listForConversationOwner?.(
      conversation,
      owner
    ) || [];
    if (!messages.some((message) => message.id === messageId)) {
      throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
    }
    if (!Array.isArray(attachmentIds) ||
        attachmentIds.length === 0 ||
        attachmentIds.length > this.limits.maxAttachmentsPerMessage) {
      throw attachmentError('TOO_MANY_ATTACHMENTS');
    }
    return this.repository.bindToMessage({
      userId: owner,
      conversationId: conversation,
      messageId,
      attachmentIds: [...new Set(attachmentIds)],
      maxAttachments: this.limits.maxAttachmentsPerMessage
    });
  }

  cleanupExpired() {
    const now = this.now();
    let expired = 0;
    let failed = 0;
    for (const row of this.repository.listExpired(now.toISOString())) {
      try {
        for (const reference of [
          row.storageReference,
          row.extractedTextReference,
          row.structuredContentReference
        ]) {
          this.storage.deleteReference(reference);
        }
        this.repository.clearStorageReference(row.attachmentId);
        this.repository.transition(row.attachmentId, ATTACHMENT_STATES.EXPIRED);
        expired += 1;
      } catch {
        failed += 1;
        try {
          this.repository.transition(row.attachmentId, ATTACHMENT_STATES.FAILED, {
            failureCode: 'ATTACHMENT_STORE_UNAVAILABLE'
          });
        } catch {}
      }
    }
    let temporary = 0;
    try {
      temporary = this.storage.cleanupTemporaryFiles({
        beforeMs: now.getTime() - this.limits.unboundTtlMs
      });
    } catch {
      failed += 1;
    }
    return { expired, temporary, failed };
  }

  exportOwner(userId) {
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    return this.repository.exportMetadataForOwner(owner).map((row) => {
      const safe = publicAttachment(row);
      const originalFile = row.storageReference
        ? {
            filename: row.safeFilename,
            mimeType: row.mimeType,
            byteSize: row.byteSize,
            encoding: 'base64',
            data: this.storage.readObject(row.storageReference).toString('base64')
          }
        : null;
      const derived = [];
      for (const [type, reference] of [
        ['extracted_text', row.extractedTextReference],
        ['structured_content', row.structuredContentReference]
      ]) {
        if (reference) {
          derived.push({
            type,
            encoding: 'base64',
            data: this.storage.readObject(reference).toString('base64')
          });
        }
      }
      return {
        ...safe,
        originalFile,
        derivedResults: derived,
        processingResults: this.processingService?.exportProcessingForAttachment?.(
          row.attachmentId
        ) || []
      };
    });
  }

  cancelAllForOwner(userId) {
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    this.cancelledOwners.add(owner);
    return this.activeOwners.get(owner) || 0;
  }

  deleteAllForOwner(userId) {
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    this.cancelAllForOwner(owner);
    this.processingService?.deleteAllProcessingForOwner?.(owner);
    const rows = this.repository.exportMetadataForOwner(owner);
    for (const row of rows) {
      for (const reference of [
        row.storageReference,
        row.extractedTextReference,
        row.structuredContentReference
      ]) {
        this.storage.deleteReference(reference);
      }
    }
    const deleted = this.repository.deleteOwnerRecords(owner);
    return { deleted };
  }

  verifyOwnerDeleted(userId) {
    return this.repository.verifyOwnerDeleted(userId) &&
      (this.repository.verifyProcessingOwnerDeleted?.(userId) ?? true);
  }
}
