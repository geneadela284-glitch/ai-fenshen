import { JsonCollectionRepository } from '../repositories/jsonRepository.js';

const NOTIFICATION_DELIVERIES_KEY = 'notification-deliveries';

export class NotificationRepository extends JsonCollectionRepository {
  constructor(options = {}) {
    super({ key: NOTIFICATION_DELIVERIES_KEY, ...options });
  }
}

export const notificationRepository = new NotificationRepository();
