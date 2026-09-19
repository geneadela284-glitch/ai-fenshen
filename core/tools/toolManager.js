import { toolRepository } from '../repositories/toolRepository.js';
import { createDemoTools } from './toolRegistry.js';

function normalizeTool(tool) {
  if (!tool?.id) {
    throw new Error('Tool must include id.');
  }

  return {
    category: tool.tag || 'general',
    enabled: tool.enabled !== false,
    provider: null,
    action: 'chat',
    visible: true,
    order: 999,
    version: '0.1.0',
    async execute(input = {}) {
      return {
        ok: true,
        toolId: tool.id,
        result: input.response?.content || input.input || '',
        mocked: true
      };
    },
    ...tool,
    title: tool.title || tool.name,
    execute: typeof tool.execute === 'function' ? tool.execute : async (input = {}) => ({
      ok: true,
      toolId: tool.id,
      result: input.response?.content || input.input || '',
      mocked: true
    })
  };
}

export class ToolManager {
  constructor({ repository = toolRepository, registry = createDemoTools() } = {}) {
    this.repository = repository;
    this.tools = new Map();
    this.repository.readAll().forEach((tool) => this.register(tool));
    registry.forEach((tool) => this.register(tool));
  }

  register(tool) {
    const normalized = normalizeTool(tool);
    this.tools.set(normalized.id, normalized);
    return normalized;
  }

  unregister(toolId) {
    return this.tools.delete(toolId);
  }

  enable(toolId) {
    const tool = this.load(toolId);
    return this.register({ ...tool, enabled: true });
  }

  disable(toolId) {
    const tool = this.load(toolId);
    return this.register({ ...tool, enabled: false });
  }

  load(toolId) {
    const tool = this.tools.get(toolId);
    if (!tool) {
      throw new Error(`Tool not found: ${toolId}`);
    }
    return tool;
  }

  list() {
    return Array.from(this.tools.values()).sort((a, b) => a.order - b.order);
  }

  listVisible() {
    return this.list().filter((tool) => tool.visible !== false);
  }

  listEnabled() {
    return this.list().filter((tool) => tool.enabled !== false);
  }

  getStats() {
    const all = this.list();
    const enabled = all.filter((tool) => tool.enabled !== false);
    const categories = all.reduce((acc, tool) => {
      const category = tool.category || 'general';
      acc[category] = (acc[category] || 0) + 1;
      return acc;
    }, {});
    return {
      total: all.length,
      enabled: enabled.length,
      categories
    };
  }

  async execute(toolId, input = {}) {
    const tool = this.load(toolId);
    if (tool.enabled === false) {
      throw new Error(`Tool disabled: ${toolId}`);
    }
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const result = await tool.execute(input);
    const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      toolId,
      toolName: tool.name,
      category: tool.category,
      version: tool.version,
      durationMs: Math.round(finishedAt - startedAt),
      result
    };
  }

  replaceTools(items) {
    this.tools.clear();
    items.forEach((tool) => this.register(tool));
  }
}

export const toolManager = new ToolManager();
