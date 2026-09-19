import { InMemoryAliasRepository } from './inMemoryAliasRepository.js';
import { InMemoryEntityRepository } from './inMemoryEntityRepository.js';
import { InMemoryMemoryRecordV2Repository } from './inMemoryMemoryRecordV2Repository.js';
import { InMemoryRelationRepository } from './inMemoryRelationRepository.js';
import { InMemoryMemoryUnitOfWork } from './inMemoryUnitOfWork.js';
import { createFoundationState } from './inMemoryFoundationState.js';

function buildRepositories(holder, options, scopeOwnerUserId = null) {
  const shared = { ...options, scopeOwnerUserId };
  const repository = new InMemoryEntityRepository(holder, shared);
  const aliases = new InMemoryAliasRepository(holder, shared);
  const relations = new InMemoryRelationRepository(holder, shared);
  const memories = new InMemoryMemoryRecordV2Repository(holder, shared);
  repository.bindRelated({ aliases, relations });
  return { repository, aliases, relations, memories };
}

export function createInMemoryEntityFoundation(options = {}) {
  const holder = { state: createFoundationState() };
  const repositories = buildRepositories(holder, options);
  const unitOfWork = new InMemoryMemoryUnitOfWork(
    holder,
    (draftHolder, ownerUserId) => buildRepositories(draftHolder, options, ownerUserId)
  );
  return Object.freeze({ ...repositories, unitOfWork });
}

export { InMemoryAliasRepository } from './inMemoryAliasRepository.js';
export { InMemoryEntityRepository } from './inMemoryEntityRepository.js';
export { InMemoryMemoryRecordV2Repository } from './inMemoryMemoryRecordV2Repository.js';
export { InMemoryRelationRepository } from './inMemoryRelationRepository.js';
export { InMemoryMemoryUnitOfWork } from './inMemoryUnitOfWork.js';
export { EntityFoundationError } from './inMemoryFoundationState.js';
