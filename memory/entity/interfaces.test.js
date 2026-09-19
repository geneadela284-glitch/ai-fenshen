import assert from 'node:assert/strict';
import test from 'node:test';

const Interfaces = await import('./interfaces.js').catch(() => ({}));

const repositoryMethods = [
  'getById', 'query', 'findByAlias', 'findRelations', 'createEntity',
  'updateEntity', 'addAlias', 'updateAlias', 'createRelation', 'endRelation'
];
const shadowPlanFields = [
  'planId', 'sourceDatabasePath', 'shadowDatabasePath', 'sourceChecksum',
  'targetSchemaVersion', 'migrationId', 'createdAt', 'status'
];

test('EntityRepository freezes the owner-scoped identity port', () => {
  assert.equal(Interfaces.EntityRepository.name, 'EntityRepository');
  assert.deepEqual(Interfaces.EntityRepository.requiredMethods, repositoryMethods);
  assert.ok(Object.isFrozen(Interfaces.EntityRepository.requiredMethods));
});

test('MemoryUnitOfWork freezes one atomic run boundary', () => {
  assert.deepEqual(Interfaces.MemoryUnitOfWork.requiredMethods, ['run']);
});

test('MemoryRecordV2ReadRepository freezes exact Entity and predicate query only', () => {
  assert.equal(Interfaces.MemoryRecordV2ReadRepository.name, 'MemoryRecordV2ReadRepository');
  assert.deepEqual(Interfaces.MemoryRecordV2ReadRepository.requiredMethods, [
    'queryByEntityAndPredicate'
  ]);
  assert.equal(Interfaces.validateMemoryRecordV2ReadRepositoryInterface({
    queryByEntityAndPredicate() {}
  }).valid, true);
});

test('LegacyReadAdapter exposes read-only query only', () => {
  assert.deepEqual(Interfaces.LegacyReadAdapter.requiredMethods, ['query']);
});

test('ShadowDatabasePlan freezes a descriptor without database behavior', () => {
  assert.deepEqual(Interfaces.ShadowDatabasePlan.requiredFields, shadowPlanFields);
  assert.equal('requiredMethods' in Interfaces.ShadowDatabasePlan, false);
});

test('interface validators accept complete fake ports', () => {
  const repository = Object.fromEntries(repositoryMethods.map((method) => [method, () => undefined]));
  assert.equal(Interfaces.validateEntityRepositoryInterface(repository).valid, true);
  assert.equal(Interfaces.validateMemoryUnitOfWorkInterface({ run() {} }).valid, true);
  assert.equal(Interfaces.validateLegacyReadAdapterInterface({ query() {} }).valid, true);
});

test('interface validators fail closed when a method is missing', () => {
  const repository = Object.fromEntries(repositoryMethods.map((method) => [method, () => undefined]));
  delete repository.findRelations;
  const validation = Interfaces.validateEntityRepositoryInterface(repository);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.path === 'findRelations' && error.code === 'INTERFACE_METHOD_MISSING'));
});

test('ShadowDatabasePlan interface validator rejects a missing source checksum', () => {
  const plan = Object.fromEntries(shadowPlanFields.map((field) => [field, `${field}-value`]));
  delete plan.sourceChecksum;
  const validation = Interfaces.validateShadowDatabasePlanInterface(plan);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.path === 'sourceChecksum' && error.code === 'REQUIRED'));
});
