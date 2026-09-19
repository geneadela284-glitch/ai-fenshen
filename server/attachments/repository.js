import crypto from 'node:crypto';

import {
  ATTACHMENT_STATES,
  attachmentError
} from './contract.js';

const TRANSITIONS = Object.freeze({
  [ATTACHMENT_STATES.UPLOADING]: new Set([
    ATTACHMENT_STATES.UPLOADED,
    ATTACHMENT_STATES.REJECTED,
    ATTACHMENT_STATES.FAILED
  ]),
  [ATTACHMENT_STATES.UPLOADED]: new Set([
    ATTACHMENT_STATES.VALIDATING,
    ATTACHMENT_STATES.REJECTED,
    ATTACHMENT_STATES.FAILED
  ]),
  [ATTACHMENT_STATES.VALIDATING]: new Set([
    ATTACHMENT_STATES.READY,
    ATTACHMENT_STATES.REJECTED,
    ATTACHMENT_STATES.FAILED
  ]),
  [ATTACHMENT_STATES.READY]: new Set([
    ATTACHMENT_STATES.PROCESSING,
    ATTACHMENT_STATES.EXPIRED,
    ATTACHMENT_STATES.DELETED,
    ATTACHMENT_STATES.FAILED
  ]),
  [ATTACHMENT_STATES.PROCESSING]: new Set([
    ATTACHMENT_STATES.READY,
    ATTACHMENT_STATES.FAILED,
    ATTACHMENT_STATES.DELETED
  ]),
  [ATTACHMENT_STATES.REJECTED]: new Set([ATTACHMENT_STATES.DELETED]),
  [ATTACHMENT_STATES.FAILED]: new Set([
    ATTACHMENT_STATES.EXPIRED,
    ATTACHMENT_STATES.DELETED
  ]),
  [ATTACHMENT_STATES.EXPIRED]: new Set([ATTACHMENT_STATES.DELETED]),
  [ATTACHMENT_STATES.DELETED]: new Set()
});

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw attachmentError(code);
  return normalized;
}

function rowAttachment(row = null) {
  if (!row) return null;
  return {
    attachmentId: row.attachment_id,
    userId: row.user_id,
    conversationId: row.conversation_id || null,
    messageId: row.message_id || null,
    originalFilename: row.original_filename,
    safeFilename: row.safe_filename,
    declaredMimeType: row.declared_mime_type,
    mimeType: row.mime_type,
    mediaKind: row.media_kind,
    byteSize: row.byte_size,
    width: row.width,
    height: row.height,
    checksumSha256: row.checksum_sha256,
    storageReference: row.storage_reference || null,
    processingState: row.processing_state_v2 || row.processing_state,
    parserType: row.parser_type || null,
    extractedTextReference: row.extracted_text_reference || null,
    structuredContentReference: row.structured_content_reference || null,
    clientRequestId: row.client_request_id,
    ordinal: row.ordinal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at || null,
    deletedAt: row.deleted_at || null,
    failureCode: row.failure_code || null
  };
}

function rowBatch(row = null) {
  if (!row) return null;
  return {
    userId: row.user_id,
    clientRequestId: row.client_request_id,
    dayKey: row.day_key,
    reservedBytes: row.reserved_bytes,
    actualBytes: row.actual_bytes,
    status: row.status,
    failureCode: row.failure_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function attachmentRef(attachmentId) {
  return crypto.createHash('sha256')
    .update(`attachment:${required(attachmentId, 'ATTACHMENT_NOT_FOUND')}`)
    .digest('hex');
}

export class AttachmentRepository {
  constructor({ database, clock = () => new Date() } = {}) {
    this.database = database;
    this.clock = clock;
  }

  nowIso() {
    const value = new Date(this.clock());
    if (!Number.isFinite(value.getTime())) {
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 });
    }
    return value.toISOString();
  }

  transaction(callback) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.database.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  findBatch(userId, clientRequestId) {
    return rowBatch(this.database.prepare(`
      SELECT * FROM attachment_upload_batches
      WHERE user_id = ? AND client_request_id = ?
    `).get(
      required(userId, 'ATTACHMENT_FORBIDDEN'),
      required(clientRequestId, 'UPLOAD_FAILED')
    ));
  }

  listBatchAttachments(userId, clientRequestId) {
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE user_id = ? AND client_request_id = ?
      ORDER BY ordinal ASC
    `).all(
      required(userId, 'ATTACHMENT_FORBIDDEN'),
      required(clientRequestId, 'UPLOAD_FAILED')
    ).map(rowAttachment);
  }

  currentDailyBytes(userId, dayKey) {
    const row = this.database.prepare(`
      SELECT uploaded_bytes FROM attachment_daily_usage
      WHERE user_id = ? AND day_key = ?
    `).get(required(userId, 'ATTACHMENT_FORBIDDEN'), required(dayKey, 'UPLOAD_FAILED'));
    return Number(row?.uploaded_bytes || 0);
  }

  beginUpload({
    userId,
    clientRequestId,
    dayKey,
    reservedBytes,
    actualBytes,
    dailyLimit,
    conversationId,
    expiresAt,
    files
  } = {}) {
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    const requestId = required(clientRequestId, 'UPLOAD_FAILED');
    const at = this.nowIso();
    return this.transaction(() => {
      const existing = this.findBatch(owner, requestId);
      if (existing) {
        return {
          replayed: true,
          batch: existing,
          attachments: this.listBatchAttachments(owner, requestId)
        };
      }
      const used = this.currentDailyBytes(owner, dayKey);
      if (used + actualBytes > dailyLimit) {
        throw attachmentError('DAILY_UPLOAD_LIMIT_EXCEEDED', { status: 429 });
      }
      this.database.prepare(`
        INSERT INTO attachment_daily_usage (
          user_id, day_key, uploaded_bytes, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, day_key) DO UPDATE SET
          uploaded_bytes = uploaded_bytes + excluded.uploaded_bytes,
          updated_at = excluded.updated_at
      `).run(owner, dayKey, actualBytes, at);
      this.database.prepare(`
        INSERT INTO attachment_upload_batches (
          user_id, client_request_id, day_key, reserved_bytes,
          actual_bytes, status, failure_code, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'uploading', NULL, ?, ?)
      `).run(owner, requestId, dayKey, reservedBytes, actualBytes, at, at);
      const insertAttachment = this.database.prepare(`
        INSERT INTO attachments (
          attachment_id, user_id, conversation_id, message_id,
          original_filename, safe_filename, declared_mime_type, mime_type,
          media_kind, byte_size, width, height, checksum_sha256,
          storage_reference, processing_state, parser_type,
          extracted_text_reference, structured_content_reference,
          client_request_id, ordinal, created_at, updated_at,
          expires_at, deleted_at, failure_code
        ) VALUES (
          ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          NULL, 'uploading', NULL, NULL, NULL,
          ?, ?, ?, ?, ?, NULL, NULL
        )
      `);
      const insertEvent = this.database.prepare(`
        INSERT INTO attachment_state_events (attachment_id, state, error_code, created_at)
        VALUES (?, 'uploading', NULL, ?)
      `);
      for (const [ordinal, file] of files.entries()) {
        insertAttachment.run(
          file.attachmentId,
          owner,
          conversationId || null,
          file.originalFilename,
          file.safeFilename,
          file.declaredMimeType,
          file.mimeType,
          file.mediaKind,
          file.byteSize,
          file.width,
          file.height,
          file.checksumSha256,
          requestId,
          ordinal,
          at,
          at,
          expiresAt
        );
        insertEvent.run(file.attachmentId, at);
      }
      return {
        replayed: false,
        batch: this.findBatch(owner, requestId),
        attachments: this.listBatchAttachments(owner, requestId)
      };
    });
  }

  getAny(attachmentId) {
    return rowAttachment(this.database.prepare(
      'SELECT * FROM attachments WHERE attachment_id = ?'
    ).get(required(attachmentId, 'ATTACHMENT_NOT_FOUND')));
  }

  getForOwner(userId, attachmentId) {
    return rowAttachment(this.database.prepare(`
      SELECT * FROM attachments WHERE user_id = ? AND attachment_id = ?
    `).get(
      required(userId, 'ATTACHMENT_FORBIDDEN'),
      required(attachmentId, 'ATTACHMENT_NOT_FOUND')
    ));
  }

  listForMessageOwner(userId, conversationId, messageId) {
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE user_id = ? AND conversation_id = ? AND message_id = ?
        AND COALESCE(processing_state_v2, processing_state) != 'deleted'
      ORDER BY ordinal ASC, created_at ASC, attachment_id ASC
    `).all(
      required(userId, 'ATTACHMENT_FORBIDDEN'),
      required(conversationId, 'ATTACHMENT_FORBIDDEN'),
      required(messageId, 'ATTACHMENT_NOT_FOUND')
    ).map(rowAttachment);
  }

  findTombstone(attachmentId) {
    return this.database.prepare(`
      SELECT receipt_id AS receiptId, final_state AS finalState, created_at AS createdAt
      FROM attachment_tombstones WHERE attachment_ref = ?
    `).get(attachmentRef(attachmentId)) || null;
  }

  transition(attachmentId, nextState, {
    storageReference,
    failureCode = null,
    deletedAt
  } = {}) {
    return this.transaction(() => {
      const current = this.getAny(attachmentId);
      if (!current || !TRANSITIONS[current.processingState]?.has(nextState)) {
        throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 });
      }
      const at = this.nowIso();
      this.database.prepare(`
        UPDATE attachments SET
          processing_state = ?,
          storage_reference = CASE WHEN ? IS NULL THEN storage_reference ELSE ? END,
          failure_code = ?,
          deleted_at = COALESCE(?, deleted_at),
          updated_at = ?
        WHERE attachment_id = ?
      `).run(
        nextState,
        storageReference === undefined ? null : 'provided',
        storageReference ?? null,
        failureCode,
        deletedAt || null,
        at,
        current.attachmentId
      );
      this.database.prepare(`
        INSERT INTO attachment_state_events (attachment_id, state, error_code, created_at)
        VALUES (?, ?, ?, ?)
      `).run(current.attachmentId, nextState, failureCode, at);
      return this.getAny(current.attachmentId);
    });
  }

  clearStorageReference(attachmentId) {
    this.database.prepare(`
      UPDATE attachments SET storage_reference = NULL, updated_at = ?
      WHERE attachment_id = ?
    `).run(this.nowIso(), required(attachmentId, 'ATTACHMENT_NOT_FOUND'));
  }

  completeBatch(userId, clientRequestId) {
    const at = this.nowIso();
    this.database.prepare(`
      UPDATE attachment_upload_batches
      SET status = 'completed', failure_code = NULL, updated_at = ?
      WHERE user_id = ? AND client_request_id = ?
    `).run(at, required(userId, 'ATTACHMENT_FORBIDDEN'), required(clientRequestId, 'UPLOAD_FAILED'));
  }

  failBatch(userId, clientRequestId, code) {
    const at = this.nowIso();
    this.database.prepare(`
      UPDATE attachment_upload_batches
      SET status = 'failed', failure_code = ?, updated_at = ?
      WHERE user_id = ? AND client_request_id = ?
    `).run(
      String(code || 'UPLOAD_FAILED').slice(0, 80),
      at,
      required(userId, 'ATTACHMENT_FORBIDDEN'),
      required(clientRequestId, 'UPLOAD_FAILED')
    );
  }

  listStateHistory(attachmentId) {
    return this.database.prepare(`
      SELECT state FROM attachment_state_events
      WHERE attachment_id = ? ORDER BY id ASC
    `).all(required(attachmentId, 'ATTACHMENT_NOT_FOUND')).map((row) => row.state);
  }

  exportMetadataForOwner(userId) {
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE user_id = ?
      ORDER BY created_at ASC, ordinal ASC, attachment_id ASC
    `).all(required(userId, 'ATTACHMENT_FORBIDDEN')).map(rowAttachment);
  }

  bindToMessage({
    userId,
    conversationId,
    messageId,
    attachmentIds,
    maxAttachments
  } = {}) {
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    const at = this.nowIso();
    return this.transaction(() => {
      const currentCount = Number(this.database.prepare(`
        SELECT COUNT(*) AS count FROM attachments
        WHERE user_id = ? AND conversation_id = ? AND message_id = ?
          AND COALESCE(processing_state_v2, processing_state) NOT IN ('expired', 'deleted')
      `).get(owner, conversationId, messageId).count);
      const newIds = [...new Set(attachmentIds)];
      const attachments = newIds.map((id) => this.getForOwner(owner, id));
      const newlyBoundCount = attachments.filter((attachment) =>
        attachment?.messageId !== messageId
      ).length;
      if (currentCount + newlyBoundCount > maxAttachments) {
        throw attachmentError('TOO_MANY_ATTACHMENTS');
      }
      const result = [];
      for (const [index, id] of newIds.entries()) {
        const attachment = attachments[index];
        if (!attachment ||
            (attachment.conversationId && attachment.conversationId !== conversationId) ||
            ![
              ATTACHMENT_STATES.READY,
              'processing_ocr',
              'processing_vision',
              'merging_evidence',
              'processed',
              'processed_partial'
            ].includes(attachment.processingState)) {
          throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
        }
        this.database.prepare(`
          UPDATE attachments SET conversation_id = ?, message_id = ?,
            expires_at = NULL, updated_at = ?
          WHERE user_id = ? AND attachment_id = ?
        `).run(conversationId, messageId, at, owner, id);
        result.push(this.getForOwner(owner, id));
      }
      return result;
    });
  }

  listExpired(nowIso) {
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE message_id IS NULL
        AND expires_at IS NOT NULL
        AND expires_at <= ?
        AND (
          processing_state = 'ready_for_processing'
          OR (processing_state = 'failed' AND failure_code = 'ATTACHMENT_STORE_UNAVAILABLE')
        )
      ORDER BY expires_at ASC, attachment_id ASC
    `).all(nowIso).map(rowAttachment);
  }

  removeWithTombstone(attachmentId, finalState = 'deleted') {
    const id = required(attachmentId, 'ATTACHMENT_NOT_FOUND');
    const at = this.nowIso();
    return this.transaction(() => {
      const current = this.getAny(id);
      if (!current) return false;
      this.database.prepare(`
        INSERT OR IGNORE INTO attachment_tombstones (
          receipt_id, attachment_ref, final_state, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(`att_del_${crypto.randomUUID()}`, attachmentRef(id), finalState, at);
      this.database.prepare('DELETE FROM attachments WHERE attachment_id = ?').run(id);
      return true;
    });
  }

  deleteOwnerRecords(userId) {
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    const at = this.nowIso();
    return this.transaction(() => {
      const rows = this.exportMetadataForOwner(owner);
      const insert = this.database.prepare(`
        INSERT OR IGNORE INTO attachment_tombstones (
          receipt_id, attachment_ref, final_state, created_at
        ) VALUES (?, ?, 'account_deleted', ?)
      `);
      for (const row of rows) {
        insert.run(`att_del_${crypto.randomUUID()}`, attachmentRef(row.attachmentId), at);
      }
      this.database.prepare('DELETE FROM attachments WHERE user_id = ?').run(owner);
      this.database.prepare('DELETE FROM attachment_upload_batches WHERE user_id = ?').run(owner);
      this.database.prepare('DELETE FROM attachment_daily_usage WHERE user_id = ?').run(owner);
      return rows.length;
    });
  }

  verifyOwnerDeleted(userId) {
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    const counts = [
      this.database.prepare('SELECT COUNT(*) AS count FROM attachments WHERE user_id = ?').get(owner).count,
      this.database.prepare('SELECT COUNT(*) AS count FROM attachment_upload_batches WHERE user_id = ?').get(owner).count,
      this.database.prepare('SELECT COUNT(*) AS count FROM attachment_daily_usage WHERE user_id = ?').get(owner).count
    ];
    return counts.every((value) => Number(value) === 0);
  }

  listTombstones() {
    return this.database.prepare(`
      SELECT receipt_id AS receiptId, attachment_ref AS attachmentRef,
        final_state AS finalState, created_at AS createdAt
      FROM attachment_tombstones ORDER BY created_at ASC, receipt_id ASC
    `).all();
  }

  setProcessingState(attachmentId, state, failureCode = null) {
    const id = required(attachmentId, 'ATTACHMENT_NOT_FOUND');
    const at = this.nowIso();
    this.database.prepare(`
      UPDATE attachments
      SET processing_state_v2 = ?, failure_code = ?, updated_at = ?
      WHERE attachment_id = ?
    `).run(required(state, 'ATTACHMENT_STORE_UNAVAILABLE'), failureCode, at, id);
    this.database.prepare(`
      INSERT INTO attachment_state_events (attachment_id, state, error_code, created_at)
      VALUES (?, ?, ?, ?)
    `).run(id, state, failureCode, at);
    return this.getAny(id);
  }

  beginProcessingJob({
    processingId: suppliedProcessingId,
    userId,
    conversationId,
    messageId,
    attachmentIds,
    userQuestionReference,
    clientRequestId,
    processingVersion
  } = {}) {
    const owner = required(userId, 'ATTACHMENT_FORBIDDEN');
    const request = required(clientRequestId, 'CLIENT_REQUEST_ID_INVALID');
    const ids = [...new Set((attachmentIds || []).map(String))];
    const setHash = crypto.createHash('sha256').update(ids.join('\u0000')).digest('hex');
    const at = this.nowIso();
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT * FROM attachment_processing_jobs
        WHERE user_id = ? AND client_request_id = ?
      `).get(owner, request);
      if (existing) {
        if (existing.conversation_id !== conversationId ||
            existing.message_id !== messageId ||
            existing.attachment_set_hash !== setHash ||
            existing.processing_version !== processingVersion) {
          throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
        }
        return this.rowProcessingJob(existing);
      }
      const processingId = suppliedProcessingId || `proc_${crypto.randomUUID()}`;
      this.database.prepare(`
        INSERT INTO attachment_processing_jobs (
          processing_id, user_id, conversation_id, message_id,
          client_request_id, processing_version, attachment_set_hash,
          user_question_reference, answer_reference, state, answer_mode,
          error_code, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'created', NULL, NULL, ?, ?, NULL)
      `).run(
        processingId,
        owner,
        required(conversationId, 'ATTACHMENT_FORBIDDEN'),
        required(messageId, 'ATTACHMENT_FORBIDDEN'),
        request,
        required(processingVersion, 'ATTACHMENT_STORE_UNAVAILABLE'),
        setHash,
        required(userQuestionReference, 'ATTACHMENT_STORE_UNAVAILABLE'),
        at,
        at
      );
      const insertItem = this.database.prepare(`
        INSERT INTO attachment_processing_job_items (
          processing_id, attachment_id, ordinal
        ) VALUES (?, ?, ?)
      `);
      ids.forEach((id, ordinal) => insertItem.run(processingId, id, ordinal));
      return this.getProcessingJob(processingId);
    });
  }

  rowProcessingJob(row = null) {
    if (!row) return null;
    return {
      processingId: row.processing_id,
      userId: row.user_id,
      conversationId: row.conversation_id,
      messageId: row.message_id,
      clientRequestId: row.client_request_id,
      processingVersion: row.processing_version,
      attachmentSetHash: row.attachment_set_hash,
      userQuestionReference: row.user_question_reference,
      answerReference: row.answer_reference || null,
      state: row.state,
      answerMode: row.answer_mode || null,
      errorCode: row.error_code || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at || null
    };
  }

  getProcessingJob(processingId) {
    return this.rowProcessingJob(this.database.prepare(`
      SELECT * FROM attachment_processing_jobs WHERE processing_id = ?
    `).get(String(processingId || '')));
  }

  findProcessingJob(userId, clientRequestId) {
    return this.rowProcessingJob(this.database.prepare(`
      SELECT * FROM attachment_processing_jobs
      WHERE user_id = ? AND client_request_id = ?
    `).get(
      required(userId, 'ATTACHMENT_FORBIDDEN'),
      required(clientRequestId, 'CLIENT_REQUEST_ID_INVALID')
    ));
  }

  listProcessingJobsForOwner(userId) {
    return this.database.prepare(`
      SELECT * FROM attachment_processing_jobs
      WHERE user_id = ? ORDER BY created_at, processing_id
    `).all(required(userId, 'ATTACHMENT_FORBIDDEN')).map((row) => this.rowProcessingJob(row));
  }

  listProcessingItems(processingId) {
    return this.database.prepare(`
      SELECT attachment_id AS attachmentId, ordinal
      FROM attachment_processing_job_items
      WHERE processing_id = ? ORDER BY ordinal
    `).all(String(processingId || ''));
  }

  updateProcessingJob(processingId, {
    state,
    answerReference,
    answerMode,
    errorCode = null,
    completed = false
  } = {}) {
    const at = this.nowIso();
    this.database.prepare(`
      UPDATE attachment_processing_jobs SET
        state = COALESCE(?, state),
        answer_reference = COALESCE(?, answer_reference),
        answer_mode = COALESCE(?, answer_mode),
        error_code = ?,
        updated_at = ?,
        completed_at = CASE WHEN ? THEN ? ELSE completed_at END
      WHERE processing_id = ?
    `).run(
      state || null,
      answerReference || null,
      answerMode || null,
      errorCode,
      at,
      completed ? 1 : 0,
      at,
      String(processingId || '')
    );
    return this.getProcessingJob(processingId);
  }

  restartFailedProcessingJob(processingId) {
    const id = String(processingId || '');
    return this.transaction(() => {
      const current = this.getProcessingJob(id);
      if (!current || current.state !== 'processing_failed') {
        throw attachmentError('ATTACHMENT_PROCESSING_FAILED', { status: 409 });
      }
      this.database.prepare(`
        DELETE FROM attachment_processing_steps
        WHERE processing_id = ? AND status = 'failed'
      `).run(id);
      this.database.prepare(`
        UPDATE attachment_processing_jobs
        SET state = 'created', error_code = NULL, completed_at = NULL, updated_at = ?
        WHERE processing_id = ?
      `).run(this.nowIso(), id);
      return this.getProcessingJob(id);
    });
  }

  beginProcessingStep({
    processingId,
    stepKey,
    callType,
    attachmentId = null,
    requestId,
    executionId,
    attemptId
  } = {}) {
    const existing = this.getProcessingStep(processingId, stepKey);
    if (existing) return existing;
    const at = this.nowIso();
    this.database.prepare(`
      INSERT INTO attachment_processing_steps (
        processing_id, step_key, call_type, attachment_id, status,
        request_id, execution_id, attempt_id, result_reference,
        usage_json, error_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'in_flight', ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      String(processingId || ''),
      required(stepKey, 'ATTACHMENT_STORE_UNAVAILABLE'),
      required(callType, 'ATTACHMENT_STORE_UNAVAILABLE'),
      attachmentId || null,
      required(requestId, 'ATTACHMENT_STORE_UNAVAILABLE'),
      required(executionId, 'ATTACHMENT_STORE_UNAVAILABLE'),
      required(attemptId, 'ATTACHMENT_STORE_UNAVAILABLE'),
      at,
      at
    );
    return this.getProcessingStep(processingId, stepKey);
  }

  getProcessingStep(processingId, stepKey) {
    const row = this.database.prepare(`
      SELECT * FROM attachment_processing_steps
      WHERE processing_id = ? AND step_key = ?
    `).get(String(processingId || ''), String(stepKey || ''));
    return row ? {
      processingId: row.processing_id,
      stepKey: row.step_key,
      callType: row.call_type,
      attachmentId: row.attachment_id || null,
      status: row.status,
      requestId: row.request_id,
      executionId: row.execution_id,
      attemptId: row.attempt_id,
      resultReference: row.result_reference || null,
      usage: row.usage_json ? JSON.parse(row.usage_json) : null,
      errorCode: row.error_code || null
    } : null;
  }

  completeProcessingStep(processingId, stepKey, {
    resultReference,
    usage = null
  } = {}) {
    this.database.prepare(`
      UPDATE attachment_processing_steps
      SET status = 'completed', result_reference = ?, usage_json = ?,
        error_code = NULL, updated_at = ?
      WHERE processing_id = ? AND step_key = ?
    `).run(
      resultReference || null,
      usage ? JSON.stringify(usage) : null,
      this.nowIso(),
      processingId,
      stepKey
    );
    return this.getProcessingStep(processingId, stepKey);
  }

  failProcessingStep(processingId, stepKey, errorCode, status = 'failed') {
    this.database.prepare(`
      UPDATE attachment_processing_steps
      SET status = ?, error_code = ?, updated_at = ?
      WHERE processing_id = ? AND step_key = ?
    `).run(status, String(errorCode || 'ATTACHMENT_PROCESSING_FAILED'), this.nowIso(), processingId, stepKey);
  }

  saveOcrResult({
    processingId,
    attachmentId,
    model,
    resultReference,
    usage
  } = {}) {
    this.database.prepare(`
      INSERT INTO attachment_ocr_results (
        processing_id, attachment_id, ocr_model, result_reference,
        usage_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(processing_id, attachment_id) DO UPDATE SET
        ocr_model = excluded.ocr_model,
        result_reference = excluded.result_reference,
        usage_json = excluded.usage_json
    `).run(processingId, attachmentId, model, resultReference,
      usage ? JSON.stringify(usage) : null, this.nowIso());
  }

  getOcrResult(processingId, attachmentId) {
    const row = this.database.prepare(`
      SELECT * FROM attachment_ocr_results
      WHERE processing_id = ? AND attachment_id = ?
    `).get(processingId, attachmentId);
    return row ? {
      processingId: row.processing_id,
      attachmentId: row.attachment_id,
      model: row.ocr_model,
      resultReference: row.result_reference,
      usage: row.usage_json ? JSON.parse(row.usage_json) : null
    } : null;
  }

  listOcrResults(processingId) {
    return this.listProcessingItems(processingId).flatMap(({ attachmentId }) => {
      const result = this.getOcrResult(processingId, attachmentId);
      return result ? [result] : [];
    });
  }

  saveVisionResult({
    processingId,
    attachmentSetHash,
    model,
    resultReference,
    usage
  } = {}) {
    this.database.prepare(`
      INSERT INTO attachment_vision_results (
        processing_id, attachment_set_hash, vision_model, result_reference,
        usage_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(processing_id) DO UPDATE SET
        attachment_set_hash = excluded.attachment_set_hash,
        vision_model = excluded.vision_model,
        result_reference = excluded.result_reference,
        usage_json = excluded.usage_json
    `).run(processingId, attachmentSetHash, model, resultReference,
      usage ? JSON.stringify(usage) : null, this.nowIso());
  }

  getVisionResult(processingId) {
    const row = this.database.prepare(`
      SELECT * FROM attachment_vision_results WHERE processing_id = ?
    `).get(processingId);
    return row ? {
      processingId: row.processing_id,
      model: row.vision_model,
      resultReference: row.result_reference,
      usage: row.usage_json ? JSON.parse(row.usage_json) : null
    } : null;
  }

  saveEvidenceResult({ processingId, answerMode, resultReference } = {}) {
    this.database.prepare(`
      INSERT INTO attachment_evidence_results (
        processing_id, answer_mode, result_reference, created_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(processing_id) DO UPDATE SET
        answer_mode = excluded.answer_mode,
        result_reference = excluded.result_reference
    `).run(processingId, answerMode, resultReference, this.nowIso());
  }

  getEvidenceResult(processingId) {
    const row = this.database.prepare(`
      SELECT * FROM attachment_evidence_results WHERE processing_id = ?
    `).get(processingId);
    return row ? {
      processingId: row.processing_id,
      answerMode: row.answer_mode,
      resultReference: row.result_reference
    } : null;
  }

  listDerivedReferencesForAttachment(attachmentId) {
    const rows = this.database.prepare(`
      SELECT DISTINCT reference FROM (
        SELECT o.result_reference AS reference
        FROM attachment_ocr_results o
        WHERE o.attachment_id = ?
        UNION ALL
        SELECT v.result_reference AS reference
        FROM attachment_vision_results v
        JOIN attachment_processing_job_items i ON i.processing_id = v.processing_id
        WHERE i.attachment_id = ?
        UNION ALL
        SELECT e.result_reference AS reference
        FROM attachment_evidence_results e
        JOIN attachment_processing_job_items i ON i.processing_id = e.processing_id
        WHERE i.attachment_id = ?
        UNION ALL
        SELECT j.user_question_reference AS reference
        FROM attachment_processing_jobs j
        JOIN attachment_processing_job_items i ON i.processing_id = j.processing_id
        WHERE i.attachment_id = ?
        UNION ALL
        SELECT j.answer_reference AS reference
        FROM attachment_processing_jobs j
        JOIN attachment_processing_job_items i ON i.processing_id = j.processing_id
        WHERE i.attachment_id = ? AND j.answer_reference IS NOT NULL
      )
      WHERE reference IS NOT NULL
    `).all(attachmentId, attachmentId, attachmentId, attachmentId, attachmentId);
    return rows.map((row) => row.reference);
  }

  processingIdsForAttachment(attachmentId) {
    return this.database.prepare(`
      SELECT processing_id AS processingId
      FROM attachment_processing_job_items WHERE attachment_id = ?
    `).all(attachmentId).map((row) => row.processingId);
  }

  deleteProcessingJob(processingId) {
    return this.transaction(() => {
      for (const table of [
        'attachment_evidence_results',
        'attachment_vision_results',
        'attachment_ocr_results',
        'attachment_processing_steps',
        'attachment_processing_job_items',
        'attachment_processing_jobs'
      ]) {
        this.database.prepare(`DELETE FROM ${table} WHERE processing_id = ?`).run(processingId);
      }
      return true;
    });
  }

  deleteProcessingForOwner(userId) {
    const jobs = this.listProcessingJobsForOwner(userId);
    jobs.forEach((job) => this.deleteProcessingJob(job.processingId));
    return jobs.length;
  }

  verifyProcessingOwnerDeleted(userId) {
    return Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM attachment_processing_jobs WHERE user_id = ?
    `).get(required(userId, 'ATTACHMENT_FORBIDDEN')).count) === 0;
  }

  recoverInterruptedProcessing() {
    const rows = this.database.prepare(`
      SELECT DISTINCT processing_id FROM attachment_processing_steps
      WHERE status = 'in_flight'
    `).all();
    const at = this.nowIso();
    for (const { processing_id: processingId } of rows) {
      this.database.prepare(`
        UPDATE attachment_processing_steps
        SET status = 'interrupted', error_code = 'ATTACHMENT_PROCESSING_INTERRUPTED',
          updated_at = ?
        WHERE processing_id = ? AND status = 'in_flight'
      `).run(at, processingId);
      this.updateProcessingJob(processingId, {
        state: 'processing_failed',
        errorCode: 'ATTACHMENT_PROCESSING_INTERRUPTED',
        completed: true
      });
      for (const { attachmentId } of this.listProcessingItems(processingId)) {
        if (this.getAny(attachmentId)) {
          this.setProcessingState(
            attachmentId,
            'processing_failed',
            'ATTACHMENT_PROCESSING_INTERRUPTED'
          );
        }
      }
    }
    return rows.length;
  }
}
