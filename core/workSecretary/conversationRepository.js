import { JsonCollectionRepository } from '../repositories/jsonRepository.js';

const WORK_SECRETARY_CONVERSATIONS_KEY = 'work-secretary-conversations';

export class WorkSecretaryConversationRepository extends JsonCollectionRepository {
  constructor(options = {}) {
    super({ key: WORK_SECRETARY_CONVERSATIONS_KEY, ...options });
  }
}

export const workSecretaryConversationRepository = new WorkSecretaryConversationRepository();
