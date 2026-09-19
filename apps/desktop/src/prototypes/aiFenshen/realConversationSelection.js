export const NEW_CONVERSATION_MARKER = '__ai_fenshen_new_conversation__';

export function selectRestorableConversation(conversations = [], remembered = '') {
  if (remembered === NEW_CONVERSATION_MARKER) return null;
  return conversations.find((conversation) => conversation.id === remembered) || conversations[0] || null;
}

