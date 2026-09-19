import { JsonRecordRepository } from './jsonRepository.js';

const PROVIDER_HEALTH_KEY = 'provider-health';

export class ProviderHealthRepository extends JsonRecordRepository {
  constructor(options = {}) {
    super({
      key: PROVIDER_HEALTH_KEY,
      defaults: { schemaVersion: 1, providers: {} },
      ...options
    });
  }
}

export const providerHealthRepository = new ProviderHealthRepository();
