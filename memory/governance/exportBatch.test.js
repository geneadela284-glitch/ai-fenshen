import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MemoryGovernanceService } from './index.js';
import { createGovernanceRepository, fakeGovernanceContext, fakeGovernanceRecord, seed } from './testing/fixtures.js';

async function setup(records = []) {
  const exportDirectory = await mkdtemp(join(tmpdir(), 'memory-governance-export-'));
  const repository = createGovernanceRepository();
  await seed(repository, records);
  let sequence = 0;
  return {
    repository,
    exportDirectory,
    service: new MemoryGovernanceService({
      repository,
      exportDirectory,
      clock: () => new Date('2026-07-15T12:00:00.000Z'),
      idFactory: () => `export-${++sequence}`
    })
  };
}

function context(operation, expectedVersion = null, overrides = {}) {
  return fakeGovernanceContext({ operation, expectedVersion, ...overrides });
}

async function cleanup(directory) { await rm(directory, { recursive: true, force: true }); }

test('JSON export writes a controlled temporary file', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('json')]);
  try {
    const result = await service.exportMemories(context('export'), { format: 'json' });
    assert.equal(result.status, 'completed');
    assert.equal(result.data.fileName.endsWith('.json'), true);
    const document = JSON.parse(await readFile(join(exportDirectory, result.data.fileName), 'utf8'));
    assert.equal(document.memories[0].id, 'json');
  } finally { await cleanup(exportDirectory); }
});

test('Markdown export writes a readable controlled file', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('markdown')]);
  try {
    const result = await service.exportMemories(context('export'), { format: 'markdown' });
    const output = await readFile(join(exportDirectory, result.data.fileName), 'utf8');
    assert.match(output, /^# Memory Export/m);
    assert.match(output, /markdown/);
  } finally { await cleanup(exportDirectory); }
});

test('export rejects unsupported format', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('bad-format')]);
  try { assert.equal((await service.exportMemories(context('export'), { format: 'xml' })).status, 'rejected'); }
  finally { await cleanup(exportDirectory); }
});

test('default export excludes high-sensitive body', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('high', { sensitivity: 'high', value: '虚构高敏感正文' })]);
  try {
    const result = await service.exportMemories(context('export'), { format: 'json' });
    assert.equal(result.data.itemCount, 0);
    assert.equal(result.data.content.includes('虚构高敏感正文'), false);
  } finally { await cleanup(exportDirectory); }
});

test('high-sensitive export requires explicit confirmation', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('high', { sensitivity: 'high', value: '虚构高敏感正文' })]);
  try {
    const result = await service.exportMemories(context('export'), { format: 'json', includeHighSensitivity: true });
    assert.equal(result.status, 'confirmation_required');
  } finally { await cleanup(exportDirectory); }
});

test('confirmed high-sensitive export includes the owner record and warning', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('high', { sensitivity: 'high', value: '虚构高敏感正文' })]);
  try {
    const options = { format: 'json', includeHighSensitivity: true };
    const first = await service.exportMemories(context('export'), options);
    const result = await service.exportMemories(context('export', null, { confirmationToken: first.data.confirmationToken }), options);
    assert.equal(result.data.itemCount, 1);
    assert.equal(result.warnings.includes('export_not_encrypted'), true);
  } finally { await cleanup(exportDirectory); }
});

test('export never contains another user records', async () => {
  const { service, repository, exportDirectory } = await setup([fakeGovernanceRecord('own')]);
  await seed(repository, [fakeGovernanceRecord('other', { userId: 'fake-user-b', value: '虚构他人正文' })], 'fake-user-b');
  try {
    const result = await service.exportMemories(context('export'), { format: 'json' });
    assert.equal(result.data.content.includes('other'), false);
    assert.equal(result.data.content.includes('虚构他人正文'), false);
  } finally { await cleanup(exportDirectory); }
});

test('export includes source time sensitivity access and version relations', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('fields')]);
  try {
    const result = await service.exportMemories(context('export'), { format: 'json' });
    const item = JSON.parse(result.data.content).memories[0];
    for (const field of ['source', 'sourceTimestamp', 'sensitivity', 'accessPolicy', 'version', 'supersedesId', 'supersededById']) assert.equal(field in item, true);
  } finally { await cleanup(exportDirectory); }
});

test('export omits SQL paths checksums and internal metadata', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('safe', { metadata: { path: '/private/fake.sqlite' } })]);
  try {
    const result = await service.exportMemories(context('export'), { format: 'json' });
    for (const forbidden of ['checksum', '/private/', 'fake.sqlite', 'SELECT *']) assert.equal(result.data.content.includes(forbidden), false);
  } finally { await cleanup(exportDirectory); }
});

test('export can include historical and recycle-bin records when requested', async () => {
  const { service, repository, exportDirectory } = await setup([
    fakeGovernanceRecord('historical', { status: 'archived' }),
    fakeGovernanceRecord('deleted')
  ]);
  await repository.moveToRecycleBin(service.toRepositoryContext(fakeGovernanceContext()), 'deleted', {
    expectedVersion: 1, idempotencyKey: null, requestId: 'delete', operationReason: 'test'
  });
  try {
    const result = await service.exportMemories(context('export'), { format: 'json', includeHistorical: true, includeDeleted: true });
    assert.deepEqual(JSON.parse(result.data.content).memories.map((item) => item.id).sort(), ['deleted', 'historical']);
  } finally { await cleanup(exportDirectory); }
});

test('export audit never stores exported bodies or file paths', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('audit', { value: '虚构导出正文' })]);
  try {
    await service.exportMemories(context('export'), { format: 'json' });
    const audit = await service.listAuditEvents(context('audit'));
    const output = JSON.stringify(audit);
    assert.equal(output.includes('虚构导出正文'), false);
    assert.equal(output.includes(exportDirectory), false);
  } finally { await cleanup(exportDirectory); }
});

test('batch ordinary delete requires one confirmation and is atomic', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('a'), fakeGovernanceRecord('b')]);
  try {
    const request = { operation: 'delete', memoryIds: ['a', 'b'], expectedVersions: { a: 1, b: 1 } };
    const first = await service.batchGovern(context('batch', 1), request);
    assert.equal(first.status, 'confirmation_required');
    const result = await service.batchGovern(context('batch', 1, { confirmationToken: first.data.confirmationToken }), request);
    assert.equal(result.status, 'completed');
    assert.equal(result.data.records.every((record) => record.status === 'deleted'), true);
  } finally { await cleanup(exportDirectory); }
});

test('batch archive completes without permanent deletion', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('a'), fakeGovernanceRecord('b')]);
  try {
    const result = await service.batchGovern(context('batch', 1), { operation: 'archive', memoryIds: ['a', 'b'], expectedVersions: { a: 1, b: 1 } });
    assert.equal(result.data.records.every((record) => record.status === 'archived'), true);
  } finally { await cleanup(exportDirectory); }
});

test('batch rollback leaves all records unchanged when one version is stale', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('a'), fakeGovernanceRecord('b')]);
  try {
    const result = await service.batchGovern(context('batch', 1), { operation: 'archive', memoryIds: ['a', 'b'], expectedVersions: { a: 1, b: 2 } });
    assert.equal(result.status, 'failed');
    assert.equal((await service.listMemories(fakeGovernanceContext())).data.items.length, 2);
  } finally { await cleanup(exportDirectory); }
});

test('batch permanent purge is rejected', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('a')]);
  try {
    const result = await service.batchGovern(context('batch', 1), { operation: 'purge', memoryIds: ['a'], expectedVersions: { a: 1 } });
    assert.equal(result.status, 'rejected');
  } finally { await cleanup(exportDirectory); }
});

test('batch operation rejects cross-user records without revealing them', async () => {
  const { service, exportDirectory } = await setup([fakeGovernanceRecord('a')]);
  try {
    const result = await service.batchGovern(context('batch', 1, { authenticatedUserId: 'fake-user-b', actorId: 'fake-user-b' }), { operation: 'archive', memoryIds: ['a'], expectedVersions: { a: 1 } });
    assert.equal(result.status, 'failed');
    assert.equal(result.safeMessage.includes('fake-user-a'), false);
  } finally { await cleanup(exportDirectory); }
});
