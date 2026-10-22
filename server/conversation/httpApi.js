function writeSse(response, event, data) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeError(code = 'PROVIDER_ERROR') {
  return {
    code,
    message: PUBLIC_MESSAGES[code] || 'AI服务暂时不可用，请稍后重试'
  };
}

function sendAccessError(res, error, sendJson) {
  const code = String(error?.code || 'ACCESS_CONTROL_UNAVAILABLE');
  const status = Number(error?.status || (code === 'ACCESS_CONTROL_UNAVAILABLE' ? 503 : 429));
  const retryAfter = Number(error?.retryAfterSeconds);
  sendJson(res, status, {
    ok: false,
    code,
    message: PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.ACCESS_CONTROL_UNAVAILABLE
  }, Number.isFinite(retryAfter) && retryAfter > 0
    ? { 'Retry-After': String(Math.ceil(retryAfter)) }
    : {});
}

function publicConversation(conversation) {
  return conversation ? {
    id: conversation.id,
    title: conversation.title,
    status: conversation.status,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  } : null;
}

function publicMessage(message, {
  attachments = [],
  attachmentResult = null
} = {}) {
  return message ? {
    id: message.id,
    conversationId: message.conversationId,
    role: message.role,
    content: message.content,
    status: message.status,
    clientRequestId: message.clientRequestId,
    errorCode: message.errorCode,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    ...(message.voiceDelivery ? { voiceDelivery: message.voiceDelivery } : {}),
    ...(attachments.length ? {
      attachments: attachments.map(publicAttachment)
    } : {}),
    ...(attachmentResult ? { attachmentResult } : {})
  } : null;
}

function accountContextHeaders(user) {
  return {
    'Cache-Control': 'private, no-store',
    Vary: 'Cookie',
    'X-AI-Account-Context': user.id
  };
}

function sendAccountJson(sendJson, res, status, user, body) {
  sendJson(res, status, {
    ...body,
    accountContext: user.id
  }, accountContextHeaders(user));
}

export async function handleConversationApi({
  req,
  res,
  url,
  user,
  subject,
  accessControl,
  runtime,
  attachmentRuntime = null,
  readJson,
  sendJson
}) {
  const isChat = url.pathname.startsWith('/api/ai/chat/');
  const isConversation = url.pathname === '/api/ai/conversations' || url.pathname.startsWith('/api/ai/conversations/');
  if (!isChat && !isConversation) return false;
  if (!user) {
    sendJson(res, 401, { ok: false, message: '请先登录。' });
    return true;
  }
  const boundSendJson = (response, status, body, headers = {}) => sendJson(response, status, {
    ...body,
    accountContext: user.id
  }, {
    ...accountContextHeaders(user),
    ...headers
  });
  let authenticatedSubject;
  try {
    authenticatedSubject = accessControl.assertAuthenticatedSubject(subject);
  } catch (error) {
    sendAccessError(res, error, boundSendJson);
    return true;
  }
  if (authenticatedSubject.accountId !== user.id) {
    boundSendJson(res, 403, {
      ok: false,
      code: 'ACCOUNT_CONTEXT_MISMATCH',
      message: '账号状态已变化，请重新登录。'
    });
    return true;
  }
  const expectedAccountContext = String(req.headers?.['x-ai-expected-account-context'] || '').trim();
  if (expectedAccountContext && expectedAccountContext !== user.id) {
    boundSendJson(res, 403, {
      ok: false,
      code: 'ACCOUNT_CONTEXT_MISMATCH',
      message: '账号状态已变化，请重新登录。'
    });
    return true;
  }
  if (!runtime?.service) {
    boundSendJson(res, 503, { ok: false, message: 'AI服务暂时不可用，请稍后重试。' });
    return true;
  }

  if (url.pathname === '/api/ai/chat/document-capabilities' && req.method === 'GET') {
    sendAccountJson(sendJson, res, 200, user, { available: true, enabled: runtime.service.documentQaEnabled === true });
    return true;
  }
  if (url.pathname === '/api/ai/conversations' && req.method === 'GET') {
    sendAccountJson(sendJson, res, 200, user, { ok: true, conversations: runtime.conversations.listForOwner(user.id).filter(c=>!runtime.service.isLearningConversation?.(c.id,user.id)).map(publicConversation) });
    return true;
  }

  if (url.pathname === '/api/ai/conversations' && req.method === 'POST') {
    const body = await readJson(req);
    const conversation = runtime.conversations.createForOwner(user.id, { title: String(body.title || '新的对话') });
    sendAccountJson(sendJson, res, 201, user, { ok: true, conversation: publicConversation(conversation) });
    return true;
  }

  const messagesMatch = url.pathname.match(/^\/api\/ai\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch && req.method === 'GET') {
    const conversationId = decodeURIComponent(messagesMatch[1]);
    const conversation = runtime.conversations.getByIdForOwner(conversationId, user.id);
    if (!conversation || runtime.service.isLearningConversation?.(conversationId,user.id)) {
      boundSendJson(res, 404, { ok: false, message: '对话不存在。' });
      return true;
    }
    const messages = runtime.messages.listForConversationOwner(conversationId, user.id);
    sendAccountJson(sendJson, res, 200, user, {
      ok: true,
      conversation: publicConversation(conversation),
      messages: messages.map((message) => publicMessage(message, {
        attachments: message.role === 'user'
          ? attachmentRuntime?.repository?.listForMessageOwner?.(
              user.id,
              conversationId,
              message.id
            ) || []
          : [],
        attachmentResult: message.role === 'assistant'
          ? attachmentRuntime?.processingService?.publicResultForMessage?.({
              userId: user.id,
              clientRequestId: message.clientRequestId
            }) || null
          : null
      }))
    });
    return true;
  }

  const cancelMatch = url.pathname.match(/^\/api\/ai\/chat\/requests\/([^/]+)\/cancel$/);
  if (cancelMatch && req.method === 'POST') {
    const result = runtime.service.cancelForOwner(decodeURIComponent(cancelMatch[1]), user.id);
    if (result.status === 'not_found') boundSendJson(res, 404, { ok: false, message: '请求不存在。' });
    else sendAccountJson(sendJson, res, 200, user, { ok: true, status: result.status });
    return true;
  }

  if (url.pathname !== '/api/ai/chat/stream' || req.method !== 'POST') return false;
  let body;
  try {
    if (runtime.service.documentQaEnabled === true) {
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 512 * 1024) throw new Error('PAYLOAD_TOO_LARGE'); chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } else body = await readJson(req);
  } catch {
    boundSendJson(res, 400, { ok: false, code: 'DOCUMENT_REQUEST_TOO_LARGE', message: '文件请求过大或无效。' });
    return true;
  }
  if (!String(body.message || '').trim()) {
    boundSendJson(res, 400, { ok: false, message: '请输入内容。' });
    return true;
  }
  if (!String(body.clientRequestId || '').trim()) {
    boundSendJson(res, 400, { ok: false, message: '请求标识无效。' });
    return true;
  }

  let prepared;
  let requestLease = null;
  try {
    const requestId = runtime.service.issueRequestId();
    requestLease = accessControl.beginRequest({ subject, requestId });
    prepared = runtime.service.prepare({
      ownerId: user.id,
      conversationId: body.conversationId,
      message: body.message,
      clientRequestId: body.clientRequestId,
      retry: body.retry === true,
      taskTimezone: body.timezone,
      attachmentIds: body.attachmentIds,
      meetingQuery: body.meetingQuery,
      documentQuery: body.documentQuery,
      localMemory: body.localMemory,
      requestId,
      invocation: { subject, requestLease }
    });
  } catch (error) {
    if (requestLease) {
      try { accessControl.releaseRequest(requestLease); } catch { /* The original error remains authoritative. */ }
    }
    if (PUBLIC_MESSAGES[error?.code]) sendAccessError(res, error, boundSendJson);
    else if (['REQUEST_CONTENT_CONFLICT','LOCAL_MEMORY_CONTEXT_INVALID'].includes(error?.code)) boundSendJson(res, 409, {ok:false,code:error.code,message:'请求内容已变化，请重新发送。'});
    else if (String(error?.code || '').startsWith('DOCUMENT_')) boundSendJson(res, 400, { ok: false, code: error.code, message: '文件引用不可用，请重新选择文件。' });
    else if (error?.code === 'CONVERSATION_NOT_FOUND') boundSendJson(res, 404, { ok: false, message: '对话不存在。' });
    else boundSendJson(res, 400, { ok: false, message: '请求无效。' });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream;charset=utf-8',
    ...accountContextHeaders(user),
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const disconnect = new AbortController();
  let finished = false;
  res.on('close', () => { if (!finished) disconnect.abort('client_disconnected'); });
  writeSse(res, 'started', {
    requestId: prepared.requestId,
    conversationId: prepared.conversation.id,
    userMessageId: prepared.userMessage.id,
    assistantMessageId: prepared.assistantMessage?.id || null,
    deduplicated: prepared.deduplicated
  });
  try {
    const result = await runtime.service.execute(prepared, {
      signal: disconnect.signal,
      onDelta: (text) => writeSse(res, 'delta', { requestId: prepared.requestId, text }),
      onAttachmentProgress: ({ stage, completedImages, totalImages }) => writeSse(res, 'attachment_progress', { requestId: prepared.requestId, stage, completedImages, totalImages })
    });
    if (result.status === 'completed') {
      writeSse(res, 'completed', {
        requestId: prepared.requestId,
        assistantMessageId: prepared.assistantMessage?.id || null,
        status: result.attachmentResult?.status || 'completed',
        ...(result.attachmentResult || {})
      });
    } else if (result.status === 'stopped') {
      writeSse(res, 'stopped', { requestId: prepared.requestId, assistantMessageId: prepared.assistantMessage?.id || null, status: 'stopped' });
    } else {
      writeSse(res, 'error', { requestId: prepared.requestId, ...safeError(result.code) });
    }
  } catch (error) {
    writeSse(res, 'error', { requestId: prepared.requestId, ...safeError(error?.code) });
  } finally {
    try { accessControl.releaseRequest(requestLease); } catch { /* Request already has a stable terminal response. */ }
    finished = true;
    if (!res.writableEnded) res.end();
  }
  return true;
}
import { PUBLIC_MESSAGES } from '../access/accessErrors.js';
import { publicAttachment } from '../attachments/contract.js';
