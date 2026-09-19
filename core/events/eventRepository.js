import { JsonCollectionRepository } from '../repositories/jsonRepository.js';

const EVENTS_KEY = 'events';

export class EventRepository extends JsonCollectionRepository {
  constructor(options = {}) {
    super({ key: EVENTS_KEY, ...options });
  }
}

export const eventRepository = new EventRepository();
