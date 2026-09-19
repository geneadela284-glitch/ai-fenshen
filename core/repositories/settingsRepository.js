import { defaultAiSettings } from '../settings/defaultSettings.js';
import { JsonRecordRepository } from './jsonRepository.js';

const AI_SETTINGS_KEY = 'ai-settings';

export class SettingsRepository extends JsonRecordRepository {
  constructor(options = {}) {
    super({ key: AI_SETTINGS_KEY, defaults: defaultAiSettings, ...options });
  }
}

export const settingsRepository = new SettingsRepository();
