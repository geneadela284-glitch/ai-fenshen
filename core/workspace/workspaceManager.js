import { workspaceRepository } from '../repositories/workspaceRepository.js';

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return new Date().toISOString();
}

function normalizeMessage(message, toolId) {
  return {
    id: message.id || createId('message'),
    role: message.role,
    content: message.content || '',
    time: message.time || now(),
    toolId: message.toolId || toolId,
    provider: message.provider || '',
    model: message.model || '',
    prompt: message.prompt || null,
    generatedContent: message.generatedContent || (message.role === 'assistant' ? message.content || '' : ''),
    tokens: Number(message.tokens || 0)
  };
}

function normalizeWorkspace(workspace) {
  const createdAt = workspace.createdAt || now();
  const updatedAt = workspace.updatedAt || createdAt;
  const title = workspace.title || workspace.name || '新 Workspace';
  const messages = Array.isArray(workspace.messages)
    ? workspace.messages.map((message) => normalizeMessage(message, workspace.toolId))
    : [];

  return {
    id: workspace.id || createId('workspace'),
    toolId: workspace.toolId,
    title,
    name: workspace.name || title,
    createdAt,
    updatedAt,
    lastOpenedAt: workspace.lastOpenedAt || updatedAt,
    lastEditedAt: workspace.lastEditedAt || updatedAt,
    prompt: workspace.prompt || null,
    generatedContent: workspace.generatedContent || '',
    provider: workspace.provider || '',
    model: workspace.model || '',
    tokens: Number(workspace.tokens || 0),
    messages
  };
}

export class WorkspaceManager {
  constructor({ repository = workspaceRepository } = {}) {
    this.repository = repository;
  }

  migrateLegacy() {
    const legacy = this.repository.readLegacySessions();
    if (!legacy.length) return [];

    const migrated = legacy.map((session) =>
      normalizeWorkspace({
        ...session,
        id: session.id?.replace('session-', 'workspace-') || session.id,
        name: session.title,
        title: session.title
      })
    );
    this.saveAll(migrated);

    const legacyActive = this.repository.readLegacyActiveSessions();
    if (Object.keys(legacyActive).length) {
      const activeMap = Object.fromEntries(
        Object.entries(legacyActive).map(([toolId, sessionId]) => [
          toolId,
          sessionId?.replace('session-', 'workspace-') || sessionId
        ])
      );
      this.repository.setActiveMap(activeMap);
    }
    this.repository.deleteLegacySessions();

    return migrated;
  }

  all() {
    const workspaces = this.repository.readAll();
    if (workspaces.length) return workspaces.map(normalizeWorkspace);
    return this.migrateLegacy();
  }

  saveAll(workspaces) {
    const normalized = workspaces.map(normalizeWorkspace);
    this.repository.replaceAll(normalized);
    return normalized;
  }

  list(toolId) {
    return this.all()
      .filter((workspace) => workspace.toolId === toolId)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  recent(limit = 6) {
    return this.all()
      .sort((a, b) => new Date(b.lastEditedAt || b.updatedAt) - new Date(a.lastEditedAt || a.updatedAt))
      .slice(0, limit);
  }

  load(workspaceId) {
    return this.all().find((workspace) => workspace.id === workspaceId) || null;
  }

  create({ toolId, title = '新 Workspace' }) {
    const workspace = normalizeWorkspace({ toolId, title, name: title });
    this.saveAll([workspace, ...this.all()]);
    this.setActiveWorkspaceId(toolId, workspace.id);
    return workspace;
  }

  ensure(toolId, title = '新 Workspace') {
    const activeId = this.getActiveWorkspaceId(toolId);
    const active = activeId ? this.load(activeId) : null;
    if (active) return this.touchOpen(active.id);

    const latest = this.list(toolId)[0];
    if (latest) {
      this.setActiveWorkspaceId(toolId, latest.id);
      return this.touchOpen(latest.id);
    }

    return this.create({ toolId, title });
  }

  update(workspace) {
    const normalized = normalizeWorkspace({ ...workspace, updatedAt: now() });
    const workspaces = this.all();
    const exists = workspaces.some((item) => item.id === normalized.id);
    const nextWorkspaces = exists
      ? workspaces.map((item) => (item.id === normalized.id ? normalized : item))
      : [normalized, ...workspaces];
    this.saveAll(nextWorkspaces);
    return normalized;
  }

  touchOpen(workspaceId) {
    const workspace = this.load(workspaceId);
    if (!workspace) return null;
    return this.update({ ...workspace, lastOpenedAt: now() });
  }

  rename(workspaceId, title) {
    const workspace = this.load(workspaceId);
    if (!workspace || !title?.trim()) return workspace;
    return this.update({ ...workspace, title: title.trim(), name: title.trim(), lastEditedAt: now() });
  }

  duplicate(workspaceId) {
    const workspace = this.load(workspaceId);
    if (!workspace) return null;
    const copied = normalizeWorkspace({
      ...workspace,
      id: createId('workspace'),
      title: `${workspace.title} 副本`,
      name: `${workspace.title} 副本`,
      createdAt: now(),
      updatedAt: now(),
      lastOpenedAt: now(),
      lastEditedAt: now(),
      messages: workspace.messages.map((message) => ({ ...message, id: createId('message') }))
    });
    this.saveAll([copied, ...this.all()]);
    this.setActiveWorkspaceId(copied.toolId, copied.id);
    return copied;
  }

  delete(workspaceId) {
    const workspace = this.load(workspaceId);
    if (!workspace) return false;

    this.saveAll(this.all().filter((item) => item.id !== workspaceId));
    const active = this.getActiveWorkspaceId(workspace.toolId);
    if (active === workspaceId) {
      const next = this.list(workspace.toolId)[0];
      if (next) {
        this.setActiveWorkspaceId(workspace.toolId, next.id);
      } else {
        this.clearActiveWorkspaceId(workspace.toolId);
      }
    }
    return true;
  }

  addMessage(workspaceId, message) {
    const workspace = this.load(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const nextMessage = normalizeMessage(message, workspace.toolId);
    const title =
      workspace.messages.length === 0 && nextMessage.role === 'user'
        ? nextMessage.content.slice(0, 24) || workspace.title
        : workspace.title;
    const isAssistant = nextMessage.role === 'assistant';

    return this.update({
      ...workspace,
      title,
      name: title,
      messages: [...workspace.messages, nextMessage],
      prompt: nextMessage.prompt || workspace.prompt,
      generatedContent: isAssistant ? nextMessage.generatedContent || nextMessage.content : workspace.generatedContent,
      provider: nextMessage.provider || workspace.provider,
      model: nextMessage.model || workspace.model,
      tokens: Number(workspace.tokens || 0) + Number(nextMessage.tokens || 0),
      lastEditedAt: now()
    });
  }

  getActiveMap() {
    return this.repository.getActiveMap();
  }

  getActiveWorkspaceId(toolId) {
    return this.getActiveMap()[toolId] || '';
  }

  setActiveWorkspaceId(toolId, workspaceId) {
    this.repository.setActiveMap({
      ...this.getActiveMap(),
      [toolId]: workspaceId
    });
    return workspaceId;
  }

  clearActiveWorkspaceId(toolId) {
    const activeMap = this.getActiveMap();
    delete activeMap[toolId];
    this.repository.setActiveMap(activeMap);
  }

  getToolSummary(toolId) {
    const workspaces = this.list(toolId);
    const recentOpened = [...workspaces].sort(
      (a, b) => new Date(b.lastOpenedAt || b.updatedAt) - new Date(a.lastOpenedAt || a.updatedAt)
    )[0];
    const recentEdited = [...workspaces].sort(
      (a, b) => new Date(b.lastEditedAt || b.updatedAt) - new Date(a.lastEditedAt || a.updatedAt)
    )[0];

    return {
      recentOpened,
      recentEdited,
      lastEditedAt: recentEdited?.lastEditedAt || recentEdited?.updatedAt || '',
      continueWorkspace: recentEdited || recentOpened || null
    };
  }
}

export const workspaceManager = new WorkspaceManager();
