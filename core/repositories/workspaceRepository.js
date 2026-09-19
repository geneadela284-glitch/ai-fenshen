import { JsonCollectionRepository } from './jsonRepository.js';

const WORKSPACES_KEY = 'workspaces';
const ACTIVE_WORKSPACE_KEY = 'active-workspaces';
const LEGACY_SESSIONS_KEY = 'workspace-sessions';
const LEGACY_ACTIVE_SESSION_KEY = 'workspace-active-sessions';

export class WorkspaceRepository extends JsonCollectionRepository {
  constructor(options = {}) {
    super({ key: WORKSPACES_KEY, ...options });
  }

  getActiveMap() {
    return this.storage.get(ACTIVE_WORKSPACE_KEY) || {};
  }

  setActiveMap(activeMap = {}) {
    this.storage.set(ACTIVE_WORKSPACE_KEY, activeMap);
    return activeMap;
  }

  readLegacySessions() {
    return this.storage.get(LEGACY_SESSIONS_KEY) || [];
  }

  readLegacyActiveSessions() {
    return this.storage.get(LEGACY_ACTIVE_SESSION_KEY) || {};
  }

  deleteLegacySessions() {
    this.storage.remove(LEGACY_SESSIONS_KEY);
    this.storage.remove(LEGACY_ACTIVE_SESSION_KEY);
    return true;
  }
}

export const workspaceRepository = new WorkspaceRepository();
