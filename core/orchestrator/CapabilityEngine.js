export const capabilities = [
  'Writing',
  'Reasoning',
  'Vision',
  'Coding',
  'Meeting',
  'Translation',
  'Knowledge',
  'OCR',
  'Table Analysis',
  'Presentation',
  'Workflow',
  'Long Context',
  'Embedding',
  'Search',
  'Tool Call'
];

export const taskCapabilityMap = {
  writing: ['Writing'],
  reasoning: ['Reasoning'],
  data_analysis: ['Table Analysis', 'Reasoning'],
  presentation: ['Presentation', 'Writing'],
  general: ['Writing'],
  image_analysis: ['Vision'],
  long_context_summary: ['Long Context'],
  contract_review: ['Reasoning', 'Knowledge'],
  knowledge_qa: ['Knowledge', 'Long Context']
};

export class CapabilityEngine {
  normalizeCapabilities(provider = {}) {
    const tags = Array.isArray(provider.tags) ? provider.tags : provider.capabilities || [];
    const next = new Set(tags);
    if (provider.visionSupported) next.add('Vision');
    if (provider.reasoningSupported) next.add('Reasoning');
    if (provider.toolCallSupported) next.add('Tool Call');
    if (provider.embeddingSupported) next.add('Embedding');
    if (Number(provider.maxContext || 0) >= 100000) next.add('Long Context');
    return [...next].filter((capability) => capabilities.includes(capability) || ['Fast', 'Cheap'].includes(capability));
  }

  requiredForTask(taskType = 'general') {
    return taskCapabilityMap[taskType] || taskCapabilityMap.general;
  }

  supports(provider = {}, required = []) {
    const providerCapabilities = this.normalizeCapabilities(provider);
    return required.every((capability) => providerCapabilities.includes(capability));
  }

  explain(provider = {}, required = []) {
    const providerCapabilities = this.normalizeCapabilities(provider);
    return {
      providerId: provider.id,
      required,
      matched: required.filter((capability) => providerCapabilities.includes(capability)),
      missing: required.filter((capability) => !providerCapabilities.includes(capability))
    };
  }
}

export const capabilityEngine = new CapabilityEngine();
export default capabilityEngine;
