import { createDefaultRepositoryStorage } from '../repositories/jsonStorage.js';
import { MemoryRepository } from './repository/memoryRepository.js';
import { MemoryService } from './service/memoryService.js';

export function createPersistentMemoryService(options = {}) {
  const repository = options.repository || new MemoryRepository({
    storage: options.storage || createDefaultRepositoryStorage(),
    namespace: options.namespace
  });
  return new MemoryService({ repository, ...options });
}

export const persistentMemoryService = createPersistentMemoryService();
