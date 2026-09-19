import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RankingInputV2,
  assertRankingInputV2,
  buildRankingInputV2,
  rankScopedMemoryCandidatesV2
} from './rankingV2.js';
import {
  buildMemoryQueryV2,
  finalizeMemoryQueryV2Page
} from '../entity/memoryQueryV2.js';
import { computeMemoryRecordV2Checksum } from '../entity/validation.js';
import {
  ENTITY_TEST_IDS,
  fakeEntityResolution,
  fakeMemoryRecordV2
} from '../../testing/entityFixtures.js';

const NOW = '2026-07-17T06:00:00.000Z';
const OWNER = ENTITY_TEST_IDS.owner;
const OTHER_OWNER = 'user-ranking-v2-other-owner';
const MOTHER = 'ent_5061728394a5b6c7d8e9fa0b1c2d3e4f';
const OTHER_ENTITY = ENTITY_TEST_IDS.daughterOne;

function setup({
  subjectEntityId = MOTHER,
  records,
  resolutionStatus = 'exact',
  repositoryGeneration = 'ranking-v2-generation-1'
} = {}) {
  const context = {
    ownerUserId: OWNER,
    now: NOW,
    repositoryGeneration,
    entityResolution: fakeEntityResolution({
      ownerUserId: OWNER,
      resolutionStatus,
      entityId: resolutionStatus === 'exact' ? subjectEntityId : null,
      candidateEntityIds: resolutionStatus === 'ambiguous' ? [subjectEntityId, OTHER_ENTITY] : [],
      predicate: 'birthday',
      resolvedAt: NOW
    })
  };
  const query = buildMemoryQueryV2(context, {
    subjectEntityId,
    predicate: 'birthday',
    readMode: 'current',
    limit: 20,
    provenancePolicy: 'trusted_v2'
  });
  const source = records ?? [
    fakeMemoryRecordV2({
      memoryId: 'ranking-mother-birthday-a',
      ownerUserId: OWNER,
      subjectEntityId,
      source: { type: 'user_confirmed', id: 'source-ranking-a' }
    }),
    fakeMemoryRecordV2({
      memoryId: 'ranking-mother-birthday-b',
      ownerUserId: OWNER,
      subjectEntityId,
      structuredValue: { date: '1968-02-03' },
      source: { type: 'system_verified', id: 'source-ranking-b' },
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
  ];
  return {
    context,
    query,
    page: finalizeMemoryQueryV2Page(source, context, query)
  };
}

function outputFor(candidates, order = candidates.map((candidate) => candidate.memoryId)) {
  const byId = new Map(candidates.map((candidate) => [candidate.memoryId, candidate]));
  return order.map((memoryId) => {
    const candidate = byId.get(memoryId);
    return {
      memoryId,
      ownerUserId: candidate?.ownerUserId ?? OWNER,
      subjectEntityId: candidate?.subjectEntityId ?? MOTHER,
      predicate: candidate?.predicate ?? 'birthday',
      checksum: candidate?.checksum ?? 'a'.repeat(64),
      provenance: structuredClone(candidate?.provenance ?? {
        policy: 'trusted_v2', level: 'user_confirmed', source: { type: 'user_confirmed', id: 'fake' }
      }),
      reasonCodes: ['EXISTING_SCORE_ORDER']
    };
  });
}

function legalRanker({ candidates }) {
  return outputFor(candidates, candidates.map((candidate) => candidate.memoryId).reverse());
}

function mutateCandidate(page, index, mutate, { recomputeChecksum = true } = {}) {
  const copy = structuredClone(page);
  const provenance = structuredClone(copy.items[index].provenance);
  delete copy.items[index].provenance;
  copy.items[index].provenance = provenance.level;
  mutate(copy.items[index], provenance);
  if (recomputeChecksum) copy.items[index].checksum = computeMemoryRecordV2Checksum(copy.items[index]);
  copy.items[index].provenance = provenance;
  return copy;
}

function run(setupValue, ranker = legalRanker, extras = {}) {
  return rankScopedMemoryCandidatesV2({
    ...setupValue,
    queryPurpose: 'answer_exact_person_fact',
    ranker,
    ...extras
  });
}

function expectCode(code, callback) {
  assert.throws(callback, (error) => error?.code === code);
}

test('RankingInputV2 freezes the exact required contract and rejects unknown fields', () => {
  const fixture = setup();
  const input = buildRankingInputV2({ ...fixture, queryPurpose: 'answer_exact_person_fact' });
  assert.deepEqual(RankingInputV2.fields, [
    'schemaVersion', 'ownerUserId', 'subjectEntityId', 'predicate', 'queryPurpose',
    'effectiveAt', 'candidateMemoryIds', 'candidateChecksums', 'candidateProvenance',
    'candidateStatuses', 'queryFingerprint'
  ]);
  assert.equal(input.ownerUserId, fixture.query.ownerUserId);
  assert.equal(input.subjectEntityId, fixture.query.subjectEntityId);
  assert.equal(input.predicate, fixture.query.predicate);
  assert.equal(input.effectiveAt, fixture.query.effectiveAt);
  assert.equal(input.candidateMemoryIds.length, 2);
  assert.match(input.queryFingerprint, /^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(input));
  expectCode('RANKING_SCOPE_VIOLATION', () => assertRankingInputV2(
    { ...structuredClone(input), unexpected: true },
    { trustedOwnerUserId: OWNER }
  ));
  const incompleteProvenance = structuredClone(input);
  incompleteProvenance.candidateProvenance[0] = {};
  expectCode('EVIDENCE_INVALID', () => assertRankingInputV2(
    incompleteProvenance,
    { trustedOwnerUserId: OWNER }
  ));
});

test('two legal birthday candidates for the same mother may be reordered without content output', () => {
  const result = run(setup());
  assert.deepEqual(result.rankedMemoryIds, [
    'ranking-mother-birthday-b',
    'ranking-mother-birthday-a'
  ]);
  assert.deepEqual(result.reasonCodesByMemoryId['ranking-mother-birthday-a'], ['EXISTING_SCORE_ORDER']);
  assert.equal(Object.hasOwn(result, 'answer'), false);
  assert.ok(Object.isFrozen(result));
});

for (const [label, mutate] of [
  ['owner', (record) => { record.ownerUserId = OTHER_OWNER; }],
  ['Entity', (record) => { record.subjectEntityId = OTHER_ENTITY; }],
  ['predicate', (record) => { record.predicate = 'anniversary'; record.structuredValue = { date: '2018-05-20' }; }],
  ['deleted status', (record) => { record.status = 'deleted'; }],
  ['archived status', (record) => { record.status = 'archived'; }],
  ['superseded version', (record) => { record.supersededById = 'ranking-replacement'; }],
  ['ineffective time', (record) => { record.effectiveFrom = '2026-07-17T06:00:00.001Z'; }],
  ['unresolved conflict', (record) => { record.conflictGroupId = 'ranking-conflict-group'; }]
]) {
  test(`pre-ranking hard filter rejects mixed ${label} without calling Ranking`, () => {
    const fixture = setup();
    fixture.page = mutateCandidate(fixture.page, 0, mutate);
    let calls = 0;
    expectCode('RANKING_SCOPE_VIOLATION', () => run(fixture, () => { calls += 1; return []; }));
    assert.equal(calls, 0);
  });
}

test('checksum corruption fails as invalid evidence before Ranking', () => {
  const fixture = setup();
  fixture.page = mutateCandidate(fixture.page, 0, (record) => { record.checksum = '0'.repeat(64); }, { recomputeChecksum: false });
  let calls = 0;
  expectCode('EVIDENCE_INVALID', () => run(fixture, () => { calls += 1; return []; }));
  assert.equal(calls, 0);
});

test('missing provenance fails as invalid evidence before Ranking', () => {
  const fixture = setup();
  const page = structuredClone(fixture.page);
  delete page.items[0].provenance;
  fixture.page = page;
  expectCode('EVIDENCE_INVALID', () => run(fixture));
});

test('ambiguous and no-match Entity resolutions cannot enter Ranking', () => {
  for (const resolutionStatus of ['ambiguous', 'no_match']) {
    const fixture = setup();
    fixture.context = {
      ...fixture.context,
      entityResolution: fakeEntityResolution({
        ownerUserId: OWNER,
        resolutionStatus,
        entityId: null,
        candidateEntityIds: resolutionStatus === 'ambiguous' ? [MOTHER, OTHER_ENTITY] : [],
        predicate: 'birthday',
        resolvedAt: NOW
      })
    };
    let calls = 0;
    expectCode('RANKING_SCOPE_VIOLATION', () => run(fixture, () => { calls += 1; return []; }));
    assert.equal(calls, 0);
  }
});

test('empty candidates do not call Ranking', () => {
  const fixture = setup();
  fixture.page = { ...fixture.page, items: [] };
  let calls = 0;
  expectCode('RANKING_INPUT_EMPTY', () => run(fixture, () => { calls += 1; return []; }));
  assert.equal(calls, 0);
});

test('duplicate memoryId candidates are rejected before Ranking', () => {
  const fixture = setup();
  fixture.page = { ...fixture.page, items: [fixture.page.items[0], fixture.page.items[0]] };
  expectCode('RANKING_CANDIDATE_DUPLICATE', () => run(fixture));
});

test('unsafe Legacy mapping states and relation buckets are rejected', () => {
  for (const unsafe of ['suggested_review', 'review_required', 'unmappable', 'relation_bucket']) {
    const fixture = setup();
    fixture.page = mutateCandidate(fixture.page, 0, (record, provenance) => {
      record.legacySubject = unsafe === 'relation_bucket' ? 'family:mother' : 'legacy-mother';
      provenance.sourceMode = 'legacy';
      provenance.mappingState = unsafe;
    });
    expectCode('LEGACY_MAPPING_UNSAFE', () => run(fixture));
  }
});

test('Ranking receives frozen candidates only and no Repository capability is used', () => {
  const fixture = setup();
  let repositoryCalls = 0;
  const result = run(fixture, ({ input, candidates }) => {
    assert.ok(Object.isFrozen(input));
    assert.ok(Object.isFrozen(candidates));
    assert.ok(candidates.every(Object.isFrozen));
    assert.equal(Object.hasOwn(input, 'repository'), false);
    return outputFor(candidates);
  }, {
    repository: { query() { repositoryCalls += 1; } }
  });
  assert.equal(repositoryCalls, 0);
  assert.equal(result.rankedMemoryIds.length, 2);
});

for (const [label, output] of [
  ['new candidate', (candidates) => outputFor(candidates, [...candidates.map((item) => item.memoryId), 'ranking-injected'])],
  ['missing candidate', (candidates) => outputFor(candidates, [candidates[0].memoryId])],
  ['duplicate candidate', (candidates) => outputFor(candidates, [candidates[0].memoryId, candidates[0].memoryId])],
  ['changed checksum', (candidates) => outputFor(candidates).map((item, index) => index ? item : { ...item, checksum: 'f'.repeat(64) })],
  ['changed provenance', (candidates) => outputFor(candidates).map((item, index) => index ? item : { ...item, provenance: { ...item.provenance, policy: 'changed' } })],
  ['missing reason codes', (candidates) => outputFor(candidates).map((item, index) => index ? item : { ...item, reasonCodes: [] })],
  ['changed owner', (candidates) => outputFor(candidates).map((item, index) => index ? item : { ...item, ownerUserId: OTHER_OWNER })],
  ['changed Entity', (candidates) => outputFor(candidates).map((item, index) => index ? item : { ...item, subjectEntityId: OTHER_ENTITY })],
  ['changed predicate', (candidates) => outputFor(candidates).map((item, index) => index ? item : { ...item, predicate: 'anniversary' })]
]) {
  test(`post-ranking scope review rejects ${label}`, () => {
    const fixture = setup();
    expectCode('RANKING_OUTPUT_MISMATCH', () => run(fixture, ({ candidates }) => output(candidates)));
  });
}
