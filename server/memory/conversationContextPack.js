const MAX_MESSAGES = 8;
const MAX_MESSAGE_LENGTH = 1200;

function cleanMessage(message) {
  return Object.freeze({
    role: message?.role === 'assistant' ? 'assistant' : 'user',
    content: String(message?.content || '').slice(0, MAX_MESSAGE_LENGTH)
  });
}

export function buildConversationContextPack({ messages = [], trustedContext = null } = {}) {
  const recent = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES).map(cleanMessage) : [];
  const inherited = trustedContext && typeof trustedContext === 'object' ? {
    previous_entity: typeof trustedContext.previous_entity === 'string' ? trustedContext.previous_entity : null,
    previous_predicate: typeof trustedContext.previous_predicate === 'string' ? trustedContext.previous_predicate : null,
    previously_returned_values: Array.isArray(trustedContext.previously_returned_values)
      ? trustedContext.previously_returned_values.map(String).slice(0, 20)
      : []
  } : { previous_entity: null, previous_predicate: null, previously_returned_values: [] };
  return Object.freeze({ recent_messages: Object.freeze(recent), inherited_context: Object.freeze(inherited) });
}
