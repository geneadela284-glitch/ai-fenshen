import { ENTITY_ID_PATTERN } from './contracts.js';
import { ENTITY_RESOLUTION_PURPOSES, validateAIEntityResolver } from './aiEntityResolver.js';
import { parseEntityReferenceProposal } from './entityReferenceParser.js';

function immutable(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) immutable(child);
  return Object.freeze(value);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} is required.`);
  }
  return value;
}

function isoTimestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`${field} must be an ISO timestamp.`);
  }
  return value;
}

function assertMethod(value, method, label) {
  if (!value || typeof value[method] !== 'function') {
    throw new TypeError(`${label} must expose ${method}().`);
  }
}

function noMatch(ownerUserId, reason, safeNextAction = 'ask_for_identity_clarification') {
  return immutable({ resolutionStatus: 'no_match', ownerUserId, reason, safeNextAction });
}

function deduplicate(candidates) {
  const byId = new Map();
  for (const candidate of candidates) {
    const existing = byId.get(candidate.entity.entityId);
    if (!existing) {
      byId.set(candidate.entity.entityId, {
        entity: candidate.entity,
        confidence: candidate.confidence,
        evidence: [...candidate.evidence]
      });
      continue;
    }
    existing.confidence = Math.min(existing.confidence, candidate.confidence);
    existing.evidence.push(...candidate.evidence);
  }
  return [...byId.values()].sort((left, right) =>
    left.entity.entityId < right.entity.entityId ? -1 : left.entity.entityId > right.entity.entityId ? 1 : 0);
}

function activeOwnerEntity(repository, ownerUserId, entityId) {
  if (!ENTITY_ID_PATTERN.test(String(entityId || ''))) return null;
  const entity = repository.getById(ownerUserId, entityId);
  if (!entity || entity.ownerUserId !== ownerUserId || entity.status !== 'active') return null;
  return entity;
}

function candidate(entity, confidence, evidence) {
  return { entity, confidence, evidence: [evidence] };
}

function clarificationQuestion(proposal) {
  if (proposal.role === 'daughter') return '你说的是哪一位女儿？';
  if (proposal.alias) return `“${proposal.alias}”对应多个人，你指的是哪一位？`;
  return '你指的是哪一位？';
}

function resultFromCandidates({ ownerUserId, proposal, candidates, resolvedAt }) {
  const unique = deduplicate(candidates);
  if (unique.length === 0) return noMatch(ownerUserId, 'no_owner_scoped_candidate');
  if (unique.length > 1) {
    return immutable({
      resolutionStatus: 'ambiguous',
      ownerUserId,
      candidates: unique.map(({ entity }) => ({
        entityId: entity.entityId,
        entityType: entity.type
      })),
      clarificationQuestion: clarificationQuestion(proposal),
      evidence: unique.flatMap((value) => value.evidence),
      resolvedAt
    });
  }
  if (proposal.needsClarification) {
    return noMatch(ownerUserId, 'semantic_clarification_required');
  }
  const [resolved] = unique;
  return immutable({
    resolutionStatus: 'exact',
    ownerUserId,
    entityId: resolved.entity.entityId,
    entityType: resolved.entity.type,
    evidence: resolved.evidence,
    confidence: resolved.confidence,
    resolutionMethod: proposal.kind === 'context' ? 'conversation_context' : proposal.kind,
    resolvedAt
  });
}

export class EntityResolutionService {
  constructor({ repository, aliases, relations, aiResolver, conversationContext, now = () => new Date().toISOString() }) {
    assertMethod(repository, 'getById', 'Entity Repository');
    assertMethod(repository, 'listByOwner', 'Entity Repository');
    assertMethod(aliases, 'findByAlias', 'Alias Repository');
    assertMethod(relations, 'findEffectiveRelations', 'Relation Repository');
    if (!validateAIEntityResolver(aiResolver).valid) throw new TypeError('AI Entity Resolver is invalid.');
    assertMethod(conversationContext, 'get', 'Conversation Entity Context');
    assertMethod(conversationContext, 'recordExact', 'Conversation Entity Context');
    assertMethod(conversationContext, 'clear', 'Conversation Entity Context');
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    this.repository = repository;
    this.aliases = aliases;
    this.relations = relations;
    this.aiResolver = aiResolver;
    this.conversationContext = conversationContext;
    this.now = now;
  }

  async resolve({ ownerUserId, text, locale = 'zh-CN', conversationId, purpose, effectiveAt = this.now() }) {
    requiredString(ownerUserId, 'ownerUserId');
    requiredString(text, 'text');
    requiredString(locale, 'locale');
    requiredString(conversationId, 'conversationId');
    if (!ENTITY_RESOLUTION_PURPOSES.includes(purpose)) {
      throw new TypeError('purpose must be capture or recall.');
    }
    isoTimestamp(effectiveAt, 'effectiveAt');
    const contextScope = { ownerUserId, conversationId, at: effectiveAt };
    const conversationEntityContext = this.conversationContext.snapshot
      ? this.conversationContext.snapshot(contextScope)
      : this.conversationContext.get(contextScope);
    let proposal;
    try {
      proposal = parseEntityReferenceProposal(await this.aiResolver.resolve({
        ownerUserId,
        text,
        locale,
        conversationEntityContext,
        purpose
      }));
    } catch {
      this.conversationContext.clear({ ownerUserId, conversationId });
      return noMatch(ownerUserId, 'invalid_ai_proposal');
    }

    const resolvedAt = this.now();
    let candidates = [];
    if (proposal.kind === 'self') {
      candidates = this.repository.listByOwner(ownerUserId, { status: 'active' })
        .filter((entity) => entity.metadata?.entityRole === 'self')
        .map((entity) => candidate(entity, 1, {
          type: 'self_entity', entityId: entity.entityId
        }));
    } else if (proposal.kind === 'entity') {
      const entity = activeOwnerEntity(this.repository, ownerUserId, proposal.entityId);
      if (entity) candidates = [candidate(entity, 1, {
        type: 'verified_entity', entityId: entity.entityId
      })];
    } else if (proposal.kind === 'alias' || proposal.kind === 'alias_relation') {
      candidates = this.aliases.findByAlias(ownerUserId, proposal.alias)
        .map((alias) => {
          const entity = activeOwnerEntity(this.repository, ownerUserId, alias.entityId);
          return entity ? candidate(entity, alias.confidence, {
            type: 'active_alias', alias: alias.alias, entityId: alias.entityId,
            confidence: alias.confidence
          }) : null;
        }).filter(Boolean);
    } else if (proposal.kind === 'relation') {
      candidates = this.#relationCandidates(ownerUserId, effectiveAt, proposal);
    } else if (proposal.kind === 'context') {
      const context = this.conversationContext.get(contextScope);
      const entity = context
        ? activeOwnerEntity(this.repository, ownerUserId, context.entityId)
        : null;
      if (entity) candidates = [candidate(entity, 1, {
        type: 'conversation_context', entityId: entity.entityId,
        recordedAt: context.recordedAt
      })];
    }

    if (proposal.kind === 'alias_relation') {
      const relationIds = new Set(this.#relationCandidates(ownerUserId, effectiveAt, proposal)
        .map((value) => value.entity.entityId));
      candidates = candidates.filter((value) => relationIds.has(value.entity.entityId));
      candidates = candidates.map((value) => ({
        ...value,
        evidence: [...value.evidence, {
          type: 'effective_relation_match', relationKind: proposal.relationKind, role: proposal.role
        }]
      }));
    }

    const result = proposal.kind === 'none'
      ? noMatch(ownerUserId, 'no_entity_mention')
      : resultFromCandidates({ ownerUserId, proposal, candidates, resolvedAt });
    if (result.resolutionStatus === 'exact') {
      this.conversationContext.recordExact({
        ownerUserId,
        conversationId,
        entityId: result.entityId,
        entityType: result.entityType
      });
    } else if (result.resolutionStatus === 'ambiguous' || proposal.kind !== 'context') {
      this.conversationContext.clear({ ownerUserId, conversationId });
    }
    return result;
  }

  #relationCandidates(ownerUserId, effectiveAt, proposal) {
    const selfEntities = this.repository.listByOwner(ownerUserId, { status: 'active' })
      .filter((entity) => entity.metadata?.entityRole === 'self');
    if (selfEntities.length !== 1) return [];
    const filters = {
      sourceEntityId: selfEntities[0].entityId,
      relationKind: proposal.relationKind,
      role: proposal.role
    };
    return this.relations.findEffectiveRelations(ownerUserId, effectiveAt, filters)
      .map((relation) => {
        const entity = activeOwnerEntity(this.repository, ownerUserId, relation.targetEntityId);
        return entity ? candidate(entity, 1, {
          type: 'effective_relation', relationId: relation.relationId,
          relationKind: relation.relationKind, role: relation.role,
          entityId: entity.entityId
        }) : null;
      }).filter(Boolean);
  }
}

export function createEntityResolutionService(options) {
  return new EntityResolutionService(options);
}
