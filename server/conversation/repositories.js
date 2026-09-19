import { randomUUID } from 'node:crypto';

function conversationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function messageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    status: row.status,
    clientRequestId: row.client_request_id,
    errorCode: row.error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return normalized;
}

export class ConversationRepository {
  constructor({ database, now = () => new Date().toISOString(), id = () => `conv_${randomUUID()}` } = {}) {
    this.database = database;
    this.now = now;
    this.id = id;
  }

  createForOwner(ownerId, { title = '' } = {}) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const createdAt = this.now();
    const conversation = {
      id: this.id(), ownerId: owner, title: String(title || '').trim().slice(0, 160), status: 'active', createdAt, updatedAt: createdAt
    };
    this.database.prepare(`
      INSERT INTO conversations (id, owner_id, title, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(conversation.id, conversation.ownerId, conversation.title, conversation.status, conversation.createdAt, conversation.updatedAt);
    return conversation;
  }

  getByIdForOwner(conversationId, ownerId) {
    return conversationRow(this.database.prepare(`
      SELECT * FROM conversations WHERE id = ? AND owner_id = ?
    `).get(required(conversationId, 'CONVERSATION_ID_REQUIRED'), required(ownerId, 'OWNER_REQUIRED')));
  }

  listForOwner(ownerId) {
    return this.database.prepare(`
      SELECT * FROM conversations WHERE owner_id = ? ORDER BY updated_at DESC, rowid DESC
    `).all(required(ownerId, 'OWNER_REQUIRED')).map(conversationRow);
  }

  touchForOwner(conversationId, ownerId) {
    return this.database.prepare(`
      UPDATE conversations SET updated_at = ? WHERE id = ? AND owner_id = ?
    `).run(this.now(), required(conversationId, 'CONVERSATION_ID_REQUIRED'), required(ownerId, 'OWNER_REQUIRED')).changes > 0;
  }

  archiveForOwner(conversationId, ownerId) {
    return this.database.prepare(`
      UPDATE conversations SET status = 'archived', updated_at = ? WHERE id = ? AND owner_id = ?
    `).run(this.now(), required(conversationId, 'CONVERSATION_ID_REQUIRED'), required(ownerId, 'OWNER_REQUIRED')).changes > 0;
  }

  exportForOwner(ownerId, messages) {
    return this.listForOwner(ownerId).map((conversation) => ({
      ...conversation,
      messages: messages.listForConversationOwner(conversation.id, ownerId)
    }));
  }

  deleteAllForOwner(ownerId) {
    this.voiceRepository?.deleteOwner(ownerId);
    return Number(this.database.prepare(
      'DELETE FROM conversations WHERE owner_id = ?'
    ).run(required(ownerId, 'OWNER_REQUIRED')).changes);
  }
}

export class MessageRepository {
  constructor({ database, now = () => new Date().toISOString(), id = () => `msg_${randomUUID()}` } = {}) {
    this.database = database;
    this.now = now;
    this.id = id;
  }

  ownedConversation(conversationId, ownerId) {
    return this.database.prepare('SELECT id FROM conversations WHERE id = ? AND owner_id = ?')
      .get(required(conversationId, 'CONVERSATION_ID_REQUIRED'), required(ownerId, 'OWNER_REQUIRED'));
  }

  assertOwnedConversation(conversationId, ownerId) {
    if (!this.ownedConversation(conversationId, ownerId)) {
      const error = new Error('CONVERSATION_NOT_FOUND');
      error.code = 'CONVERSATION_NOT_FOUND';
      throw error;
    }
  }

  createUserMessage({ ownerId, conversationId, content, clientRequestId }) {
    this.assertOwnedConversation(conversationId, ownerId);
    const requestId = required(clientRequestId, 'CLIENT_REQUEST_ID_REQUIRED');
    const existing = this.findByClientRequestId(conversationId, ownerId, requestId).user;
    if (existing) return existing;
    const at = this.now();
    const row = {
      id: this.id(), conversationId, role: 'user', content: required(content, 'MESSAGE_REQUIRED'), status: 'completed', clientRequestId: requestId,
      errorCode: null, createdAt: at, updatedAt: at
    };
    this.database.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, status, client_request_id, error_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.conversationId, row.role, row.content, row.status, row.clientRequestId, row.errorCode, row.createdAt, row.updatedAt);
    return row;
  }

  createAssistantPlaceholder({ ownerId, conversationId, clientRequestId }) {
    this.assertOwnedConversation(conversationId, ownerId);
    const requestId = required(clientRequestId, 'CLIENT_REQUEST_ID_REQUIRED');
    const existing = this.findByClientRequestId(conversationId, ownerId, requestId).assistant;
    if (existing) return existing;
    const at = this.now();
    const row = {
      id: this.id(), conversationId, role: 'assistant', content: '', status: 'streaming', clientRequestId: requestId,
      errorCode: null, createdAt: at, updatedAt: at
    };
    this.database.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, status, client_request_id, error_code, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.id, row.conversationId, row.role, row.content, row.status, row.clientRequestId, row.errorCode, row.createdAt, row.updatedAt);
    return row;
  }

  updateAssistant({ ownerId, messageId, content, status, errorCode = null }) {
    return this.database.prepare(`
      UPDATE messages
      SET content = ?, status = ?, error_code = ?, updated_at = ?
      WHERE id = ? AND role = 'assistant'
        AND conversation_id IN (SELECT id FROM conversations WHERE owner_id = ?)
    `).run(String(content ?? ''), status, errorCode, this.now(), required(messageId, 'MESSAGE_ID_REQUIRED'), required(ownerId, 'OWNER_REQUIRED')).changes > 0;
  }

  appendAssistantDelta({ ownerId, messageId, delta }) {
    return this.database.prepare(`
      UPDATE messages
      SET content = content || ?, updated_at = ?
      WHERE id = ? AND role = 'assistant' AND status = 'streaming'
        AND conversation_id IN (SELECT id FROM conversations WHERE owner_id = ?)
    `).run(String(delta || ''), this.now(), required(messageId, 'MESSAGE_ID_REQUIRED'), required(ownerId, 'OWNER_REQUIRED')).changes > 0;
  }

  completeAssistantMessage({ ownerId, messageId, content }) {
    return this.updateAssistant({ ownerId, messageId, content, status: 'completed' });
  }

  stopAssistantMessage({ ownerId, messageId, content }) {
    return this.updateAssistant({ ownerId, messageId, content, status: 'stopped' });
  }

  failAssistantMessage({ ownerId, messageId, content, errorCode }) {
    return this.updateAssistant({ ownerId, messageId, content, status: 'error', errorCode: String(errorCode || 'PROVIDER_ERROR') });
  }

  restartAssistantMessage({ ownerId, messageId }) {
    return this.database.prepare(`
      UPDATE messages
      SET content = '', status = 'streaming', error_code = NULL, updated_at = ?
      WHERE id = ? AND role = 'assistant' AND status IN ('error', 'stopped')
        AND conversation_id IN (SELECT id FROM conversations WHERE owner_id = ?)
    `).run(this.now(), required(messageId, 'MESSAGE_ID_REQUIRED'), required(ownerId, 'OWNER_REQUIRED')).changes > 0;
  }

  listForConversationOwner(conversationId, ownerId) {
    if (!this.ownedConversation(conversationId, ownerId)) return [];
    return this.database.prepare(`
      SELECT m.* FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = ? AND c.owner_id = ?
      ORDER BY m.created_at ASC, m.rowid ASC
    `).all(conversationId, ownerId).map(row => {
      const message = messageRow(row);
      const voiceDelivery = this.voiceRepository?.get(message.id, ownerId);
      return voiceDelivery ? { ...message, voiceDelivery } : message;
    });
  }

  findByClientRequestId(conversationId, ownerId, clientRequestId) {
    if (!this.ownedConversation(conversationId, ownerId)) return { user: null, assistant: null };
    const rows = this.database.prepare(`
      SELECT m.* FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = ? AND c.owner_id = ? AND m.client_request_id = ?
      ORDER BY m.rowid ASC
    `).all(conversationId, ownerId, required(clientRequestId, 'CLIENT_REQUEST_ID_REQUIRED')).map(messageRow);
    return {
      user: rows.find((row) => row.role === 'user') || null,
      assistant: rows.find((row) => row.role === 'assistant') || null
    };
  }
}
