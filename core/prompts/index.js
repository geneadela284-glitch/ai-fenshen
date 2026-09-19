import promptCatalog from '../../data/prompts.json' with { type: 'json' };
import { memoryManager } from '../memory/memoryManager.js';

const tokenPattern = /\{\{\s*([\w.]+)\s*\}\}/g;

export function renderPrompt(template = '', data = {}) {
  return template.replace(tokenPattern, (_, key) => {
    const value = key.split('.').reduce((current, part) => current?.[part], data);
    return value ?? '';
  });
}

export function createPromptTemplate({ id, name, template }) {
  return {
    id,
    name,
    template,
    render(values = {}) {
      return renderPrompt(template, values);
    }
  };
}

export class PromptManager {
  constructor({ prompts = promptCatalog, memory = memoryManager } = {}) {
    this.prompts = prompts;
    this.memory = memory;
    this.lastMemoryContext = {
      loaded: 0,
      tokens: 0,
      preview: '',
      content: '',
      items: []
    };
  }

  loadPrompt(toolId) {
    const prompt = this.prompts[toolId];
    if (!prompt) {
      throw new Error(`Prompt not found: ${toolId}`);
    }
    return prompt;
  }

  renderPrompt(template, data = {}) {
    return renderPrompt(template, data);
  }

  buildMessages(toolId, data = {}) {
    const prompt = this.loadPrompt(toolId);
    const memoryContext = this.memory.buildPromptContext();
    this.lastMemoryContext = memoryContext;
    const system = this.renderPrompt(prompt.system, data);
    return [
      {
        role: 'system',
        content: memoryContext.content ? `${system}\n\n${memoryContext.content}` : system
      },
      {
        role: 'user',
        content: this.renderPrompt(prompt.user, data)
      }
    ];
  }

  getLastMemoryContext() {
    return this.lastMemoryContext;
  }

  listPrompts() {
    return Object.keys(this.prompts);
  }

  replacePrompts(prompts) {
    this.prompts = prompts;
  }
}

export class PromptEngine extends PromptManager {
  constructor({ templates = [], prompts = promptCatalog } = {}) {
    super({ prompts });
    this.templates = new Map();
    templates.forEach((template) => this.registerTemplate(template));
  }

  registerTemplate(template) {
    const normalized = typeof template.render === 'function' ? template : createPromptTemplate(template);
    this.templates.set(normalized.id, normalized);
    return normalized;
  }

  getTemplate(templateId) {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`Prompt template not found: ${templateId}`);
    }
    return template;
  }

  listTemplates() {
    return Array.from(this.templates.values()).map(({ id, name, template }) => ({
      id,
      name,
      template
    }));
  }

  render(templateId, values = {}) {
    return this.getTemplate(templateId).render(values);
  }
}

export const promptManager = new PromptManager();
export const promptEngine = new PromptEngine();
