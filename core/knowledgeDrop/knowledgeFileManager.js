import { eventManager } from '../events/index.js';
import { knowledgeFileRepository } from './knowledgeFileRepository.js';

const allowedExtensions = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'md', 'markdown', 'png', 'jpg', 'jpeg', 'gif', 'webp']);
const allowedMimePrefixes = ['image/'];

function now() {
  return new Date().toISOString();
}

function createId() {
  return `knowledge-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function extensionOf(name = '') {
  return String(name).toLowerCase().split('.').pop() || '';
}

function isAllowedFile(file = {}) {
  const extension = extensionOf(file.name);
  return allowedExtensions.has(extension) || allowedMimePrefixes.some((prefix) => String(file.type || '').startsWith(prefix));
}

function normalizeFile(file = {}) {
  const createdAt = file.createdAt || now();
  return {
    id: file.id || createId(),
    name: String(file.name || '未命名资料'),
    type: String(file.type || 'application/octet-stream'),
    size: Number(file.size || 0),
    localPath: String(file.localPath || `local-ref://${file.id || createId()}`),
    status: ['waiting', 'processing', 'ready', 'failed'].includes(file.status) ? file.status : 'waiting',
    error: file.error || '',
    parseStatus: file.parseStatus || 'not_available',
    createdAt
  };
}

export class KnowledgeFileManager {
  constructor({ repository = knowledgeFileRepository, events = eventManager } = {}) {
    this.repository = repository;
    this.events = events;
  }

  listFiles() {
    return this.repository.readAll().map(normalizeFile).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  getFile(fileId) {
    const file = this.repository.read(fileId);
    return file ? normalizeFile(file) : null;
  }

  addFile(file = {}) {
    const supported = isAllowedFile(file);
    const normalized = normalizeFile({
      ...file,
      status: supported ? 'ready' : 'failed',
      error: supported ? '' : '暂不支持该文件类型。'
    });
    this.repository.create(normalized);
    this.events.createEvent({
      type: 'document',
      source: 'knowledge-drop',
      title: 'knowledge_file_added',
      content: normalized.name,
      tags: ['knowledge_file_added', normalized.status],
      status: normalized.status === 'ready' ? 'done' : 'open',
      priority: 'normal',
      metadata: {
        eventType: 'knowledge_file_added',
        fileId: normalized.id,
        name: normalized.name,
        status: normalized.status
      }
    });
    return normalized;
  }

  deleteFile(fileId) {
    return this.repository.delete(fileId);
  }
}

export const knowledgeFileManager = new KnowledgeFileManager();
