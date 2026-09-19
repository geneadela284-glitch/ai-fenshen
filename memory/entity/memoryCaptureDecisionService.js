import crypto from 'node:crypto';

import { ENTITY_MODEL_SCHEMA_VERSION, ENTITY_RESOLUTION_STATUSES, MemoryDecision } from './contracts.js';
import {
  parseAIMemoryClassificationProposal,
  validateAIMemoryClassifier
} from './aiMemoryClassifier.js';
import {
  evaluateMemoryDecisionPolicy,
  MEMORY_DECISION_POLICY_VERSION,
  validateMemoryDecision
} from './memoryDecisionPolicy.js';

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

function assertInspector(value) {
  if (!value || typeof value.inspect !== 'function') {
    throw new TypeError('Memory decision inspector must expose inspect(input).');
  }
}

function digest(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function failClosedProposal(reasonCode) {
  return immutable({
    proposedDecision: 'confirm_before_store',
    memoryType: null,
    predicate: null,
    confidence: 0,
    importance: 0,
    sensitivity: 'restricted',
    retentionPolicy: immutable({ mode: 'none', expiresAt: null }),
    reasonCodes: Object.freeze([reasonCode]),
    suggestedStructuredValue: null,
    containsPersonalFact: false,
    needsClarification: true,
    explicitBusinessIntent: false
  });
}

function orderedDecision({ ownerUserId, sourceTextDigest, entityResolution, proposal, policy, decidedAt }) {
  const values = {
    schemaVersion: ENTITY_MODEL_SCHEMA_VERSION,
    decision: policy.decision,
    memoryType: proposal.memoryType,
    ownerUserId,
    subjectEntityId: policy.subjectEntityId,
    predicate: proposal.predicate,
    confidence: proposal.confidence,
    importance: proposal.importance,
    sensitivity: proposal.sensitivity,
    retentionPolicy: proposal.retentionPolicy,
    reasonCodes: policy.reasonCodes,
    sourceTextDigest,
    entityResolutionStatus: ENTITY_RESOLUTION_STATUSES.includes(entityResolution?.resolutionStatus)
      ? entityResolution.resolutionStatus
      : 'no_match',
    confirmationRequired: policy.confirmationRequired,
    acknowledgementPolicy: policy.acknowledgementPolicy,
    duplicateCheckRequired: policy.duplicateCheckRequired,
    suggestedStructuredValue: proposal.suggestedStructuredValue,
    responsePolicy: policy.responsePolicy,
    policyVersion: MEMORY_DECISION_POLICY_VERSION,
    decidedAt
  };
  return Object.fromEntries(MemoryDecision.fields.map((field) => [field, values[field]]));
}

export class MemoryCaptureDecisionService {
  constructor({ classifier, inspector, now = () => new Date().toISOString() }) {
    if (!validateAIMemoryClassifier(classifier).valid) throw new TypeError('AI Memory Classifier is invalid.');
    assertInspector(inspector);
    if (typeof now !== 'function') throw new TypeError('now must be a function.');
    this.classifier = classifier;
    this.inspector = inspector;
    this.now = now;
  }

  async decide({ ownerUserId, text, locale = 'zh-CN', entityResolution, conversationContext = null }) {
    requiredString(ownerUserId, 'ownerUserId');
    requiredString(text, 'text');
    requiredString(locale, 'locale');
    let proposal;
    try {
      proposal = parseAIMemoryClassificationProposal(await this.classifier.classify({
        ownerUserId,
        text,
        locale,
        entityResolution: structuredClone(entityResolution),
        conversationContext: structuredClone(conversationContext)
      }));
    } catch {
      proposal = failClosedProposal('classifier_unavailable');
    }

    const storingCandidate = !['answer_only', 'ignore'].includes(proposal.proposedDecision);
    let inspection = { conflictStatus: 'none', duplicateStatus: 'none' };
    if (storingCandidate) {
      try {
        inspection = await this.inspector.inspect({
          ownerUserId,
          subjectEntityId: entityResolution?.resolutionStatus === 'exact' ? entityResolution.entityId : null,
          predicate: proposal.predicate,
          suggestedStructuredValue: proposal.suggestedStructuredValue
        });
      } catch {
        inspection = { conflictStatus: 'unknown', duplicateStatus: 'unknown' };
      }
    }
    const policy = evaluateMemoryDecisionPolicy({ ownerUserId, entityResolution, proposal, inspection });
    const decision = orderedDecision({
      ownerUserId,
      sourceTextDigest: digest(text),
      entityResolution,
      proposal,
      policy,
      decidedAt: this.now()
    });
    const validation = validateMemoryDecision(decision);
    if (!validation.valid) throw new TypeError(`MemoryDecision validation failed: ${validation.errors.join(', ')}`);
    return immutable(decision);
  }
}

export function createMemoryCaptureDecisionService(options) {
  return new MemoryCaptureDecisionService(options);
}
