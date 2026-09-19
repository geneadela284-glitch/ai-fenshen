import { knowledgeManager } from '../knowledge/knowledgeManager.js';

class BaseTool {
  constructor({ id, name, description, icon, category, version = '0.1.0', enabled = true, visible = false }) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.icon = icon;
    this.category = category;
    this.version = version;
    this.enabled = enabled;
    this.visible = visible;
  }
}

export class WriteArticleTool extends BaseTool {
  constructor() {
    super({
      id: 'writeArticle',
      name: 'WriteArticleTool',
      description: '生成文章、产品介绍和营销文案的工具接口。',
      icon: '✍',
      category: 'content'
    });
  }

  async execute(input = {}) {
    return {
      type: 'article',
      content: input.response?.content || input.input || '',
      source: 'workspace-response'
    };
  }
}

export class SearchKnowledgeTool extends BaseTool {
  constructor() {
    super({
      id: 'searchKnowledge',
      name: 'SearchKnowledgeTool',
      description: '搜索本地企业知识库，预留给后续 RAG 调用。',
      icon: '⌕',
      category: 'knowledge'
    });
  }

  async execute(input = {}) {
    const keyword = input.keyword || input.input || '';
    return {
      type: 'knowledge-search',
      items: knowledgeManager.search({ keyword }).slice(0, 5)
    };
  }
}

export class GeneratePPTTool extends BaseTool {
  constructor() {
    super({
      id: 'generatePPT',
      name: 'GeneratePPTTool',
      description: '生成 PPT 大纲和页面结构的工具接口。',
      icon: '▦',
      category: 'office'
    });
  }

  async execute(input = {}) {
    return {
      type: 'ppt-outline',
      outline: input.response?.content || input.input || ''
    };
  }
}

export class ImageTool extends BaseTool {
  constructor() {
    super({
      id: 'imageTool',
      name: 'ImageTool',
      description: '生成图片提示词和视觉说明的工具接口。',
      icon: '◐',
      category: 'creative'
    });
  }

  async execute(input = {}) {
    return {
      type: 'image-prompt',
      prompt: input.response?.content || input.input || ''
    };
  }
}

export function createDemoTools() {
  return [
    new WriteArticleTool(),
    new SearchKnowledgeTool(),
    new GeneratePPTTool(),
    new ImageTool()
  ];
}
