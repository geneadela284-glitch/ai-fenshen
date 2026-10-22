import crypto from 'node:crypto';
import { createInMemoryEntityFoundation } from '../entity/inMemoryFoundation.js';
import { createMemoryCaptureDecisionService } from '../entity/memoryCaptureDecisionService.js';
import { createMemoryDuplicateConflictInspector, createMemorySafeWriteService } from '../entity/memorySafeWriteService.js';
import { createMemoryLifecycleV2 } from '../entity/memoryLifecycleV2.js';
import { createMemoryCaptureStores } from '../entity/memoryCaptureStores.js';
import { SensitivePolicy } from '../capture/policies.js';
import { decodeSnapshot, encodeSnapshot } from './snapshot.js';
import { explicitMemoryText } from '../../core/memory/localEvidence.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const sensitive = new SensitivePolicy();
function projection(record) {
  return { memoryId: record.memoryId, version: record.version, text: record.structuredValue.value,
    source: record.source, updatedAt: record.updatedAt, createdAt: record.createdAt, sensitivity: record.sensitivity };
}
const relatedTerms = [
 ['工作','职业','行业','做什么','哪一行','经营','工厂','公司','老板','员工','退休'],
 ['生日','出生','生辰','几月几号'], ['喜欢','偏好','爱好','习惯'],
 ['喝','饮料','饮品','茶','咖啡'], ['住','居住','家乡','老家','哪里人'],
 ['称呼','名字','姓名','叫什么'], ['家人','家庭','妈妈','母亲','爸爸','父亲','女儿','儿子','妻子','丈夫']
];
function relevance(question, text) {
  const terms = new Set(String(question).toLowerCase().match(/[a-z0-9]{2,}|[\p{Script=Han}]{2,}/gu)?.flatMap(t =>
    /^[a-z0-9]/.test(t) ? [t] : [...t].slice(0, -1).map((c, i) => c + t[i + 1])) || []);
  for (const stop of ['什么', '哪个', '记得', '告诉', '我的', '一下', '之前', '记忆', '关于']) terms.delete(stop);
  const normalized = text.toLowerCase();
  const related = relatedTerms.filter(group=>group.some(term=>String(question).includes(term))).reduce((score,group)=>score+(group.some(term=>normalized.includes(term))?1:0),0);
  return related + [...terms].reduce((score, term) => score + (text.toLowerCase().includes(term) ? term.length : 0), 0);
}

// This adapter calls the existing V2 decision, write, repository and lifecycle contracts.
// The storage port is provided only by the authenticated native host, never localStorage.
export async function createMobileMemoryRuntime({ ownerUserId, storage, now = () => new Date().toISOString() }) {
  if (typeof ownerUserId !== 'string' || !ownerUserId || ownerUserId.length > 256) fail('OWNER_SCOPE_REQUIRED');
  if (!storage?.load || !storage?.commit) fail('LOCAL_MEMORY_UNAVAILABLE');
  const scope = hash(`memory-v2:personal:${ownerUserId}`);
  const loaded = await storage.load(scope);
  if (!Number.isSafeInteger(loaded.revision) || loaded.revision < 0 || (loaded.revision > 0 && loaded.data === null)) fail('LOCAL_MEMORY_CORRUPT');
  let revision = loaded.revision;
  const restored = decodeSnapshot(ownerUserId, loaded.data);
  // Preserve a strict order when two durable changes share one wall-clock millisecond.
  let lastCommittedAt = Math.max(0, ...[...restored.state.memories.values()].map(r => Date.parse(r.updatedAt)));
  let transactionTime = null;
  const recordTime = () => transactionTime || now();
  let requests = restored.requests, pendingCommit = null, closed = false, tail = Promise.resolve();
  const confirmations = createMemoryCaptureStores({ now, pendingTtlMs: 300000 }).pendingCandidates;
  const foundation = createInMemoryEntityFoundation({ initialState: restored.state, now: recordTime,
    beforeCommit: async state => {
      const nextRequests = Object.assign(Object.create(null), requests);
      if (pendingCommit) {
        const { requestId, digest, findRecord, status } = pendingCommit;
        const record = [...state.memories.values()].find(findRecord);
        if (!record) fail('LOCAL_MEMORY_RECEIPT_MISSING');
        nextRequests[requestId] = { digest, memoryId: record.memoryId, version: record.version, status };
      }
      const committed = await storage.commit(scope, { expectedRevision: revision, data: encodeSnapshot(ownerUserId, state, nextRequests) });
      if (committed.revision !== revision + 1) fail('LOCAL_MEMORY_RECEIPT_INVALID');
      revision = committed.revision; requests = nextRequests;
      lastCommittedAt = Math.max(lastCommittedAt, Date.parse(recordTime()));
    }
  });
  const self = foundation.repository.ensureSelfEntity(ownerUserId);
  const resolution = { ownerUserId, entityId: self.entityId, entityType: self.type,
    resolutionStatus: 'exact', resolutionMethod: 'authenticated_self', resolvedAt: now(), evidence: [] };
  const inspector = createMemoryDuplicateConflictInspector({ memories: foundation.memories, now: recordTime });
  const writer = createMemorySafeWriteService({ foundation, inspector, now: recordTime, memoryIdFactory: () => `mem_${crypto.randomUUID()}` });
  const lifecycle = createMemoryLifecycleV2({ foundation, correctionSensitivity: (_current, command) => sensitive.evaluate(command.structuredValue.value).sensitivity, now: recordTime, memoryIdFactory: () => `mem_${crypto.randomUUID()}` });
  function records() {
    return foundation.memories.queryByEntityAndPredicate(ownerUserId, self.entityId, 'fact_statement', { status: 'confirmed' })
      .filter(r => !r.supersededById && !r.conflictGroupId && (!r.expiresAt || Date.parse(r.expiresAt) > Date.parse(now())) &&
        (!r.effectiveTo || Date.parse(r.effectiveTo) > Date.parse(now())));
  }
  function receipt(entry) {
    return { status: entry.status, memoryId: entry.memoryId, version: entry.version,
      receipt: { durable: true, revision, ownerUserId, spaceId: 'personal', memoryId: entry.memoryId, version: entry.version } };
  }
  async function mutate(command, confirmed = false) {
    const { operation, requestId } = command;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 160) fail('REQUEST_ID_REQUIRED');
    const digest = hash(JSON.stringify([operation, command.text || '', command.memoryId || '', command.expectedVersion || 0, command.source || null]));
    const replay = Object.hasOwn(requests, requestId) ? requests[requestId] : null;
    if (replay) {
      if (replay.digest !== digest) fail('IDEMPOTENCY_CONFLICT');
      const current = foundation.memories.getById(ownerUserId, replay.memoryId);
      if (!current || current.version !== replay.version || (replay.status !== 'deleted' && current.status !== 'confirmed')) fail('MEMORY_REQUEST_OBSOLETE');
      return receipt(replay);
    }
    const value = operation === 'remember' ? explicitMemoryText(command.text) : String(command.text || '').trim();
    if (operation === 'remember' && command.source?.type !== 'user_text' && command.source?.type !== 'user_voice') return { status: 'rejected', reason: 'user_source_required' };
    if (operation === 'remember' && (!command.source?.id || typeof command.source.id !== 'string' || command.source.id.length > 200)) fail('SOURCE_REQUIRED');
    if (operation !== 'delete' && !value) return { status: 'ignored' };
    if (value?.length > 2000) fail('MEMORY_TEXT_TOO_LONG');
    const policy = sensitive.evaluate(value);
    if (policy.prohibited) return { status: 'rejected', reason: 'secret_not_stored' };
    if ((policy.sensitivity === 'high' && !confirmed) || (operation !== 'remember' && command.confirmed !== true)) {
      const { confirmationToken } = confirmations.create(ownerUserId, { command });
      return { status: 'confirmation_required', confirmationToken, text: value, operation };
    }
    try {
      transactionTime = new Date(Math.max(Date.parse(now()), lastCommittedAt + 1)).toISOString();
      if (operation === 'remember') {
        const classifier = { classify: async () => ({ proposedDecision: policy.sensitivity === 'high' ? 'confirm_before_store' : 'store_silently',
          memoryType: 'fact', predicate: 'fact_statement', confidence: 1, importance: 0.8, sensitivity: policy.sensitivity,
          retentionPolicy: { mode: 'long_term', expiresAt: null }, reasonCodes: ['explicit_user_statement'],
          suggestedStructuredValue: { value }, containsPersonalFact: true, needsClarification: false, explicitBusinessIntent: false }) };
        const decision = await createMemoryCaptureDecisionService({ classifier, inspector, now }).decide({ ownerUserId, text: command.text, entityResolution: resolution });
        if (!['store_silently', 'confirm_before_store'].includes(decision.decision)) fail('MEMORY_POLICY_REJECTED');
        pendingCommit = { requestId, digest, status: 'stored', findRecord: r => r.status === 'confirmed' && r.predicate === 'fact_statement' && r.structuredValue.value === value };
        const result = await writer.write({ ownerUserId, resolution, decision, idempotencyKey: `mobile:${requestId}`,
          confirmationStatus: 'user_confirmed', sourceMessageId: command.source.id });
        if (result.outcome === 'duplicate_detected') await foundation.unitOfWork.run({ ownerUserId }, async () => null);
        else if (result.outcome !== 'memory_written') fail('MEMORY_WRITE_NOT_COMPLETED');
      } else {
        const current = foundation.memories.getById(ownerUserId, command.memoryId);
        if (!current) fail('MEMORY_NOT_FOUND');
        pendingCommit = { requestId, digest, status: operation === 'delete' ? 'deleted' : 'corrected',
          findRecord: r => operation === 'delete' ? r.memoryId === command.memoryId : r.supersedesId === command.memoryId && r.status === 'confirmed' };
        await lifecycle.execute({ ownerUserId }, { schemaVersion: 'v2', lifecycleAction: operation === 'correct' ? 'correction' : 'delete',
          subjectEntityId: current.subjectEntityId, predicate: current.predicate, memoryId: current.memoryId,
          expectedVersion: command.expectedVersion, idempotencyKey: `mobile:${requestId}`, structuredValue: operation === 'correct' ? { value } : null,
          confirmed: false, sourceMessageId: command.source?.id || `memory-management:${requestId}` });
      }
      return receipt(requests[requestId]);
    } finally { pendingCommit = null; transactionTime = null; }
  }
  async function execute(command) {
    if (closed) fail('LOCAL_MEMORY_CLOSED');
    if (!command || typeof command !== 'object') fail('MEMORY_COMMAND_INVALID');
    if (command.ownerUserId && command.ownerUserId !== ownerUserId) fail('OWNER_SCOPE_MISMATCH');
    if (command.spaceId && command.spaceId !== 'personal') fail('SPACE_SCOPE_MISMATCH');
    if (command.operation === 'receipt') {
      const entry = Object.hasOwn(requests, command.requestId) ? requests[command.requestId] : null;
      if (!entry) return { status: 'not_saved' };
      const current = foundation.memories.getById(ownerUserId, entry.memoryId);
      if (!current || current.version !== entry.version || current.status !== 'confirmed') return { status: 'withdrawn' };
      return receipt(entry);
    }
    if (command.operation === 'get') {
      if (!Array.isArray(command.references) || command.references.length > 6) fail('MEMORY_COMMAND_INVALID');
      const valid = new Map(records().map(record => [record.memoryId, record]));
      return { status: 'available', items: command.references.map(ref => valid.get(ref.memoryId))
        .filter((record, index) => record && record.version === command.references[index].version).map(projection) };
    }
    if (command.operation === 'list' || command.operation === 'query') {
      const question = String(command.text || '').slice(0, 4000);
      let items = records().map(record => ({ record, score: relevance(question, record.structuredValue.value) }));
      if (question) items = items.filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt));
      else if (command.operation === 'query') items = [];
      const limit = command.operation === 'query' ? 6 : 50;
      const offset = command.operation === 'list' && Number.isSafeInteger(command.offset) && command.offset > 0 ? command.offset : 0;
      let chars = 0;
      const selected = items.slice(offset, offset + limit).filter(({ record }) => (chars += record.structuredValue.value.length) <= (command.operation === 'query' ? 3000 : 100000));
      const revoked = foundation.memories.listByEntityAndPredicateForLifecycle(ownerUserId, self.entityId, 'fact_statement')
        .filter(record => record.status !== 'confirmed').sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 100)
        .map(record => ({ memoryId: record.memoryId, sourceId: record.source.id }));
      return { status: 'available', revision, items: selected.map(({ record }) => projection(record)), revoked,
        total: items.length, nextOffset: offset + selected.length < items.length ? offset + selected.length : null };
    }
    if (command.operation === 'confirm') {
      let entry;
      try { entry = confirmations.get(ownerUserId, command.confirmationToken); } catch { fail('MEMORY_CONFIRMATION_EXPIRED'); }
      const result = await mutate({ ...entry.candidate.command, confirmed: true }, true);
      confirmations.consume(ownerUserId, command.confirmationToken); return result;
    }
    if (!['remember', 'correct', 'delete'].includes(command.operation)) fail('MEMORY_OPERATION_UNSUPPORTED');
    return mutate(command);
  }
  return Object.freeze({ execute: command => { const scheduled = tail.then(() => execute(command)); tail = scheduled.catch(() => {}); return scheduled; },
    close() { closed = true; confirmations.clearOwner(ownerUserId); } });
}
