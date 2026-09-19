import { workSecretaryConversationRepository } from './conversationRepository.js';

const ACTIVE_CONVERSATION_KEY = 'work-secretary-active-conversation-id';
const DEFAULT_CONVERSATION_ID = 'work-secretary-default-conversation';
const maxConversationMessages = 80;

function now() {
  return new Date().toISOString();
}

function createConversationId() {
  return `conversation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createMessageId(role = 'message') {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function safeText(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value.trim() || fallback;
  if (typeof value === 'object') return safeText(value.title || value.content || value.userInput || value.result, fallback);
  return String(value);
}

function buildTitle(input = '') {
  const title = safeText(input, '新的对话').replace(/\s+/g, ' ');
  return title.length > 24 ? `${title.slice(0, 24)}...` : title;
}

function normalizeMessage(message = {}) {
  return {
    id: String(message.id || createMessageId(message.role || 'message')),
    role: ['user', 'assistant', 'system'].includes(message.role) ? message.role : 'user',
    content: safeText(message.content, ''),
    createdAt: message.createdAt || now(),
    attachmentIds: Array.isArray(message.attachmentIds) ? message.attachmentIds.map(String) : [],
    resultId: String(message.resultId || ''),
    error: safeText(message.error, ''),
    metadata: message.metadata && typeof message.metadata === 'object' ? message.metadata : {}
  };
}

function normalizeConversation(conversation = {}) {
  const createdAt = conversation.createdAt || now();
  const messages = Array.isArray(conversation.messages) ? conversation.messages.map(normalizeMessage) : [];
  const updatedAt = conversation.updatedAt || messages.at(-1)?.createdAt || createdAt;
  return {
    id: String(conversation.id || conversation.conversationId || createConversationId()),
    conversationId: String(conversation.conversationId || conversation.id || createConversationId()),
    title: safeText(conversation.title, '新的对话'),
    createdAt,
    updatedAt,
    messages: messages.slice(-maxConversationMessages),
    summary: safeText(conversation.summary, ''),
    status: safeText(conversation.status, 'active')
  };
}

function taskToMessages(task = {}) {
  const messages = [];
  const createdAt = task.createdAt || now();
  if (safeText(task.userInput, '')) {
    messages.push(normalizeMessage({
      role: 'user',
      content: task.userInput,
      createdAt,
      attachmentIds: (task.attachments || []).map((item) => item.id).filter(Boolean),
      resultId: task.taskId,
      metadata: { taskId: task.taskId, taskStatus: task.status }
    }));
  }
  if (safeText(task.result || task.error, '')) {
    messages.push(normalizeMessage({
      role: 'assistant',
      content: task.result || task.error,
      createdAt: task.completedAt || task.updatedAt || createdAt,
      resultId: task.taskId,
      error: task.error || '',
      metadata: { taskId: task.taskId, taskStatus: task.status }
    }));
  }
  return messages;
}

function dedupeMessages(messages = []) {
  const seen = new Set();
  return messages.filter((message) => {
    const key = `${message.role}:${message.resultId}:${message.content.slice(0, 120)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class WorkSecretaryConversationManager {
  constructor({ repository = workSecretaryConversationRepository } = {}) {
    this.repository = repository;
  }

  listConversations(tasks = []) {
    this.ensureLegacyConversation(tasks);
    return this.repository
      .readAll()
      .map(normalizeConversation)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  getConversation(conversationId, tasks = []) {
    this.ensureLegacyConversation(tasks);
    return normalizeConversation(this.repository.read(conversationId) || this.getOrCreateActiveConversation(tasks));
  }

  getActiveConversationId(tasks = []) {
    this.ensureLegacyConversation(tasks);
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(ACTIVE_CONVERSATION_KEY) : '';
    if (stored && this.repository.read(stored)) return stored;
    const first = this.listConversations(tasks)[0] || this.createConversation();
    this.setActiveConversation(first.conversationId);
    return first.conversationId;
  }

  getOrCreateActiveConversation(tasks = []) {
    const activeId = this.getActiveConversationId(tasks);
    return normalizeConversation(this.repository.read(activeId));
  }

  setActiveConversation(conversationId) {
    if (typeof localStorage !== 'undefined') localStorage.setItem(ACTIVE_CONVERSATION_KEY, conversationId);
    return this.repository.read(conversationId) ? normalizeConversation(this.repository.read(conversationId)) : null;
  }

  createConversation(title = '新的对话') {
    const createdAt = now();
    const conversation = normalizeConversation({
      id: createConversationId(),
      title,
      createdAt,
      updatedAt: createdAt,
      messages: [],
      summary: '',
      status: 'active'
    });
    this.repository.create(conversation);
    this.setActiveConversation(conversation.conversationId);
    return conversation;
  }

  renameConversation(conversationId, title) {
    const text = safeText(title, '');
    if (!text) return this.repository.read(conversationId);
    return normalizeConversation(this.repository.update(conversationId, {
      title: buildTitle(text),
      updatedAt: now()
    }));
  }

  deleteConversation(conversationId) {
    this.repository.delete(conversationId);
    const remaining = this.listConversations();
    const next = remaining[0] || this.createConversation();
    this.setActiveConversation(next.conversationId);
    return next;
  }

  syncTask(conversationId, task = {}) {
    const existing = this.repository.read(conversationId) || this.createConversation(safeText(task.userInput, '新的对话'));
    const conversation = normalizeConversation(existing);
    const newMessages = taskToMessages(task);
    const messages = dedupeMessages([...conversation.messages.filter((message) => message.resultId !== task.taskId), ...newMessages])
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      .slice(-maxConversationMessages);
    const updatedAt = task.updatedAt || task.completedAt || now();
    const title = conversation.messages.length || !task.userInput ? conversation.title : buildTitle(task.userInput);
    return normalizeConversation(this.repository.update(conversation.conversationId, {
      ...conversation,
      title,
      messages,
      summary: this.buildSummary(messages),
      status: task.status === 'processing' ? 'active' : 'idle',
      updatedAt
    }));
  }

  buildContext(conversationId, pendingInput = '') {
    const conversation = this.getConversation(conversationId);
    const recentMessages = conversation.messages
      .filter((message) => safeText(message.content, ''))
      .slice(-8)
      .map((message) => ({
        role: message.role,
        content: message.content.slice(0, 1600),
        createdAt: message.createdAt
      }));
    return {
      conversationId: conversation.conversationId,
      title: conversation.title,
      summary: conversation.summary,
      recentMessages,
      pendingInput: safeText(pendingInput, '')
    };
  }

  ensureLegacyConversation(tasks = []) {
    const existing = this.repository.readAll();
    if (existing.length || !tasks.length) return;
    const orderedTasks = tasks
      .filter((task) => safeText(task.userInput, ''))
      .sort((a, b) => new Date(a.createdAt || a.updatedAt || 0) - new Date(b.createdAt || b.updatedAt || 0));
    if (!orderedTasks.length) return;
    const messages = dedupeMessages(orderedTasks.flatMap(taskToMessages));
    const firstInput = orderedTasks[0]?.userInput || '历史对话';
    const updatedAt = orderedTasks.at(-1)?.updatedAt || orderedTasks.at(-1)?.completedAt || now();
    const conversation = normalizeConversation({
      id: DEFAULT_CONVERSATION_ID,
      title: buildTitle(firstInput),
      createdAt: orderedTasks[0]?.createdAt || now(),
      updatedAt,
      messages,
      summary: this.buildSummary(messages),
      status: 'idle'
    });
    this.repository.create(conversation);
    this.setActiveConversation(conversation.conversationId);
  }

  buildSummary(messages = []) {
    const text = messages
      .filter((message) => message.role === 'assistant' || message.role === 'user')
      .slice(-6)
      .map((message) => `${message.role === 'user' ? '用户' : 'AI'}：${message.content}`)
      .join('\n');
    return text.slice(0, 2400);
  }
}

export const workSecretaryConversationManager = new WorkSecretaryConversationManager();
