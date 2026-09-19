import { JsonCollectionRepository } from './jsonRepository.js';

const MEMORY_KEY = 'ai-memory';

export class MemoryRepository extends JsonCollectionRepository {
  constructor(options = {}) {
    super({ key: MEMORY_KEY, ...options });
  }
}

export const memoryRepository = new MemoryRepository();
