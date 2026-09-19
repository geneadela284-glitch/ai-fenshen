import { stripPlaybackNotes } from '../voiceChat/playbackText.js';
import { createHash } from 'node:crypto';
import { validateProjection, encodeDocumentMessage, decodeDocumentMessage, documentError } from '../../core/documentQa/contract.js';
import { answerDocument } from '../../core/documentQa/answer.js';
import { validateMeetingEvidence, formatMeetingReply, classifyMeetingQuery, MEETING_QUERY_SCHEMA } from '../../core/meetingQuery/queryContract.js';
import { randomUUID } from 'node:crypto';
import { buildAIFenshenMessages } from './productPolicy.js';

function codedError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const MEMORY_ACKNOWLEDGEMENT = /(?:已经|我(?:已经)?|会|一定会|帮你|替你|好[的嘞]?[,，]?)?\s*(?:记住|记下|保存|写入|永久记录)|(?:收到[,，]?\s*)?(?:已经|已)\s*(?:记录|更新|修改)/;
const DURABLE_MEMORY_SIGNAL = /(?:生日|出生|喜欢|偏好|习惯|请记住|帮我记|记一下)/;
const EXPLICIT_MEMORY_REQUEST = /(?:请记住|帮我记|记一下|请记录|记录一下)/;
const COMMITTED_MEMORY_OUTCOMES = new Set(['memory_written', 'duplicate_detected', 'memory_corrected']);
const FORBIDDEN_MEMORY_OUTPUT_FRAGMENTS = Object.freeze([
  'undefined', 'null', 'owner_id', 'ownerId', 'entity_id', 'entityId',
  'memory_id', 'memoryId', '.sqlite', '/opt/'
]);

export function safeVisibleMemoryAnswer(value) {
  const text = String(value || '').trim();
  if (!text || FORBIDDEN_MEMORY_OUTPUT_FRAGMENTS.some((fragment) => text.includes(fragment))) {
    return '我目前还不知道。';
  }
  return text;
}

function reviewMemoryAcknowledgement(message, memoryResult) {
  return memoryResult?.kind === 'capture' || memoryResult?.outcome === 'capture_failed' ||
    DURABLE_MEMORY_SIGNAL.test(String(message || ''));
}

function safeMemoryResponse(content, memoryResult, message) {
  const text = String(content || '').trim();
  if (!MEMORY_ACKNOWLEDGEMENT.test(text)) return text;
  if (!memoryResult) return text;
  if (!COMMITTED_MEMORY_OUTCOMES.has(memoryResult?.outcome)) {
    return '这条信息暂时没能记下来，请稍后再试。';
  }
  return EXPLICIT_MEMORY_REQUEST.test(String(message || '')) ? '好的，已经记住了。' : '好的。';
}

export class ConversationService {
  constructor({ conversations, messages, aiService, registry, memoryPolicy = 'disabled', assistantAgent = null,
    requestId = () => `req_${randomUUID()}` } = {}) {
    if (!['disabled', 'protected_acceptance'].includes(memoryPolicy)) throw codedError('MEMORY_POLICY_INVALID');
    if (memoryPolicy === 'protected_acceptance' && !assistantAgent?.processUserMessage) {
      throw codedError('MEMORY_INTEGRATION_REQUIRED');
    }
    this.conversations = conversations;
    this.messages = messages;
    this.aiService = aiService;
    this.registry = registry;
    this.memoryPolicy = memoryPolicy;
    this.assistantAgent = assistantAgent;
    this.requestId = requestId;
    this.attachmentProcessor = null;
    this.documentQaEnabled = process.env.AI_FENSHEN_DOCUMENT_QA_ENABLED === 'true';
  }

  setAttachmentProcessor(processor) {
    this.attachmentProcessor = processor || null;
  }

  issueRequestId() {
    return this.requestId();
  }

  prepare({ ownerId, conversationId, message, clientRequestId, retry = false, requestId: suppliedRequestId = null,
    invocation = null, taskTimezone = null, attachmentIds = [], meetingQuery = null, documentQuery = null }) {
    const owner = String(ownerId || '').trim();
    const content = String(message || '').trim();
    const clientId = String(clientRequestId || '').trim();
    if (!owner) throw codedError('UNAUTHENTICATED');
    if (conversationId && this.isLearningConversation?.(conversationId, owner)) throw codedError('CONVERSATION_NOT_FOUND');
    if (!content) throw codedError('MESSAGE_REQUIRED');
    if (content.length > 32_000) throw codedError('MESSAGE_TOO_LONG');
    if (!clientId || clientId.length > 160) throw codedError('CLIENT_REQUEST_ID_INVALID');
    const normalizedAttachmentIds = [...new Set(
      (Array.isArray(attachmentIds) ? attachmentIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    )];
    if (normalizedAttachmentIds.length > 3) throw codedError('TOO_MANY_ATTACHMENTS');
    if (normalizedAttachmentIds.length && !this.attachmentProcessor) {
      throw codedError('ATTACHMENT_PROCESSING_UNAVAILABLE');
    }

    const documentEvidence = documentQuery == null ? null : (() => {
      if (!this.documentQaEnabled) throw documentError('DOCUMENT_FEATURE_DISABLED');
      if (normalizedAttachmentIds.length || meetingQuery) throw documentError('DOCUMENT_CONTEXT_INVALID');
      return validateProjection(documentQuery, { ownerId: owner, conversationId, question: content,
        hash: text => createHash('sha256').update(text).digest('hex') });
    })();
    const storedContent = documentEvidence ? encodeDocumentMessage('question', {
      question: content, documentId: documentEvidence.record.documentId, revision: documentEvidence.record.revision,
      filename: documentEvidence.record.filename, sourceHash: createHash('sha256').update(JSON.stringify(documentEvidence.blocks)).digest('hex')
    }) : content;
    const queryTimezone = taskTimezone || 'Asia/Shanghai';
    const queryPlan = normalizedAttachmentIds.length || documentEvidence ? null : classifyMeetingQuery(content, { timezone: queryTimezone });
    const meetingEvidence = meetingQuery == null
      ? (queryPlan ? { schema: MEETING_QUERY_SCHEMA, ownerId: owner, question: content, timezone: queryTimezone, date: queryPlan.date, queriedAt: new Date().toISOString(), state: queryPlan.state === 'needs_date' ? 'needs_date' : 'unavailable', total: 0, meetings: [] } : null)
      : validateMeetingEvidence(meetingQuery, { ownerId: owner, question: content, timezone: queryTimezone });
    if (meetingEvidence && normalizedAttachmentIds.length) throw codedError('MEETING_QUERY_INVALID');

    let conversation = conversationId ? this.conversations.getByIdForOwner(conversationId, owner) : null;
    if (conversationId && !conversation) throw codedError('CONVERSATION_NOT_FOUND');

    const existing = conversation ? this.messages.findByClientRequestId(conversation.id, owner, clientId) : { user: null, assistant: null };
    if (existing.user && (documentEvidence || decodeDocumentMessage(existing.user.content)?.kind === 'question') && existing.user.content !== storedContent) throw documentError('DOCUMENT_REQUEST_CONFLICT');
    if (meetingEvidence && existing.user && existing.user.content !== content) throw codedError('MEETING_QUERY_INVALID');
    if (existing.user && retry === true && existing.assistant && ['error', 'stopped'].includes(existing.assistant.status)) {
      if (!this.messages.restartAssistantMessage({ ownerId: owner, messageId: existing.assistant.id })) {
        throw codedError('RETRY_NOT_AVAILABLE');
      }
      const requestId = suppliedRequestId || this.requestId();
      const controller = new AbortController();
      this.registry.register({ requestId, ownerId: owner, conversationId: conversation.id, assistantMessageId: existing.assistant.id, controller });
      return {
        deduplicated: false,
        retried: true,
        requestId,
        ownerId: owner,
        conversation,
        userMessage: existing.user,
        assistantMessage: { ...existing.assistant, content: '', status: 'streaming', errorCode: null },
        controller,
        taskTimezone,
        invocation,
        meetingQuery: meetingEvidence,
        documentQuery: documentEvidence,
        documentQuestion: content,
        attachmentIds: normalizedAttachmentIds
      };
    }
    if (existing.user) {
      return {
        deduplicated: true, requestId: `existing_${existing.user.id}`, ownerId: owner, conversation,
        userMessage: existing.user, assistantMessage: existing.assistant,
        meetingQuery: meetingEvidence,
        documentQuery: documentEvidence,
        documentQuestion: content,
        attachmentIds: normalizedAttachmentIds
      };
    }

    const database = this.messages.database;
    database.exec('BEGIN IMMEDIATE');
    let userMessage;
    let assistantMessage;
    try {
      if (!conversation) conversation = this.conversations.createForOwner(owner, { title: content.slice(0, 60) });
      userMessage = this.messages.createUserMessage({ ownerId: owner, conversationId: conversation.id, content: storedContent, clientRequestId: clientId });
      assistantMessage = this.messages.createAssistantPlaceholder({ ownerId: owner, conversationId: conversation.id, clientRequestId: clientId });
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
    const requestId = suppliedRequestId || this.requestId();
    const controller = new AbortController();
    this.registry.register({ requestId, ownerId: owner, conversationId: conversation.id, assistantMessageId: assistantMessage.id, controller });
    return {
      deduplicated: false,
      requestId,
      ownerId: owner,
      conversation,
      userMessage,
      assistantMessage,
      controller,
      taskTimezone,
      invocation,
      meetingQuery: meetingEvidence,
        documentQuery: documentEvidence,
        documentQuestion: content,
        attachmentIds: normalizedAttachmentIds
    };
  }

  async execute(prepared, { signal, onDelta = () => {} } = {}) {
    if (prepared.deduplicated) {
      const status = prepared.assistantMessage?.status || 'error';
      return { status, content: prepared.assistantMessage?.content || '', deduplicated: true };
    }

    const { controller, ownerId, assistantMessage, conversation, userMessage, requestId } = prepared;
    const forwardAbort = () => controller.abort(signal?.reason || 'client_disconnected');
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    let buffer = '';
    let finalStatus = 'error';
    try {
      if (prepared.documentQuery) {
        const history = this.messages.listForConversationOwner(conversation.id, ownerId).filter(m => m.id !== userMessage.id);
        const content = await answerDocument({ document: prepared.documentQuery, question: prepared.documentQuestion,
          history, aiService: this.aiService, invocation: prepared.invocation, signal: controller.signal,
          requestId, conversationId: conversation.id, clientRequestId: userMessage.clientRequestId });
        if (controller.signal.aborted) throw codedError('ABORTED');
        await onDelta(content); buffer = content;
        if (controller.signal.aborted) throw codedError('ABORTED');
        this.messages.completeAssistantMessage({ ownerId, messageId: assistantMessage.id, content });
        this.conversations.touchForOwner(conversation.id, ownerId); finalStatus = 'completed';
        return { status: finalStatus, content, deterministicAction: 'document.query' };
      }
      if (prepared.meetingQuery) {
        if (controller.signal.aborted) throw codedError('ABORTED');
        const content = formatMeetingReply(prepared.meetingQuery);
        await onDelta(content);
        buffer = content;
        if (controller.signal.aborted) throw codedError('ABORTED');
        this.messages.completeAssistantMessage({ ownerId, messageId: assistantMessage.id, content });
        this.conversations.touchForOwner(conversation.id, ownerId);
        finalStatus = 'completed';
        return { status: finalStatus, content, deterministicAction: 'meeting.query' };
      }
      const history = this.messages.listForConversationOwner(conversation.id, ownerId)
        .filter((item) => item.id !== assistantMessage.id && !decodeDocumentMessage(item.content))
        .map((item) => ({ role: item.role, content: item.role === 'assistant' && item.voiceDelivery
          ? stripPlaybackNotes(item.content) : item.content }));
      if (prepared.attachmentIds?.length) {
        const attachmentResult = await this.attachmentProcessor.processAttachmentsForMessage({
          authenticatedUserId: ownerId,
          conversationId: conversation.id,
          messageId: userMessage.id,
          attachmentIds: prepared.attachmentIds,
          userQuestion: userMessage.content,
          clientRequestId: userMessage.clientRequestId,
          retry: prepared.retried === true,
          invocation: prepared.invocation || {}
        });
        const content = String(attachmentResult?.answer || '');
        if (!content) throw codedError('ATTACHMENT_PROCESSING_FAILED');
        await onDelta(content);
        buffer = content;
        finalStatus = 'completed';
        this.messages.completeAssistantMessage({
          ownerId,
          messageId: assistantMessage.id,
          content
        });
        this.conversations.touchForOwner(conversation.id, ownerId);
        return {
          status: finalStatus,
          content,
          deterministicAction: 'attachment_understanding',
          processingId: attachmentResult.processingId,
          attachmentResult: {
            status: attachmentResult.status,
            answerMode: attachmentResult.answerMode,
            limitations: Array.isArray(attachmentResult.limitations)
              ? attachmentResult.limitations.map(String)
              : [],
            evidenceRefs: Array.isArray(attachmentResult.evidenceRefs)
              ? attachmentResult.evidenceRefs
              : []
          }
        };
      }
      let memoryResult = null;
      if (this.assistantAgent?.processUserMessage) {
        try {
          const agentResult = await this.assistantAgent.processUserMessage({
            requestId,
            ownerId,
            conversationId: conversation.id,
            message: userMessage.content,
            clientRequestId: userMessage.clientRequestId,
            sourceMessageId: userMessage.id,
            ...(prepared.taskTimezone ? { taskTimezone: prepared.taskTimezone } : {}),
            conversationMessages: history,
            captureEligible: prepared.retried !== true,
            ...(prepared.invocation ? { invocation: prepared.invocation } : {})
          });
          if (agentResult?.handled && agentResult.domain !== 'memory') {
            const content = String(agentResult.content || '');
            if (content) await onDelta(content);
            buffer = content;
            if (agentResult.domain === 'finance' && agentResult.action === 'error') {
              finalStatus = 'error';
              const code = agentResult.code || 'FINANCE_HANDLER_FAILED';
              this.messages.failAssistantMessage({
                ownerId,
                messageId: assistantMessage.id,
                content,
                errorCode: code
              });
              this.conversations.touchForOwner(conversation.id, ownerId);
              return {
                status: finalStatus,
                content,
                code,
                deterministicAction: 'error'
              };
            }
            finalStatus = 'completed';
            this.messages.completeAssistantMessage({ ownerId, messageId: assistantMessage.id, content });
            this.conversations.touchForOwner(conversation.id, ownerId);
            return { status: finalStatus, content, deterministicAction: agentResult.action || null,
              ...(this.voiceMode && agentResult.voiceProposal ? { voiceProposal: agentResult.voiceProposal } : {}) };
          }
          if (agentResult?.domain === 'memory') memoryResult = agentResult;
        } catch (error) {
          if (this.voiceMode && String(error?.code || '').startsWith('VOICE_')) throw error;
          if (this.assistantAgent.isMemoryQuery?.(userMessage.content, {
            ownerId,
            conversationId: conversation.id
          })) {
            finalStatus = 'error';
            this.messages.failAssistantMessage({ ownerId, messageId: assistantMessage.id, content: '', errorCode: 'MEMORY_QUERY_UNAVAILABLE' });
            return { status: finalStatus, content: '', code: 'MEMORY_QUERY_UNAVAILABLE' };
          }
          memoryResult = { kind: 'none', outcome: 'capture_failed' };
        }
      }

      if (['clarification', 'query_error'].includes(memoryResult?.kind)) {
        const content = String(memoryResult.content || (memoryResult.kind === 'query_error'
          ? '暂时无法读取长期记忆，请稍后再试。'
          : '请再明确一点。'));
        await onDelta(content);
        buffer = content;
        finalStatus = 'completed';
        this.messages.completeAssistantMessage({ ownerId, messageId: assistantMessage.id, content });
        this.conversations.touchForOwner(conversation.id, ownerId);
        return { status: finalStatus, content, deterministicAction: memoryResult.kind };
      }

      if (memoryResult?.kind === 'capture' &&
          COMMITTED_MEMORY_OUTCOMES.has(memoryResult.outcome) &&
          EXPLICIT_MEMORY_REQUEST.test(userMessage.content)) {
        const content = '好的，已经记住了。';
        await onDelta(content);
        buffer = content;
        finalStatus = 'completed';
        this.messages.completeAssistantMessage({ ownerId, messageId: assistantMessage.id, content });
        this.conversations.touchForOwner(conversation.id, ownerId);
        return { status: finalStatus, content, deterministicAction: 'memory_commit_acknowledged' };
      }

      const sealedMemoryAnswer = memoryResult?.kind === 'query' &&
        ['fact', 'not_found'].includes(memoryResult.safeAnswer?.type)
        ? safeVisibleMemoryAnswer(memoryResult.safeAnswer.safeUserMessage)
        : null;
      if (sealedMemoryAnswer) {
        const content = sealedMemoryAnswer;
        await onDelta(content);
        buffer = content;
        finalStatus = 'completed';
        this.messages.completeAssistantMessage({ ownerId, messageId: assistantMessage.id, content });
        this.conversations.touchForOwner(conversation.id, ownerId);
        return { status: finalStatus, content };
      }

      const reviewMemoryResponse = this.memoryPolicy === 'protected_acceptance' &&
        reviewMemoryAcknowledgement(userMessage.content, memoryResult);

      const result = await this.aiService.stream({
        input: userMessage.content,
        messages: buildAIFenshenMessages(history, { trustedMemoryContext: memoryResult?.trustedContext || null }),
        metadata: {
          memoryPolicy: 'disabled',
          protectedMemoryScope: this.memoryPolicy,
          conversationId: conversation.id,
          requestId,
          clientRequestId: userMessage.clientRequestId,
          ownerId,
          routeDomain: 'ordinary_chat'
        }
      }, {
        signal: controller.signal,
        onDelta: async (delta) => {
          if (controller.signal.aborted) return;
          const text = String(delta || '');
          if (!text) return;
          buffer += text;
          if (!reviewMemoryResponse) await onDelta(text);
        }
      }, prepared.invocation || {});

      if (controller.signal.aborted || result?.code === 'ABORTED') {
        finalStatus = 'stopped';
        this.messages.stopAssistantMessage({ ownerId, messageId: assistantMessage.id, content: buffer });
        return { status: finalStatus, content: buffer };
      }
      if (!result?.ok) {
        finalStatus = 'error';
        this.messages.failAssistantMessage({ ownerId, messageId: assistantMessage.id, content: buffer, errorCode: result?.code || 'PROVIDER_ERROR' });
        return { status: finalStatus, content: buffer, code: result?.code || 'PROVIDER_ERROR' };
      }
      const content = safeMemoryResponse(String(result.content || buffer), memoryResult, userMessage.content);
      if (reviewMemoryResponse && content) await onDelta(content);
      buffer = content;
      finalStatus = 'completed';
      this.messages.completeAssistantMessage({ ownerId, messageId: assistantMessage.id, content });
      this.conversations.touchForOwner(conversation.id, ownerId);
      return { status: finalStatus, content };
    } catch (error) {
      if (controller.signal.aborted || error?.code === 'ABORTED') {
        finalStatus = 'stopped';
        this.messages.stopAssistantMessage({ ownerId, messageId: assistantMessage.id, content: buffer });
        return { status: finalStatus, content: buffer };
      }
      finalStatus = 'error';
      this.messages.failAssistantMessage({ ownerId, messageId: assistantMessage.id, content: buffer, errorCode: error?.code || 'PROVIDER_ERROR' });
      return { status: finalStatus, content: buffer, code: error?.code || 'PROVIDER_ERROR' };
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
      this.registry.settle(requestId, finalStatus);
    }
  }

  cancelForOwner(requestId, ownerId) {
    return this.registry.cancelForOwner(String(requestId || ''), String(ownerId || ''));
  }
}
