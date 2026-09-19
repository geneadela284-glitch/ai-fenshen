import { JsonCollectionRepository } from '../repositories/jsonRepository.js';

const KNOWLEDGE_FILES_KEY = 'knowledge-files';

export class KnowledgeFileRepository extends JsonCollectionRepository {
  constructor(options = {}) {
    super({ key: KNOWLEDGE_FILES_KEY, ...options });
  }
}

export const knowledgeFileRepository = new KnowledgeFileRepository();
