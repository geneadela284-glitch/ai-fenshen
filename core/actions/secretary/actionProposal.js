import { isActionType } from './actionTypes.js';

const SENSITIVE_KEY = /(?:api[_-]?key|password|passwd|cookie|token|secret|authorization)/i;
const PROPOSERS = new Set(['ai', 'program', 'user']);

function defaultIdGenerator() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function containsSensitiveField(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    SENSITIVE_KEY.test(key) || containsSensitiveField(child)
  ));
}

function text(value = '', max = 240) {
  return String(value || '').trim().slice(0, max);
}

export function createActionProposal({
  actionName,
  actionType,
  arguments: actionArguments = {},
  source = {},
  userId = '',
  workspaceId = '',
  conversationId = '',
  confidence = 1,
  proposedBy = 'program',
  createdAt = '',
  now = new Date(),
  idempotencyKey = '',
  idGenerator = defaultIdGenerator
} = {}) {
  const normalizedName = text(actionName, 80);
  if (!normalizedName) throw new Error('Action Proposal 缺少 actionName');
  if (!isActionType(actionType)) throw new Error(`Action Proposal actionType 无效: ${String(actionType || '')}`);
  if (!actionArguments || typeof actionArguments !== 'object' || Array.isArray(actionArguments)) {
    throw new Error('Action Proposal arguments 必须是对象');
  }
  if (containsSensitiveField(actionArguments) || containsSensitiveField(source)) {
    throw new Error('Action Proposal 禁止包含敏感字段');
  }
  if (!PROPOSERS.has(proposedBy)) throw new Error(`Action Proposal proposedBy 无效: ${String(proposedBy || '')}`);

  const proposalId = text(idGenerator(), 120);
  const timestamp = createdAt || (now instanceof Date ? now : new Date(now)).toISOString();
  return Object.freeze({
    schemaVersion: 'v1',
    proposalId,
    actionName: normalizedName,
    actionType,
    arguments: Object.freeze({ ...actionArguments }),
    source: Object.freeze({
      type: text(source.type || 'unknown', 80),
      id: text(source.id, 160)
    }),
    userId: text(userId, 160),
    workspaceId: text(workspaceId, 160),
    conversationId: text(conversationId, 160),
    confidence: Math.max(0, Math.min(1, Number(confidence ?? 1))),
    proposedBy,
    createdAt: timestamp,
    idempotencyKey: text(idempotencyKey || proposalId, 200)
  });
}
