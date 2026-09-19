import { WorkspaceRepository } from './workspaceRepository.js';

export class SessionRepository extends WorkspaceRepository {}

export const sessionRepository = new SessionRepository();
