import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ConflictDetector, DuplicateDetector, MigrationCandidateStatus, MigrationError,
  MigrationScanner, SensitiveDetector
} from './index.js';
import {
  MIGRATION_NOW, fakeExistingMemory, fakeLegacyItem, fakeMigrationContext,
  fakeMigrationSource, fakeTimelineEvent
} from './testing/fixtures.js';

function scanner(options = {}) {
  let id = 0;
  return new MigrationScanner({ clock: () => new Date(MIGRATION_NOW), idFactory: () => `fake-${++id}`, ...options });
}

async function candidate(item = fakeLegacyItem('one'), source = fakeMigrationSource([item])) {
  return (await scanner().scan(fakeMigrationContext(), source)).candidates[0];
}

for (const kind of ['chatgpt', 'wechat', 'email', 'calendar', 'notes', 'knowledge', 'files', 'photos', 'fake']) {
  test(`scanner accepts normalized fake data labelled as ${kind}`, async () => {
    const result = await scanner().scan(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem(kind)], { kind }));
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].sourceKind, kind);
  });
}

test('scanner creates only pending Memory candidates', async () => {
  const result = await scanner().scan(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one')]));
  assert.equal(result.candidates[0].proposedMemory.status, 'pending_confirmation');
  assert.equal(result.candidates[0].proposedMemory.confirmationStatus, 'pending');
  assert.equal(result.candidates[0].proposedMemory.source.type, 'imported');
});

test('scanner keeps source and time provenance', async () => {
  const result = await scanner().scan(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('one')]));
  const item = result.candidates[0];
  assert.equal(item.sourceRecordId, 'one');
  assert.equal(item.proposedMemory.sourceTimestamp, '2030-01-02T03:04:05.000Z');
});

for (const [name, override, code] of [
  ['missing id', { sourceRecordId: '' }, 'MIGRATION_ITEM_INVALID'],
  ['cross user', { userId: 'fake-user-b' }, 'USER_SCOPE_MISMATCH'],
  ['invalid type', { memoryType: 'personality' }, 'INVALID_ENUM'],
  ['missing subject', { subject: '' }, 'MIGRATION_ITEM_INVALID'],
  ['missing predicate', { predicate: '' }, 'MIGRATION_ITEM_INVALID'],
  ['invalid date', { occurredAt: 'yesterday' }, 'INVALID_DATE'],
  ['invalid confidence', { confidence: 2 }, 'INVALID_NUMBER'],
  ['invalid importance', { importance: -1 }, 'INVALID_NUMBER'],
  ['invalid tags', { tags: 'fake' }, 'INVALID_TYPE'],
  ['secret metadata', { metadata: { apiKey: 'not-a-real-key' } }, 'SECRET_FORBIDDEN'],
  ['unknown field', { rawConversation: 'not allowed' }, 'UNKNOWN_FIELD']
]) {
  test(`scanner excludes ${name} without failing the whole scan`, async () => {
    const result = await scanner().scan(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem(name, override)]));
    assert.equal(result.candidates.length, 0);
    assert.equal(result.excluded[0].reasonCode, code);
    assert.deepEqual(Object.keys(result.excluded[0]).sort(), ['reasonCode', 'sourceRecordId']);
  });
}

test('scanner rejects a source owned by another user', async () => {
  await assert.rejects(
    scanner().scan(fakeMigrationContext(), fakeMigrationSource([], { userId: 'fake-user-b' })),
    (error) => error instanceof MigrationError && error.code === 'USER_SCOPE_MISMATCH'
  );
});

test('scanner rejects non-array source output', async () => {
  await assert.rejects(
    scanner().scan(fakeMigrationContext(), fakeMigrationSource([], { scan: async () => ({}) })),
    (error) => error.code === 'MIGRATION_SOURCE_SCAN_FAILED'
  );
});

test('scanner enforces a bounded item count', async () => {
  await assert.rejects(
    scanner({ maxItems: 2 }).scan(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('1'), fakeLegacyItem('2'), fakeLegacyItem('3')])),
    (error) => error.code === 'MIGRATION_SCAN_LIMIT_EXCEEDED'
  );
});

test('scanner handles duplicate source record ids once', async () => {
  const result = await scanner().scan(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem('same'), fakeLegacyItem('same')]));
  assert.equal(result.candidates.length, 1);
  assert.equal(result.excluded[0].reasonCode, 'MIGRATION_SOURCE_DUPLICATE_ID');
});

for (const [name, value] of [
  ['unicode', '虚构中文☕️'], ['null', null], ['array', ['虚构', 1]], ['object', { fake: true }],
  ['boolean', true], ['number', 42]
]) {
  test(`scanner preserves normalized ${name} values`, async () => {
    const result = await scanner().scan(fakeMigrationContext(), fakeMigrationSource([fakeLegacyItem(name, { value, normalizedValue: value })]));
    assert.deepEqual(result.candidates[0].proposedMemory.value, value);
    assert.deepEqual(result.candidates[0].proposedMemory.normalizedValue, value);
  });
}

test('scanner returns immutable detached candidates', async () => {
  const raw = fakeLegacyItem('one', { value: { fake: true }, normalizedValue: { fake: true } });
  const result = await scanner().scan(fakeMigrationContext(), fakeMigrationSource([raw]));
  assert.equal(Object.isFrozen(result.candidates[0]), true);
  raw.value.fake = false;
  assert.equal(result.candidates[0].proposedMemory.value.fake, true);
});

const DUPLICATE_CASES = [
  ['exact Memory', (c) => ({ memories: [fakeExistingMemory('m1', { normalizedValue: c.proposedMemory.normalizedValue })] }), true],
  ['exact Timeline', (c) => ({ timelineEvents: [fakeTimelineEvent('t1', { metadata: { subject: c.proposedMemory.subject, predicate: c.proposedMemory.predicate, normalizedValue: c.proposedMemory.normalizedValue } })] }), true],
  ['same peer', (c) => ({ candidates: [{ ...c, id: 'migration-candidate-earlier' }] }), true],
  ['different type', (c) => ({ memories: [fakeExistingMemory('m1', { memoryType: 'goal', normalizedValue: c.proposedMemory.normalizedValue })] }), false],
  ['different subject', (c) => ({ memories: [fakeExistingMemory('m1', { subject: 'other', normalizedValue: c.proposedMemory.normalizedValue })] }), false],
  ['different predicate', (c) => ({ memories: [fakeExistingMemory('m1', { predicate: 'other', normalizedValue: c.proposedMemory.normalizedValue })] }), false],
  ['different value', () => ({ memories: [fakeExistingMemory('m1')] }), false],
  ['other user', (c) => ({ memories: [fakeExistingMemory('m1', { userId: 'fake-user-b', normalizedValue: c.proposedMemory.normalizedValue })] }), false]
];

for (const [name, inputs, expected] of DUPLICATE_CASES) {
  test(`duplicate detector handles ${name}`, async () => {
    const item = await candidate();
    const report = new DuplicateDetector().detect(item, inputs(item));
    assert.equal(report.isDuplicate, expected);
    assert.equal(Object.isFrozen(report), true);
  });
}

test('duplicate detector preserves separate life events at different times', async () => {
  const item = await candidate(fakeLegacyItem('event', { memoryType: 'life_event', predicate: 'visited', normalizedValue: '虚构地点' }));
  const existing = fakeExistingMemory('old', { memoryType: 'life_event', predicate: 'visited', normalizedValue: '虚构地点', effectiveFrom: '2020-01-01T00:00:00.000Z' });
  assert.equal(new DuplicateDetector().detect(item, { memories: [existing] }).isDuplicate, false);
});

for (const [name, existing, expected] of [
  ['current differing fact', fakeExistingMemory('current'), true],
  ['deleted differing fact', fakeExistingMemory('deleted', { status: 'deleted' }), false],
  ['superseded differing fact', fakeExistingMemory('superseded', { status: 'superseded', supersededById: 'new' }), false],
  ['other user differing fact', fakeExistingMemory('other', { userId: 'fake-user-b' }), false],
  ['different predicate', fakeExistingMemory('different', { predicate: 'other' }), false]
]) {
  test(`conflict detector handles ${name}`, async () => {
    const item = await candidate();
    const report = new ConflictDetector().detect(item, { memories: [existing] });
    assert.equal(report.hasConflict, expected);
    assert.equal(report.resolution, expected ? 'governance_required' : null);
  });
}

test('conflict detector does not treat an exact duplicate as conflict', async () => {
  const item = await candidate();
  const existing = fakeExistingMemory('same', { normalizedValue: item.proposedMemory.normalizedValue });
  assert.equal(new ConflictDetector().detect(item, { memories: [existing] }).hasConflict, false);
});

test('conflict detector preserves independent life events', async () => {
  const item = await candidate(fakeLegacyItem('event', { memoryType: 'life_event', predicate: 'visited' }));
  const existing = fakeExistingMemory('event-old', { memoryType: 'life_event', predicate: 'visited' });
  assert.equal(new ConflictDetector().detect(item, { memories: [existing] }).hasConflict, false);
});

test('conflict detector detects an existing Timeline conflict', async () => {
  const item = await candidate();
  const event = fakeTimelineEvent('conflict', { status: 'conflict', metadata: { subject: 'self', predicate: 'prefers_drink', normalizedValue: 'other' } });
  assert.equal(new ConflictDetector().detect(item, { timelineEvents: [event] }).hasConflict, true);
});

for (const [name, value, sensitivity, prohibited] of [
  ['normal', '虚构咖啡偏好', 'low', false],
  ['health', '虚构健康病历信息', 'high', false],
  ['finance', '虚构财务资产信息', 'high', false],
  ['family', '虚构女儿家庭关系', 'high', false],
  ['address', '虚构家庭地址幸福路1号1室', 'high', false],
  ['password', 'password: not-a-real-password', 'restricted', true],
  ['api key', 'api_key: not-a-real-key', 'restricted', true],
  ['cookie', 'cookie: not-a-real-cookie', 'restricted', true],
  ['access token', 'access_token: not-a-real-token', 'restricted', true],
  ['private key', 'private_key: not-a-real-key', 'restricted', true],
  ['recovery code', 'recovery_code: not-a-real-code', 'restricted', true]
]) {
  test(`sensitive detector classifies ${name}`, async () => {
    const item = await candidate(fakeLegacyItem(name, { value, normalizedValue: value }));
    const report = new SensitiveDetector().detect(item);
    assert.equal(report.sensitivity, sensitivity);
    assert.equal(report.prohibited, prohibited);
    assert.equal(report.requiresExplicitApproval, sensitivity === 'high');
  });
}

test('sensitive detector redacts prohibited candidate content', async () => {
  const item = await candidate(fakeLegacyItem('secret', { value: 'password: not-a-real-password', normalizedValue: 'password: not-a-real-password' }));
  const redacted = new SensitiveDetector().redactProhibited(item);
  assert.equal(redacted.status, MigrationCandidateStatus.PROHIBITED);
  assert.equal(redacted.proposedMemory.value, '[REDACTED_PROHIBITED]');
  assert.equal(JSON.stringify(redacted).includes('not-a-real-password'), false);
});
