import assert from 'node:assert/strict';
import test from 'node:test';

import { ENTITY_TEST_IDS } from '../../testing/entityFixtures.js';
import { FakeAIMemoryClassifier } from '../../testing/fakeAIMemoryClassifier.js';
import * as Contracts from './contracts.js';

const Classifier = await import('./aiMemoryClassifier.js').catch(() => ({}));
const DecisionService = await import('./memoryCaptureDecisionService.js').catch(() => ({}));

const NOW = '2026-07-17T08:00:00.000Z';

function exactResolution(overrides = {}) {
  return {
    resolutionStatus: 'exact',
    ownerUserId: ENTITY_TEST_IDS.owner,
    entityId: ENTITY_TEST_IDS.self,
    entityType: 'person',
    evidence: [{ type: 'self_entity', entityId: ENTITY_TEST_IDS.self }],
    confidence: 1,
    resolutionMethod: 'self',
    resolvedAt: NOW,
    ...structuredClone(overrides)
  };
}

function proposal(overrides = {}) {
  return {
    proposedDecision: 'store_silently',
    memoryType: 'fact',
    predicate: 'birthday',
    confidence: 0.96,
    importance: 0.8,
    sensitivity: 'low',
    retentionPolicy: { mode: 'long_term', expiresAt: null },
    reasonCodes: ['long_term_personal_fact'],
    suggestedStructuredValue: { date: '1968-05-06' },
    containsPersonalFact: true,
    needsClarification: false,
    explicitBusinessIntent: false,
    ...structuredClone(overrides)
  };
}

function fakeInspector(result = {}) {
  return {
    calls: [],
    async inspect(input) {
      this.calls.push(structuredClone(input));
      return {
        conflictStatus: 'none',
        duplicateStatus: 'none',
        ...structuredClone(result)
      };
    }
  };
}

function serviceFor(text, configuredProposal, options = {}) {
  assert.equal(typeof DecisionService.createMemoryCaptureDecisionService, 'function');
  const classifier = new FakeAIMemoryClassifier({ [text]: configuredProposal });
  const inspector = options.inspector ?? fakeInspector();
  const service = DecisionService.createMemoryCaptureDecisionService({
    classifier,
    inspector,
    now: () => NOW
  });
  return { service, classifier, inspector };
}

async function decide(service, text, overrides = {}) {
  return service.decide({
    ownerUserId: ENTITY_TEST_IDS.owner,
    text,
    locale: 'zh-CN',
    entityResolution: exactResolution(),
    conversationContext: null,
    ...overrides
  });
}

test('AI Memory Classifier port accepts classify() and rejects write-shaped ports', () => {
  assert.equal(typeof Classifier.validateAIMemoryClassifier, 'function');
  assert.equal(Classifier.validateAIMemoryClassifier(new FakeAIMemoryClassifier()).valid, true);
  assert.equal(Classifier.validateAIMemoryClassifier({ write() {} }).valid, false);
});

test('AI classification proposal keeps confidence and importance independent', () => {
  const parsed = Classifier.parseAIMemoryClassificationProposal(proposal({
    confidence: 0.91,
    importance: 0.42
  }));
  assert.equal(parsed.confidence, 0.91);
  assert.equal(parsed.importance, 0.42);
});

test('AI classification proposal is closed and cannot supply Entity identity or write instructions', () => {
  for (const extra of [
    { subjectEntityId: ENTITY_TEST_IDS.self },
    { ownerUserId: ENTITY_TEST_IDS.owner },
    { writeToDatabase: true }
  ]) {
    assert.throws(
      () => Classifier.parseAIMemoryClassificationProposal(proposal(extra)),
      /unknown field/i
    );
  }
});

test('habit is rejected while habit_candidate remains valid', () => {
  assert.throws(
    () => Classifier.parseAIMemoryClassificationProposal(proposal({ memoryType: 'habit' })),
    /memoryType/i
  );
  assert.equal(Classifier.parseAIMemoryClassificationProposal(proposal({
    memoryType: 'habit_candidate',
    predicate: 'habit_observation',
    suggestedStructuredValue: { summary: '晨跑一次', observedAt: NOW }
  })).memoryType, 'habit_candidate');
});

test('ordinary information query is answer_only and creates no memory acknowledgement', async () => {
  const text = '我妈妈什么时候生日？';
  const { service } = serviceFor(text, proposal({
    proposedDecision: 'answer_only',
    memoryType: null,
    predicate: null,
    importance: 0,
    retentionPolicy: { mode: 'none', expiresAt: null },
    reasonCodes: ['information_query'],
    suggestedStructuredValue: null,
    containsPersonalFact: false
  }));
  const result = await decide(service, text);
  assert.equal(result.decision, 'answer_only');
  assert.equal(result.acknowledgementPolicy, 'none');
  assert.equal(result.confirmationRequired, false);
});

test('low-value declarative chat is ignore rather than saved by sentence shape', async () => {
  const text = '我刚喝了一口水。';
  const { service } = serviceFor(text, proposal({
    proposedDecision: 'ignore',
    memoryType: null,
    predicate: null,
    importance: 0.05,
    retentionPolicy: { mode: 'none', expiresAt: null },
    reasonCodes: ['low_long_term_value'],
    suggestedStructuredValue: null,
    containsPersonalFact: false
  }));
  assert.equal((await decide(service, text)).decision, 'ignore');
});

test('time-limited personal state becomes temporary_context with bounded retention', async () => {
  const text = '这几天我在出差。';
  const { service } = serviceFor(text, proposal({
    proposedDecision: 'temporary_context',
    memoryType: 'temporary_context',
    predicate: 'temporary_presence',
    importance: 0.4,
    retentionPolicy: { mode: 'ttl', expiresAt: '2026-07-21T00:00:00.000Z' },
    reasonCodes: ['time_bounded_context'],
    suggestedStructuredValue: {
      summary: '用户正在出差',
      expiresAt: '2026-07-21T00:00:00.000Z'
    }
  }));
  const result = await decide(service, text);
  assert.equal(result.decision, 'temporary_context');
  assert.equal(result.retentionPolicy.mode, 'ttl');
});

test('low-risk exact birthday fact is store_silently without memory theatre', async () => {
  const text = '我妈妈5月6号生日。';
  const { service } = serviceFor(text, proposal());
  const result = await decide(service, text, {
    entityResolution: exactResolution({ entityId: ENTITY_TEST_IDS.friendOne })
  });
  assert.equal(result.decision, 'store_silently');
  assert.equal(result.subjectEntityId, ENTITY_TEST_IDS.friendOne);
  assert.equal(result.acknowledgementPolicy, 'silent');
  assert.equal('acknowledgementText' in result, false);
});

test('sensitive or uncertain health information requires confirmation', async () => {
  const text = '我好像对青霉素过敏。';
  const { service } = serviceFor(text, proposal({
    proposedDecision: 'store_silently',
    memoryType: 'health_record',
    predicate: 'health_observation',
    confidence: 0.55,
    importance: 0.95,
    sensitivity: 'high',
    reasonCodes: ['possible_health_risk'],
    suggestedStructuredValue: { summary: '可能对青霉素过敏' },
    needsClarification: true
  }));
  const result = await decide(service, text);
  assert.equal(result.decision, 'confirm_before_store');
  assert.equal(result.confirmationRequired, true);
});

test('high confidence cannot turn low importance into silent long-term storage', async () => {
  const text = '一个确定但没有长期价值的细节。';
  const { service } = serviceFor(text, proposal({
    confidence: 0.99,
    importance: 0.1,
    reasonCodes: ['low_long_term_value']
  }));
  const result = await decide(service, text);
  assert.equal(result.decision, 'ignore');
  assert.ok(result.reasonCodes.includes('importance_below_storage_threshold'));
});

test('temporary context retention must match its structured expiry', async () => {
  const text = '我这几天在外地。';
  const { service } = serviceFor(text, proposal({
    proposedDecision: 'temporary_context',
    memoryType: 'temporary_context',
    predicate: 'temporary_presence',
    retentionPolicy: { mode: 'ttl', expiresAt: '2026-07-21T00:00:00.000Z' },
    reasonCodes: ['time_bounded_context'],
    suggestedStructuredValue: {
      summary: '用户正在外地',
      expiresAt: '2026-07-22T00:00:00.000Z'
    }
  }));
  const result = await decide(service, text);
  assert.equal(result.decision, 'confirm_before_store');
  assert.ok(result.reasonCodes.includes('retention_expiry_mismatch'));
});

test('explicit financial command is business_record but acknowledgement waits for a real commit', async () => {
  const text = '买菜100元。';
  const { service } = serviceFor(text, proposal({
    proposedDecision: 'business_record',
    memoryType: 'financial_record',
    predicate: 'financial_transaction',
    confidence: 0.99,
    importance: 0.7,
    retentionPolicy: { mode: 'business_record', expiresAt: null },
    reasonCodes: ['explicit_business_record'],
    suggestedStructuredValue: {
      direction: 'expense', amount: 100, currency: 'CNY', category: 'groceries'
    },
    explicitBusinessIntent: true
  }));
  const result = await decide(service, text);
  assert.equal(result.decision, 'business_record');
  assert.equal(result.acknowledgementPolicy, 'after_commit');
  assert.equal(result.responsePolicy, 'acknowledge_only_after_commit');
  assert.equal('acknowledgementText' in result, false);
});

test('financial report query is answer_only and freezes opt-in advice wording', async () => {
  const text = '七月份我的收支情况怎么样？';
  const { service } = serviceFor(text, proposal({
    proposedDecision: 'answer_only',
    memoryType: null,
    predicate: null,
    importance: 0,
    retentionPolicy: { mode: 'none', expiresAt: null },
    reasonCodes: ['financial_report_query'],
    suggestedStructuredValue: null,
    containsPersonalFact: false
  }));
  const result = await decide(service, text);
  assert.equal(result.decision, 'answer_only');
  assert.equal(result.responsePolicy, 'financial_report_opt_in_advice');
  assert.equal(
    Contracts.FINANCIAL_REPORT_ADVICE_PROMPT,
    '需要我根据这份收支情况给你一些建议吗？'
  );
});

test('a question containing an uncertain personal fact is not forced to answer_only', async () => {
  const text = '我是不是对青霉素过敏？';
  const { service } = serviceFor(text, proposal({
    proposedDecision: 'confirm_before_store',
    memoryType: 'health_record',
    predicate: 'health_observation',
    confidence: 0.4,
    importance: 0.95,
    sensitivity: 'high',
    reasonCodes: ['uncertain_personal_fact'],
    suggestedStructuredValue: { summary: '可能对青霉素过敏' },
    needsClarification: true
  }));
  assert.equal((await decide(service, text)).decision, 'confirm_before_store');
});

test('ambiguous Entity resolution can never authorize silent storage', async () => {
  const text = '我女儿下周考试。';
  const { service } = serviceFor(text, proposal({
    predicate: 'life_event',
    memoryType: 'life_event',
    suggestedStructuredValue: { summary: '下周考试' }
  }));
  const result = await decide(service, text, {
    entityResolution: {
      resolutionStatus: 'ambiguous',
      ownerUserId: ENTITY_TEST_IDS.owner,
      candidates: [
        { entityId: ENTITY_TEST_IDS.daughterOne, entityType: 'person' },
        { entityId: ENTITY_TEST_IDS.daughterTwo, entityType: 'person' }
      ],
      clarificationQuestion: '你说的是哪一位女儿？',
      evidence: []
    }
  });
  assert.equal(result.decision, 'confirm_before_store');
  assert.equal(result.subjectEntityId, null);
});

test('no_match Entity resolution cannot create or silently store a memory', async () => {
  const text = '陌生人明天考试。';
  const { service } = serviceFor(text, proposal());
  const result = await decide(service, text, {
    entityResolution: {
      resolutionStatus: 'no_match',
      ownerUserId: ENTITY_TEST_IDS.owner,
      reason: 'no_owner_scoped_candidate',
      safeNextAction: 'ask_for_identity_clarification'
    }
  });
  assert.equal(result.decision, 'confirm_before_store');
  assert.equal(result.subjectEntityId, null);
});

test('owner mismatch fails closed before a storage decision', async () => {
  const text = '跨用户记忆。';
  const { service } = serviceFor(text, proposal());
  const result = await decide(service, text, {
    entityResolution: exactResolution({ ownerUserId: 'other-owner' })
  });
  assert.equal(result.decision, 'confirm_before_store');
  assert.ok(result.reasonCodes.includes('owner_scope_mismatch'));
});

test('existing fact conflict forces confirmation instead of overwrite', async () => {
  const text = '我妈妈生日改成5月7号。';
  const inspector = fakeInspector({ conflictStatus: 'conflict' });
  const { service } = serviceFor(text, proposal({
    suggestedStructuredValue: { date: '1968-05-07' }
  }), { inspector });
  const result = await decide(service, text);
  assert.equal(result.decision, 'confirm_before_store');
  assert.ok(result.reasonCodes.includes('existing_fact_conflict'));
});

test('possible duplicate requires confirmation and exact duplicate is ignored', async () => {
  for (const [duplicateStatus, expectedDecision] of [
    ['possible', 'confirm_before_store'],
    ['exact', 'ignore']
  ]) {
    const text = `重复检查-${duplicateStatus}`;
    const { service } = serviceFor(text, proposal(), {
      inspector: fakeInspector({ duplicateStatus })
    });
    assert.equal((await decide(service, text)).decision, expectedDecision);
  }
});

test('unknown or invalid structuredValue fails closed before storage', async () => {
  const text = '生日结构错误。';
  const { service } = serviceFor(text, proposal({
    suggestedStructuredValue: { year: 1968, month: 5, day: 6 }
  }));
  const result = await decide(service, text);
  assert.equal(result.decision, 'confirm_before_store');
  assert.ok(result.reasonCodes.includes('structured_value_invalid'));
});

test('invalid AI retention policy and unknown fields are rejected', () => {
  assert.throws(
    () => Classifier.parseAIMemoryClassificationProposal(proposal({
      retentionPolicy: { mode: 'forever', expiresAt: null }
    })),
    /retentionPolicy/i
  );
  assert.throws(
    () => Classifier.parseAIMemoryClassificationProposal(proposal({ execute: true })),
    /unknown field/i
  );
});

test('classifier failure returns a fail-closed decision rather than a write permission', async () => {
  const text = '分类器失败。';
  const { service } = serviceFor(text, new Error('classifier unavailable'));
  const result = await decide(service, text);
  assert.equal(result.decision, 'confirm_before_store');
  assert.ok(result.reasonCodes.includes('classifier_unavailable'));
});

test('classification receives semantic context but no Repository, database, or write capability', async () => {
  const text = '只做判断。';
  const { service, classifier } = serviceFor(text, proposal());
  await decide(service, text, { conversationContext: { recentIntent: 'family' } });
  assert.deepEqual(Object.keys(classifier.calls[0]).sort(), [
    'conversationContext', 'entityResolution', 'locale', 'ownerUserId', 'text'
  ]);
  assert.equal('repository' in classifier.calls[0], false);
  assert.equal('database' in classifier.calls[0], false);
  assert.equal('write' in classifier.calls[0], false);
});

test('decision service exposes no memory write or acknowledgement-success method', () => {
  const { service } = serviceFor('只决策', proposal());
  assert.equal(typeof service.decide, 'function');
  for (const method of ['write', 'save', 'commit', 'acknowledgeRecorded']) {
    assert.equal(method in service, false);
  }
});

test('same semantic proposal produces the same decision without phrase rules', async () => {
  const firstText = '母亲的生日是五月六日。';
  const secondText = '5月6号，是我妈妈的生日。';
  const classifier = new FakeAIMemoryClassifier({
    [firstText]: proposal(),
    [secondText]: proposal()
  });
  const service = DecisionService.createMemoryCaptureDecisionService({
    classifier,
    inspector: fakeInspector(),
    now: () => NOW
  });
  const first = await decide(service, firstText);
  const second = await decide(service, secondText);
  assert.equal(first.decision, 'store_silently');
  assert.equal(second.decision, 'store_silently');
  assert.notEqual(first.sourceTextDigest, second.sourceTextDigest);
});

test('MemoryDecision output is frozen, contains no source text, and uses SHA-256 digest', async () => {
  const text = '我妈妈5月6号生日。';
  const { service } = serviceFor(text, proposal());
  const result = await decide(service, text);
  assert.ok(Object.isFrozen(result));
  assert.match(result.sourceTextDigest, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(text), false);
  assert.deepEqual(Object.keys(result), Contracts.MemoryDecision.fields);
});
