function uiStatus(status) {
  return status === 'completed' ? 'complete' : status || 'complete';
}

export function restoreConversationMessages(messages = []) {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: String(message.content || ''),
    status: uiStatus(message.status),
    clientRequestId: message.clientRequestId || null,
    ...(message.voiceDelivery ? { voiceDelivery: message.voiceDelivery } : {}),
    ...(Array.isArray(message.attachments) ? { attachments: message.attachments } : {}),
    ...(message.attachmentResult ? { attachmentResult: message.attachmentResult } : {})
  }));
}

export function createOptimisticExchange(messages, { content, clientRequestId, attachments = [] }) {
  return [
    ...messages,
    {
      id: `pending-user-${clientRequestId}`,
      role: 'user',
      content,
      status: 'complete',
      clientRequestId,
      ...(attachments.length ? { attachments } : {})
    },
    { id: `pending-assistant-${clientRequestId}`, role: 'assistant', content: '', status: 'streaming', clientRequestId }
  ];
}

export function applyRealConversationEvent(messages, event, clientRequestId) {
  const data = event?.data || {};
  if (event?.type === 'started') {
    return messages.map((message) => {
      if (message.clientRequestId !== clientRequestId) return message;
      if (message.role === 'user') return { ...message, id: data.userMessageId || message.id, requestId: data.requestId };
      return { ...message, id: data.assistantMessageId || message.id, requestId: data.requestId };
    });
  }
  return messages.map((message) => {
    if (message.clientRequestId === clientRequestId &&
        message.role === 'user' &&
        event?.type === 'completed' &&
        Array.isArray(message.attachments)) {
      return {
        ...message,
        attachments: message.attachments.map((attachment) => ({
          ...attachment,
          processingState: data.status || 'processed'
        }))
      };
    }
    if (message.clientRequestId !== clientRequestId || message.role !== 'assistant') return message;
    const withRequest = { ...message, requestId: data.requestId || message.requestId };
    if (event?.type === 'delta') return { ...withRequest, content: `${message.content}${String(data.text || '')}`, status: 'streaming' };
    if (event?.type === 'completed') {
      const attachmentResult = data.answerMode || data.limitations || data.evidenceRefs
        ? {
            status: data.status || 'processed',
            answerMode: data.answerMode || null,
            limitations: Array.isArray(data.limitations) ? data.limitations : [],
            evidenceRefs: Array.isArray(data.evidenceRefs) ? data.evidenceRefs : []
          }
        : null;
      return {
        ...withRequest,
        status: 'complete',
        ...(attachmentResult ? { attachmentResult } : {})
      };
    }
    if (event?.type === 'stopped') return { ...withRequest, status: 'stopped' };
    if (event?.type === 'error') return { ...withRequest, status: 'error', errorCode: data.code || 'SERVICE_UNAVAILABLE' };
    return message;
  });
}

export function findRetryExchange(messages, assistantId) {
  const assistant = assistantId
    ? messages.find((message) => message.id === assistantId && message.role === 'assistant')
    : messages.findLast((message) => message.role === 'assistant' && ['error', 'stopped'].includes(message.status));
  if (!assistant?.clientRequestId) return null;
  const user = messages.find((message) => message.role === 'user' && message.clientRequestId === assistant.clientRequestId);
  return user ? {
    content: user.content,
    clientRequestId: user.clientRequestId,
    assistantId: assistant.id,
    attachmentIds: (user.attachments || []).map((item) => item.attachmentId).filter(Boolean)
  } : null;
}
