import { JsonCollectionRepository } from '../repositories/jsonRepository.js';
import { MEETING_STORAGE_KEY, meetingStatuses } from './meetingTypes.js';
import { normalizeMeeting } from './meetingSession.js';

export class MeetingRepository extends JsonCollectionRepository {
  constructor({ namespace = MEETING_STORAGE_KEY, ...options } = {}) {
    super({ key: namespace, ...options });
  }

  create(meeting) {
    return super.create(normalizeMeeting(meeting));
  }

  update(id, updates) {
    return super.update(id, normalizeMeeting({ ...(this.read(id) || {}), ...updates, id }));
  }

  list({ includeArchived = false } = {}) {
    return this.readAll()
      .map(normalizeMeeting)
      .filter((meeting) => includeArchived || meeting.status !== meetingStatuses.ARCHIVED)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  }
}

export const meetingRepository = new MeetingRepository();
