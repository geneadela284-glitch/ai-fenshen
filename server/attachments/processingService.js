import crypto from 'node:crypto';

import {
  ATTACHMENT_PROCESSING_STATES,
  ATTACHMENT_STATES,
  attachmentError
} from './contract.js';
import { createProviderTrace } from './providerExecutor.js';

export const ATTACHMENT_PROCESSING_VERSION = 'image-understanding-a2-v1';

const TERMINAL_STATES = new Set([
  ATTACHMENT_PROCESSING_STATES.PROCESSED,
  ATTACHMENT_PROCESSING_STATES.PARTIAL
]);
const PROCESSABLE_STATES = new Set([
  ATTACHMENT_STATES.READY,
  ATTACHMENT_PROCESSING_STATES.OCR,
  ATTACHMENT_PROCESSING_STATES.VISION,
  ATTACHMENT_PROCESSING_STATES.MERGING
]);
const SENSITIVE = /身份证|护照|银行卡|信用卡|密码|API\s*Key|密钥|助记词/i;
const UNSUPPORTED = /编辑.*图片|图片.*编辑|PDF|Word|Excel|扫描PDF|知识库.*入库/i;
const ACCESS_ERROR_CODES = new Set([
  'ACCOUNT_USAGE_LIMIT_REACHED',
  'ACCOUNT_UPLOAD_LIMIT_REACHED',
  'ACCOUNT_CONCURRENCY_LIMIT_REACHED',
  'ACCOUNT_DISABLED',
  'DAILY_UPLOAD_LIMIT_EXCEEDED',
  'ACCOUNT_CONCURRENCY_LIMITED',
  'ACCOUNT_ACCESS_DISABLED'
]);

function digest(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function safeLog(logger, event) {
  try { logger(event); } catch {}
}

function providerCode(error, fallback) {
  const code = String(error?.code || fallback);
  if (ACCESS_ERROR_CODES.has(code)) return code;
  if (/OCR/.test(code)) return code;
  if (/VISION/.test(code)) return code;
  return fallback;
}

function terminalFailureCode(partialErrors = []) {
  const codes = [...new Set(partialErrors.map((error) => error?.code).filter(Boolean))];
  return codes.length === 1 && ACCESS_ERROR_CODES.has(codes[0])
    ? codes[0]
    : 'ATTACHMENT_PROCESSING_FAILED';
}

export class AttachmentProcessingService {
  constructor({
    repository,
    storage,
    providerExecutor,
    evidenceMerger,
    conversationRuntime,
    logger = () => {}
  } = {}) {
    if (!repository || !storage || !providerExecutor || !evidenceMerger) {
      throw new Error('ATTACHMENT_PROCESSING_UNAVAILABLE');
    }
    this.repository = repository;
    this.storage = storage;
    this.providerExecutor = providerExecutor;
    this.evidenceMerger = evidenceMerger;
    this.conversationRuntime = conversationRuntime;
    this.logger = logger;
  }

  assertMessageOwner(userId, conversationId, messageId) {
    const conversation = this.conversationRuntime?.conversations?.getByIdForOwner?.(
      conversationId,
      userId
    );
    if (!conversation) throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
    const messages = this.conversationRuntime?.messages?.listForConversationOwner?.(
      conversationId,
      userId
    ) || [];
    if (!messages.some((message) => message.id === messageId)) {
      throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
    }
  }

  validateQuestion(userQuestion) {
    const question = String(userQuestion || '').trim();
    if (!question) throw attachmentError('MESSAGE_REQUIRED');
    if (SENSITIVE.test(question)) {
      throw attachmentError('SENSITIVE_ATTACHMENT_PROCESSING_REFUSED', { status: 400 });
    }
    if (UNSUPPORTED.test(question)) {
      throw attachmentError('ATTACHMENT_CAPABILITY_UNSUPPORTED', { status: 400 });
    }
    return question;
  }

  loadCompleted(job) {
    if (!TERMINAL_STATES.has(job?.state) || !job.answerReference) return null;
    return this.storage.readJson(job.answerReference);
  }

  async processAttachmentsForMessage({
    authenticatedUserId,
    conversationId,
    messageId,
    attachmentIds,
    userQuestion,
    clientRequestId,
    retry = false,
    invocation = {}
  } = {}) {
    const owner = String(authenticatedUserId || '').trim();
    if (!owner) throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
    const question = this.validateQuestion(userQuestion);
    const ids = [...new Set((attachmentIds || []).map((id) => String(id || '').trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > 3) throw attachmentError('TOO_MANY_ATTACHMENTS');
    this.assertMessageOwner(owner, conversationId, messageId);

    let existing = this.repository.findProcessingJob(owner, clientRequestId);
    if (existing) {
      const expectedIds = this.repository.listProcessingItems(existing.processingId)
        .map((item) => item.attachmentId);
      if (existing.conversationId !== conversationId ||
          existing.messageId !== messageId ||
          expectedIds.length !== ids.length ||
          expectedIds.some((id, index) => id !== ids[index])) {
        throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
      }
      const storedQuestion = this.storage.readJson(existing.userQuestionReference)?.question;
      if (storedQuestion !== question) {
        throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
      }
      if (existing.errorCode === 'ATTACHMENT_PROCESSING_INTERRUPTED') {
        throw attachmentError('ATTACHMENT_PROCESSING_INTERRUPTED', { status: 409 });
      }
      if (existing.state === ATTACHMENT_PROCESSING_STATES.FAILED) {
        if (retry !== true) {
          throw attachmentError(existing.errorCode || 'ATTACHMENT_PROCESSING_FAILED', {
            status: ACCESS_ERROR_CODES.has(existing.errorCode) ? 429 : 503
          });
        }
        existing = this.repository.restartFailedProcessingJob(existing.processingId);
        ids.forEach((id) => {
          const attachment = this.repository.getAny(id);
          if (attachment?.processingState === ATTACHMENT_PROCESSING_STATES.FAILED) {
            this.repository.setProcessingState(id, ATTACHMENT_PROCESSING_STATES.READY);
          }
        });
      }
      const completed = this.loadCompleted(existing);
      if (completed) return completed;
    }

    const attachments = ids.map((id) => {
      const row = this.repository.getAny(id);
      if (!row) throw attachmentError('ATTACHMENT_NOT_FOUND', { status: 404 });
      if (row.userId !== owner) throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
      if (row.conversationId && row.conversationId !== conversationId) {
        throw attachmentError('ATTACHMENT_FORBIDDEN', { status: 403 });
      }
      if (row.processingState === ATTACHMENT_PROCESSING_STATES.EXPIRED) {
        throw attachmentError('ATTACHMENT_EXPIRED', { status: 410 });
      }
      if (row.processingState === ATTACHMENT_PROCESSING_STATES.DELETED) {
        throw attachmentError('ATTACHMENT_DELETED', { status: 410 });
      }
      if (!PROCESSABLE_STATES.has(row.processingState)) {
        throw attachmentError('ATTACHMENT_NOT_READY', { status: 409 });
      }
      return row;
    });

    const processingId = existing?.processingId || `proc_${crypto.randomUUID()}`;
    const questionReference = existing?.userQuestionReference ||
      `derived/${processingId}/user-question.json`;
    const job = existing || this.repository.beginProcessingJob({
      processingId,
      userId: owner,
      conversationId,
      messageId,
      attachmentIds: ids,
      userQuestionReference: questionReference,
      clientRequestId,
      processingVersion: ATTACHMENT_PROCESSING_VERSION
    });
    if (!existing) {
      const writtenQuestionReference = this.storage.writeDerived({
        processingId,
        kind: 'user-question',
        value: { question }
      });
      if (writtenQuestionReference !== questionReference) {
        throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 });
      }
    }
    if (job.errorCode === 'ATTACHMENT_PROCESSING_INTERRUPTED') {
      throw attachmentError('ATTACHMENT_PROCESSING_INTERRUPTED', { status: 409 });
    }
    this.repository.bindToMessage({
      userId: owner,
      conversationId,
      messageId,
      attachmentIds: ids,
      maxAttachments: 3
    });

    const partialErrors = [];
    const ocrEvidence = [];
    this.repository.updateProcessingJob(processingId, { state: ATTACHMENT_PROCESSING_STATES.OCR });
    attachments.forEach((item) =>
      this.repository.setProcessingState(item.attachmentId, ATTACHMENT_PROCESSING_STATES.OCR)
    );

    for (const attachment of attachments) {
      const stepKey = `ocr:${attachment.attachmentId}`;
      const persisted = this.repository.getOcrResult(processingId, attachment.attachmentId);
      if (persisted) {
        ocrEvidence.push(this.storage.readJson(persisted.resultReference));
        continue;
      }
      const priorStep = this.repository.getProcessingStep(processingId, stepKey);
      if (priorStep?.status === 'interrupted' || priorStep?.status === 'in_flight') {
        throw attachmentError('ATTACHMENT_PROCESSING_INTERRUPTED', { status: 409 });
      }
      if (priorStep?.status === 'failed') {
        partialErrors.push({ type: 'ocr', attachmentId: attachment.attachmentId, code: priorStep.errorCode });
        continue;
      }
      const trace = createProviderTrace({
        requestId: invocation.requestLease?.requestId,
        processingId,
        callType: 'ocr',
        attachmentId: attachment.attachmentId
      });
      this.repository.beginProcessingStep({
        processingId,
        stepKey,
        callType: 'ocr',
        attachmentId: attachment.attachmentId,
        ...trace
      });
      try {
        const result = await this.providerExecutor.runOcr({
          attachment,
          buffer: this.storage.readObject(attachment.storageReference),
          trace,
          invocation
        });
        const stored = {
          attachmentId: attachment.attachmentId,
          ocrModel: result.ocrModel || 'qwen3.5-ocr',
          rawText: String(result.rawText || ''),
          normalizedText: String(result.normalizedText ?? result.rawText ?? ''),
          blocks: Array.isArray(result.blocks) ? result.blocks : [],
          tableRegions: Array.isArray(result.tableRegions) ? result.tableRegions : [],
          detectedLanguage: result.detectedLanguage || 'unknown',
          confidence: result.confidence ?? 'unknown',
          limitations: Array.isArray(result.limitations) ? result.limitations : [],
          usage: result.usage || null,
          createdAt: result.createdAt || new Date().toISOString()
        };
        const resultReference = this.storage.writeDerived({
          processingId,
          kind: `ocr-${attachment.attachmentId}`,
          value: stored
        });
        this.repository.saveOcrResult({
          processingId,
          attachmentId: attachment.attachmentId,
          model: stored.ocrModel,
          resultReference,
          usage: stored.usage
        });
        this.repository.completeProcessingStep(processingId, stepKey, {
          resultReference,
          usage: stored.usage
        });
        ocrEvidence.push(stored);
        safeLog(this.logger, {
          event: 'attachment_processing',
          processingRef: digest(processingId),
          attachmentRef: digest(attachment.attachmentId),
          provider: 'qwen',
          model: 'qwen3.5-ocr',
          callType: 'ocr',
          usage: stored.usage,
          state: 'completed'
        });
      } catch (error) {
        const code = providerCode(error, 'OCR_PROVIDER_UNAVAILABLE');
        this.repository.failProcessingStep(processingId, stepKey, code);
        partialErrors.push({ type: 'ocr', attachmentId: attachment.attachmentId, code });
        safeLog(this.logger, {
          event: 'attachment_processing',
          processingRef: digest(processingId),
          attachmentRef: digest(attachment.attachmentId),
          provider: 'qwen',
          model: 'qwen3.5-ocr',
          callType: 'ocr',
          state: 'failed',
          code
        });
      }
    }

    this.repository.updateProcessingJob(processingId, { state: ATTACHMENT_PROCESSING_STATES.VISION });
    attachments.forEach((item) =>
      this.repository.setProcessingState(item.attachmentId, ATTACHMENT_PROCESSING_STATES.VISION)
    );
    let visionEvidence = null;
    const existingVision = this.repository.getVisionResult(processingId);
    if (existingVision) {
      visionEvidence = this.storage.readJson(existingVision.resultReference);
    } else {
      const stepKey = 'vision:all';
      const priorStep = this.repository.getProcessingStep(processingId, stepKey);
      if (priorStep?.status === 'interrupted' || priorStep?.status === 'in_flight') {
        throw attachmentError('ATTACHMENT_PROCESSING_INTERRUPTED', { status: 409 });
      }
      if (priorStep?.status === 'failed') {
        partialErrors.push({ type: 'vision', code: priorStep.errorCode });
      } else {
        const trace = createProviderTrace({
          requestId: invocation.requestLease?.requestId,
          processingId,
          callType: 'vision'
        });
        this.repository.beginProcessingStep({
          processingId,
          stepKey,
          callType: 'vision',
          ...trace
        });
        try {
          const result = await this.providerExecutor.runVision({
            attachments,
            buffers: attachments.map((item) => this.storage.readObject(item.storageReference)),
            userQuestion: question,
            trace,
            invocation
          });
          visionEvidence = {
            attachmentIds: ids,
            visionModel: result.visionModel || 'qwen3-vl-plus',
            sceneSummary: String(result.sceneSummary || ''),
            objects: Array.isArray(result.objects) ? result.objects : [],
            colors: Array.isArray(result.colors) ? result.colors : [],
            spatialRelations: Array.isArray(result.spatialRelations) ? result.spatialRelations : [],
            layoutSummary: String(result.layoutSummary || ''),
            chartOrDiagramSummary: result.chartOrDiagramSummary ?? null,
            limitations: Array.isArray(result.limitations) ? result.limitations : [],
            usage: result.usage || null,
            createdAt: result.createdAt || new Date().toISOString()
          };
          const resultReference = this.storage.writeDerived({
            processingId,
            kind: 'vision',
            value: visionEvidence
          });
          this.repository.saveVisionResult({
            processingId,
            attachmentSetHash: job.attachmentSetHash,
            model: visionEvidence.visionModel,
            resultReference,
            usage: visionEvidence.usage
          });
          this.repository.completeProcessingStep(processingId, stepKey, {
            resultReference,
            usage: visionEvidence.usage
          });
          safeLog(this.logger, {
            event: 'attachment_processing',
            processingRef: digest(processingId),
            attachmentRef: digest(ids.join(':')),
            provider: 'qwen',
            model: 'qwen3-vl-plus',
            callType: 'vision',
            usage: visionEvidence.usage,
            state: 'completed'
          });
        } catch (error) {
          const code = providerCode(error, 'VISION_PROVIDER_UNAVAILABLE');
          this.repository.failProcessingStep(processingId, stepKey, code);
          partialErrors.push({ type: 'vision', code });
          safeLog(this.logger, {
            event: 'attachment_processing',
            processingRef: digest(processingId),
            attachmentRef: digest(ids.join(':')),
            provider: 'qwen',
            model: 'qwen3-vl-plus',
            callType: 'vision',
            state: 'failed',
            code
          });
        }
      }
    }

    if (!ocrEvidence.length && !visionEvidence) {
      const failureCode = terminalFailureCode(partialErrors);
      attachments.forEach((item) =>
        this.repository.setProcessingState(
          item.attachmentId,
          ATTACHMENT_PROCESSING_STATES.FAILED,
          failureCode
        )
      );
      this.repository.updateProcessingJob(processingId, {
        state: ATTACHMENT_PROCESSING_STATES.FAILED,
        errorCode: failureCode,
        completed: true
      });
      throw attachmentError(failureCode, {
        status: ACCESS_ERROR_CODES.has(failureCode) ? 429 : 503
      });
    }

    this.repository.updateProcessingJob(processingId, { state: ATTACHMENT_PROCESSING_STATES.MERGING });
    attachments.forEach((item) =>
      this.repository.setProcessingState(item.attachmentId, ATTACHMENT_PROCESSING_STATES.MERGING)
    );
    const merged = this.evidenceMerger.merge({
      userQuestion: question,
      ocrEvidence,
      visionEvidence,
      attachments,
      partialErrors
    });
    const finalState = partialErrors.length
      ? ATTACHMENT_PROCESSING_STATES.PARTIAL
      : ATTACHMENT_PROCESSING_STATES.PROCESSED;
    const result = {
      processingId,
      status: finalState,
      ...merged
    };
    const resultReference = this.storage.writeDerived({
      processingId,
      kind: 'evidence',
      value: result
    });
    this.repository.saveEvidenceResult({
      processingId,
      answerMode: merged.answerMode,
      resultReference
    });
    this.repository.updateProcessingJob(processingId, {
      state: finalState,
      answerReference: resultReference,
      answerMode: merged.answerMode,
      completed: true
    });
    attachments.forEach((item) =>
      this.repository.setProcessingState(item.attachmentId, finalState)
    );
    safeLog(this.logger, {
      event: 'attachment_processing',
      processingRef: digest(processingId),
      attachmentRef: digest(ids.join(':')),
      callType: 'merge',
      state: finalState
    });
    return result;
  }

  recoverInterruptedJobs() {
    return this.repository.recoverInterruptedProcessing();
  }

  publicResultForMessage({ userId, clientRequestId } = {}) {
    const job = this.repository.findProcessingJob(userId, clientRequestId);
    if (!job) return null;
    if (!job.answerReference) {
      return {
        status: job.state,
        answerMode: job.answerMode || null,
        limitations: job.errorCode ? [job.errorCode] : [],
        evidenceRefs: []
      };
    }
    const result = this.storage.readJson(job.answerReference);
    return {
      status: result.status || job.state,
      answerMode: result.answerMode || job.answerMode || null,
      limitations: Array.isArray(result.limitations) ? result.limitations.map(String) : [],
      evidenceRefs: Array.isArray(result.evidenceRefs)
        ? result.evidenceRefs.map((reference) => ({
            type: String(reference.type || ''),
            attachmentIds: Array.isArray(reference.attachmentIds)
              ? reference.attachmentIds.map(String)
              : []
          }))
        : []
    };
  }

  exportProcessingForOwner(userId) {
    return this.repository.listProcessingJobsForOwner(userId).flatMap((job) => {
      if (!job.answerReference) return [];
      const evidence = this.storage.readJson(job.answerReference);
      const ocr = this.repository.listOcrResults(job.processingId).map((row) =>
        this.storage.readJson(row.resultReference)
      );
      const visionRow = this.repository.getVisionResult(job.processingId);
      return [{
        processingId: job.processingId,
        conversationId: job.conversationId,
        messageId: job.messageId,
        processingVersion: job.processingVersion,
        state: job.state,
        answerMode: job.answerMode,
        ocr,
        vision: visionRow ? this.storage.readJson(visionRow.resultReference) : null,
        evidence
      }];
    });
  }

  exportProcessingForAttachment(attachmentId) {
    return this.repository.processingIdsForAttachment(attachmentId).flatMap((processingId) => {
      const job = this.repository.getProcessingJob(processingId);
      if (!job?.answerReference) return [];
      const ocrRow = this.repository.getOcrResult(processingId, attachmentId);
      const visionRow = this.repository.getVisionResult(processingId);
      return [{
        processingId,
        processingVersion: job.processingVersion,
        state: job.state,
        answerMode: job.answerMode,
        ocr: ocrRow ? this.storage.readJson(ocrRow.resultReference) : null,
        vision: visionRow ? this.storage.readJson(visionRow.resultReference) : null,
        evidence: this.storage.readJson(job.answerReference)
      }];
    });
  }

  deleteDerivedForAttachment(attachmentId) {
    const references = this.repository.listDerivedReferencesForAttachment(attachmentId);
    const processingIds = this.repository.processingIdsForAttachment(attachmentId);
    references.forEach((reference) => this.storage.deleteReference(reference));
    processingIds.forEach((processingId) => this.repository.deleteProcessingJob(processingId));
    return { processingJobs: processingIds.length, derivedFiles: references.length };
  }

  deleteAllProcessingForOwner(userId) {
    const jobs = this.repository.listProcessingJobsForOwner(userId);
    const references = new Set();
    for (const job of jobs) {
      this.repository.listProcessingItems(job.processingId).forEach(({ attachmentId }) => {
        this.repository.listDerivedReferencesForAttachment(attachmentId)
          .forEach((reference) => references.add(reference));
      });
    }
    references.forEach((reference) => this.storage.deleteReference(reference));
    this.repository.deleteProcessingForOwner(userId);
    return { processingJobs: jobs.length, derivedFiles: references.size };
  }
}
