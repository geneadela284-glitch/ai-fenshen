import { JsonCollectionRepository } from './jsonRepository.js';

const KNOWLEDGE_KEY = 'knowledge';

export class KnowledgeRepository extends JsonCollectionRepository {
  constructor(options = {}) {
    super({ key: KNOWLEDGE_KEY, ...options });
  }
}

export const knowledgeRepository = new KnowledgeRepository();
