import { sessionRepository } from '../repositories/sessionRepository.js';
import { WorkspaceManager } from './workspaceManager.js';

export class SessionManager extends WorkspaceManager {
  getActiveSessionId(toolId) {
    return this.getActiveWorkspaceId(toolId);
  }

  setActiveSessionId(toolId, sessionId) {
    return this.setActiveWorkspaceId(toolId, sessionId);
  }

  clearActiveSessionId(toolId) {
    return this.clearActiveWorkspaceId(toolId);
  }
}

export const sessionManager = new SessionManager({ repository: sessionRepository });
