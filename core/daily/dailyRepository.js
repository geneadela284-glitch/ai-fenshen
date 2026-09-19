import { eventRepository } from '../events/eventRepository.js';

export class DailyRepository {
  constructor({ events = eventRepository } = {}) {
    this.events = events;
  }

  listEvents() {
    return this.events.readAll();
  }

  searchEvents(predicate = () => true) {
    return this.listEvents().filter(predicate);
  }
}

export const dailyRepository = new DailyRepository();
