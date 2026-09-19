import { JsonCollectionRepository } from '../repositories/jsonRepository.js';

const WORK_SECRETARY_TASKS_KEY = 'work-secretary-tasks';

export class WorkSecretaryRepository extends JsonCollectionRepository {
  constructor(options = {}) {
    super({ key: WORK_SECRETARY_TASKS_KEY, ...options });
  }
}

export const workSecretaryRepository = new WorkSecretaryRepository();
