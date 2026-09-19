import { JsonCollectionRepository } from '../repositories/jsonRepository.js';

const QUICK_NOTES_KEY = 'quick-notes';

export class QuickNoteRepository extends JsonCollectionRepository {
  constructor(options = {}) {
    super({ key: QUICK_NOTES_KEY, ...options });
  }
}

export const quickNoteRepository = new QuickNoteRepository();
