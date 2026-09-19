import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GroundingInputV2,
  assertGroundingInputV2,
  buildGroundingInputV2,
  groundRankedEvidenceV2
} from './groundingV2.js';
import {
  SafeAnswerContractV2,
  buildSafeAnswerV2,
  verifySafeAnswerProposalV2
} from './safeAnswerV2.js';
import { buildMemoryQueryV2, finalizeMemoryQueryV2Page } from '../entity/memoryQueryV2.js';
import { computeMemoryRecordV2Checksum } from '../entity/validation.js';
import { rankScopedMemoryCandidatesV2 } from './rankingV2.js';
import {
  ENTITY_TEST_IDS,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';

const NOW = '2026-07-17T06:00:00.000Z';
const OWNER = ENTITY_TEST_IDS.owner;
const OTHER_OWNER = 'user-grounding-v2-other-owner';
const MOTHER = 'ent_5061728394a5b6c7d8e9fa0b1c2d3e4f';
const PURPOSE = 'answer_exact_person_fact';

function record(overrides = {}) {
  return fakeMemoryRecordV2({
    memoryId: 'grounding-mother-birthday',
    ownerUserId: OWNER,
    subjectEntityId: MOTHER,
    structuredValue: { date: '1968-05-06' },
    displayValue: '5月6日',
    source: { type: 'user_confirmed', id: 'source-grounding-mother' },
    ...structuredClone(overrides)
  });
}

function setup({
  records = [record()],
  subjectEntityId = MOTHER,
  readMode = 'current',
  effectiveAt,
  repositoryGeneration = 'grounding-v2-generation-1'
} = {}) {
  const context = {
    ownerUserId: OWNER,
    now: NOW,
    repositoryGeneration,
    entityResolution: fakeEntityResolution({
      ownerUserId: OWNER,
      entityId: subjectEntityId,
      predicate: 'birthday',
      resolvedAt: NOW
    })
  };
  const query = buildMemoryQueryV2(context, {
    subjectEntityId,
    predicate: 'birthday',
    readMode,
    ...(effectiveAt === undefined ? {} : { effectiveAt }),
    limit: 20,
    provenancePolicy: 'trusted_v2'
  });
  const page = finalizeMemoryQueryV2Page(records, context, query);
  const rankingResult = rankScopedMemoryCandidatesV2({
    context,
    query,
    page,
    queryPurpose: PURPOSE,
    ranker: ({ candidates }) => candidates.map((candidate) => ({
      memoryId: candidate.memoryId,
      ownerUserId: candidate.ownerUserId,
      subjectEntityId: candidate.subjectEntityId,
      predicate: candidate.predicate,
      checksum: candidate.checksum,
      provenance: structuredClone(candidate.provenance),
      reasonCodes: ['TRUSTED_ORDER']
    }))
  });
  return { context, query, page, rankingResult };
}

function repositoryFor(fixture, { records, queryPage, getById } = {}) {
  const stored = records ?? fixture.page.items.map((candidate) => {
    const copy = structuredClone(candidate);
    const provenance = copy.provenance.level;
    delete copy.provenance;
    copy.provenance = provenance;
    return copy;
  });
  return {
    queryByEntityAndPredicate(context, query) {
      if (queryPage instanceof Error) throw queryPage;
      if (queryPage) return structuredClone(queryPage);
      return finalizeMemoryQueryV2Page(stored, context, query);
    },
    getById(ownerUserId, memoryId) {
      if (getById) return getById(ownerUserId, memoryId);
      const found = stored.find((candidate) => candidate.memoryId === memoryId && candidate.ownerUserId === ownerUserId);
      return found ? structuredClone(found) : null;
    }
  };
}

function ground(fixture, repository = repositoryFor(fixture)) {
  return groundRankedEvidenceV2({ ...fixture, repository });
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => error?.code === code);
}

function tamper(source, change, { checksum = true } = {}) {
  const copy = structuredClone(source);
  change(copy);
  if (checksum) copy.checksum = computeMemoryRecordV2Checksum(copy);
  return copy;
}

test('GroundingInputV2 freezes its exact contract and rejects unknown fields', () => {
  const fixture = setup();
  const input = buildGroundingInputV2(fixture);
  assert.deepEqual(GroundingInputV2.fields, [
    'schemaVersion', 'ownerUserId', 'subjectEntityId', 'predicate', 'queryPurpose',
    'effectiveAt', 'readMode', 'rankedMemoryIds', 'expectedChecksums',
    'expectedProvenance', 'expectedVersions', 'queryFingerprint'
  ]);
  assert.equal(input.ownerUserId, OWNER);
  assert.equal(input.subjectEntityId, MOTHER);
  assert.deepEqual(input.expectedVersions, [1]);
  assert.ok(Object.isFrozen(input));
  expectCode('EVIDENCE_INVALID', () => assertGroundingInputV2(
    { ...structuredClone(input), unexpected: true },
    { trustedOwnerUserId: OWNER }
  ));
});

test('one trusted mother birthday grounds and produces the exact safe fact', () => {
  const result = ground(setup());
  assert.equal(result.grounded, true);
  assert.equal(result.selectedMemoryId, 'grounding-mother-birthday');
  assert.deepEqual(result.structuredValue, { date: '1968-05-06' });
  assert.deepEqual(result.evidenceMemoryIds, ['grounding-mother-birthday']);
  assert.equal(result.answerPolicy.readMode, 'current');
  const answer = buildSafeAnswerV2({ type: 'fact', groundingResult: result });
  assert.equal(answer.type, 'fact');
  assert.equal(answer.safeUserMessage, '5月6号。');
  assert.deepEqual(answer.immutableFact, { date: '1968-05-06' });
});

for (const [label, entityId] of [
  ['two daughters', ENTITY_TEST_IDS.daughterOne],
  ['same-name friends', ENTITY_TEST_IDS.friendOne]
]) {
  test(`${label} cannot cross exact Entity scope during evidence reread`, () => {
    const fixture = setup();
    const wrong = tamper(record(), (candidate) => { candidate.subjectEntityId = entityId; });
    const result = ground(fixture, repositoryFor(fixture, {
      queryPage: fixture.page,
      getById: () => wrong
    }));
    assert.deepEqual(result, {
      grounded: false,
      errorCode: 'EVIDENCE_INVALID',
      safeUserMessage: '这项记录目前无法确认。',
      clarificationRequired: false,
      governanceRequired: true
    });
  });
}

for (const [label, mutateRecord] of [
  ['owner mismatch', (candidate) => { candidate.ownerUserId = OTHER_OWNER; }],
  ['entity mismatch', (candidate) => { candidate.subjectEntityId = ENTITY_TEST_IDS.daughterTwo; }],
  ['predicate mismatch', (candidate) => {
    candidate.predicate = 'anniversary';
    candidate.structuredValue = { date: '2010-01-01' };
  }],
  ['version mismatch', (candidate) => { candidate.version = 2; }],
  ['deleted status', (candidate) => { candidate.status = 'deleted'; }],
  ['archived status', (candidate) => { candidate.status = 'archived'; }],
  ['superseded current version', (candidate) => {
    candidate.status = 'superseded';
    candidate.supersededById = 'grounding-new-version';
  }]
]) {
  test(`${label} fails closed after Repository reread`, () => {
    const fixture = setup();
    const changed = tamper(record(), mutateRecord);
    assert.equal(ground(fixture, repositoryFor(fixture, {
      queryPage: fixture.page,
      getById: () => changed
    })).errorCode, 'EVIDENCE_INVALID');
  });
}

test('checksum corruption fails closed', () => {
  const fixture = setup();
  const changed = tamper(record(), (candidate) => { candidate.checksum = '0'.repeat(64); }, { checksum: false });
  assert.equal(ground(fixture, repositoryFor(fixture, {
    queryPage: fixture.page,
    getById: () => changed
  })).errorCode, 'EVIDENCE_INVALID');
});

test('missing provenance fails closed before facts are exposed', () => {
  const fixture = setup();
  const input = structuredClone(buildGroundingInputV2(fixture));
  input.expectedProvenance[0] = null;
  expectCode('EVIDENCE_INVALID', () => assertGroundingInputV2(input, { trustedOwnerUserId: OWNER }));
});

test('missing source fails closed', () => {
  const fixture = setup();
  const changed = structuredClone(record());
  delete changed.source;
  assert.equal(ground(fixture, repositoryFor(fixture, {
    queryPage: fixture.page,
    getById: () => changed
  })).errorCode, 'EVIDENCE_INVALID');
});

test('current grounding rereads and selects only the latest confirmed correction', () => {
  const old = record({
    memoryId: 'grounding-version-old',
    structuredValue: { date: '1968-05-05' },
    status: 'superseded',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
    createdAt: '2020-01-01T00:00:00.000Z',
    supersededById: 'grounding-version-current'
  });
  const current = record({
    memoryId: 'grounding-version-current',
    version: 2,
    supersedesId: 'grounding-version-old',
    effectiveFrom: '2025-01-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z'
  });
  const fixture = setup({ records: [old, current] });
  assert.equal(ground(fixture, repositoryFor(fixture, { records: [old, current] })).selectedMemoryId,
    'grounding-version-current');
});

test('historical grounding can use the version effective at the explicit instant and marks that time', () => {
  const old = record({
    memoryId: 'grounding-history-old',
    structuredValue: { date: '1968-05-05' },
    status: 'superseded',
    effectiveFrom: '2020-01-01T00:00:00.000Z',
    createdAt: '2020-01-01T00:00:00.000Z',
    supersededById: 'grounding-history-new'
  });
  const newer = record({
    memoryId: 'grounding-history-new',
    version: 2,
    supersedesId: 'grounding-history-old',
    effectiveFrom: '2025-01-01T00:00:00.000Z',
    createdAt: '2025-01-01T00:00:00.000Z'
  });
  const fixture = setup({
    records: [old, newer],
    readMode: 'historical',
    effectiveAt: '2024-06-01T00:00:00.000Z'
  });
  const result = ground(fixture, repositoryFor(fixture, { records: [old, newer] }));
  assert.equal(result.selectedMemoryId, 'grounding-history-old');
  assert.equal(result.answerPolicy.readMode, 'historical');
  assert.equal(result.answerPolicy.historicalAt, '2024-06-01T00:00:00.000Z');
  assert.equal(result.effectiveTime.queriedAt, '2024-06-01T00:00:00.000Z');
});

test('a version chain fork returns MEMORY_CONFLICT without auto-selection', () => {
  const fixture = setup();
  const conflict = Object.assign(new Error('fork'), { code: 'MEMORY_CONFLICT' });
  const result = ground(fixture, repositoryFor(fixture, { queryPage: conflict }));
  assert.equal(result.grounded, false);
  assert.equal(result.errorCode, 'MEMORY_CONFLICT');
  assert.equal(result.clarificationRequired, true);
  assert.equal(result.governanceRequired, true);
  assert.equal(Object.hasOwn(result, 'structuredValue'), false);
});

for (const [label, mutateRanking] of [
  ['added rankedMemoryId', (result) => { result.rankedMemoryIds.push('grounding-injected'); }],
  ['removed rankedMemoryId', (result) => { result.rankedMemoryIds.pop(); }],
  ['duplicate rankedMemoryId', (result) => { result.rankedMemoryIds.push(result.rankedMemoryIds[0]); }]
]) {
  test(`${label} is rejected before Repository access`, () => {
    const fixture = setup({ records: [record(), record({ memoryId: 'grounding-second' })] });
    const rankingResult = structuredClone(fixture.rankingResult);
    mutateRanking(rankingResult);
    expectCode('EVIDENCE_INVALID', () => buildGroundingInputV2({ ...fixture, rankingResult }));
  });
}

test('queryFingerprint mismatch is rejected', () => {
  const fixture = setup();
  const rankingResult = structuredClone(fixture.rankingResult);
  rankingResult.rankingInput.queryFingerprint = '0'.repeat(64);
  expectCode('EVIDENCE_INVALID', () => buildGroundingInputV2({ ...fixture, rankingResult }));
});

test('Ranking output mixed with another Entity is rejected', () => {
  const fixture = setup();
  const page = structuredClone(fixture.page);
  page.items[0].subjectEntityId = ENTITY_TEST_IDS.daughterOne;
  page.items[0].checksum = computeMemoryRecordV2Checksum(page.items[0]);
  expectCode('EVIDENCE_INVALID', () => buildGroundingInputV2({ ...fixture, page }));
});

test('not_found produces a safe answer without a fact payload', () => {
  const fixture = setup();
  const answer = buildSafeAnswerV2({ type: 'not_found', query: fixture.query });
  assert.equal(answer.safeUserMessage, '我目前没有找到这项记录。');
  assert.equal(answer.immutableFact, null);
  assert.equal(answer.grounded, false);
});

test('ambiguous Entity produces exactly one necessary clarification question', () => {
  const answer = buildSafeAnswerV2({
    type: 'clarification',
    scope: { ownerUserId: OWNER, subjectEntityId: null, predicate: 'birthday' },
    clarificationQuestion: '你说的是大女儿还是小女儿？'
  });
  assert.equal(answer.safeUserMessage, '你说的是大女儿还是小女儿？');
  assert.equal((answer.safeUserMessage.match(/？/g) ?? []).length, 1);
  assert.equal(answer.clarificationRequired, true);
});

test('invalid evidence never creates a fact Safe Answer', () => {
  const result = ground(setup(), repositoryFor(setup(), { getById: () => null }));
  expectCode('EVIDENCE_INVALID', () => buildSafeAnswerV2({ type: 'fact', groundingResult: result }));
  const answer = buildSafeAnswerV2({ type: 'evidence_invalid', groundingResult: result, query: setup().query });
  assert.equal(answer.safeUserMessage, '这项记录目前无法确认。');
  assert.equal(answer.immutableFact, null);
});

test('Fake AI cannot change a grounded date or number', () => {
  const contract = buildSafeAnswerV2({ type: 'fact', groundingResult: ground(setup()) });
  const proposal = structuredClone(contract);
  proposal.safeUserMessage = '5月7号。';
  proposal.immutableFact.date = '1968-05-07';
  expectCode('EVIDENCE_INVALID', () => verifySafeAnswerProposalV2(contract, proposal));
});

test('Fake AI cannot turn not_found into a guessed fact', () => {
  const fixture = setup();
  const contract = buildSafeAnswerV2({ type: 'not_found', query: fixture.query });
  const proposal = structuredClone(contract);
  proposal.type = 'fact';
  proposal.safeUserMessage = '可能是5月6号。';
  proposal.immutableFact = { date: '1968-05-06' };
  expectCode('EVIDENCE_INVALID', () => verifySafeAnswerProposalV2(contract, proposal));
});

test('unsafe Legacy evidence is rejected unless it is deterministically mapped', () => {
  for (const mappingState of ['suggested_review', 'review_required', 'unmappable', 'relation_bucket']) {
    const fixture = setup();
    const legacy = tamper(record(), (candidate) => {
      candidate.legacySubject = mappingState === 'relation_bucket' ? 'relation:mother' : 'mother';
      candidate.metadata = { legacyMappingState: mappingState };
    });
    assert.equal(ground(fixture, repositoryFor(fixture, {
      queryPage: fixture.page,
      getById: () => legacy
    })).errorCode, 'EVIDENCE_INVALID');
  }
});

test('Grounding rereads one exact Repository page and every ranked memory without model access', () => {
  const fixture = setup({ records: [record(), record({ memoryId: 'grounding-second' })] });
  const base = repositoryFor(fixture);
  const calls = [];
  const repository = {
    queryByEntityAndPredicate(context, query) {
      calls.push(['query', context.ownerUserId, query.subjectEntityId, query.predicate]);
      return base.queryByEntityAndPredicate(context, query);
    },
    getById(ownerUserId, memoryId) {
      calls.push(['getById', ownerUserId, memoryId]);
      return base.getById(ownerUserId, memoryId);
    }
  };
  const result = ground(fixture, repository);
  assert.equal(result.grounded, true);
  assert.deepEqual(calls[0], ['query', OWNER, MOTHER, 'birthday']);
  assert.equal(calls.filter(([method]) => method === 'getById').length, 2);
  assert.equal(Object.hasOwn(result, 'model'), false);
});

test('SafeAnswerContractV2 is sealed to the five allowed outcomes', () => {
  assert.deepEqual(SafeAnswerContractV2.types, [
    'fact', 'not_found', 'clarification', 'conflict', 'evidence_invalid'
  ]);
});
