import { CAPABILITIES, normalizeCapability } from './CapabilityMap.js';

const TEXT_BASE = [
  CAPABILITIES.CHAT,
  CAPABILITIES.WRITING,
  CAPABILITIES.SUMMARIZATION,
  CAPABILITIES.STRUCTURED_EXTRACTION,
  CAPABILITIES.TRANSLATION
];

function unique(values = []) {
  return [...new Set(values.map(normalizeCapability))];
}

function configuredCapabilities(config = {}, modelId = '') {
  const direct = config.modelCapabilities?.[modelId];
  return Array.isArray(direct) ? unique(direct) : null;
}

export function inferModelCapabilities(providerId = '', modelId = '', config = {}) {
  const configured = configuredCapabilities(config, modelId);
  if (configured) return configured;

  const provider = String(providerId || '').toLowerCase();
  const model = String(modelId || '').toLowerCase();
  if (!model) return [];

  if (provider === 'deepseek') {
    return unique([
      ...TEXT_BASE,
      CAPABILITIES.REASONING,
      CAPABILITIES.DATA_ANALYSIS,
      CAPABILITIES.MEETING_SUMMARY,
      ...(model.includes('reasoner') ? [CAPABILITIES.REASONING] : [])
    ]);
  }

  if (provider === 'qwen') {
    if (/ocr/.test(model)) {
      return unique([CAPABILITIES.OCR, CAPABILITIES.STRUCTURED_EXTRACTION]);
    }
    if (/qwen[^/]*(?:vl|omni)|qvq/.test(model)) {
      return unique([...TEXT_BASE, CAPABILITIES.VISION, CAPABILITIES.STRUCTURED_EXTRACTION]);
    }
    return unique([...TEXT_BASE, CAPABILITIES.REASONING, CAPABILITIES.DATA_ANALYSIS, CAPABILITIES.MEETING_SUMMARY]);
  }

  if (provider === 'zhipu') {
    if (/glm[^/]*-4v|vision/.test(model)) {
      return unique([...TEXT_BASE, CAPABILITIES.VISION, CAPABILITIES.OCR]);
    }
    return unique([...TEXT_BASE, CAPABILITIES.REASONING, CAPABILITIES.DATA_ANALYSIS]);
  }

  if (provider === 'kimi') {
    return unique([...TEXT_BASE, CAPABILITIES.SUMMARIZATION, CAPABILITIES.MEETING_SUMMARY]);
  }

  if (provider === 'doubao') {
    if (/^ep-/i.test(model)) return unique(TEXT_BASE);
    const supportsVision = /vision|视觉|image/.test(model)
      || /doubao-seed-(?:1-6|1-8|2-0)(?:-|$)/.test(model);
    return supportsVision
      ? unique([...TEXT_BASE, CAPABILITIES.VISION, CAPABILITIES.OCR])
      : unique(TEXT_BASE);
  }

  return unique(TEXT_BASE);
}

export function modelSupportsCapability(providerId, modelId, capability, config = {}) {
  return inferModelCapabilities(providerId, modelId, config).includes(normalizeCapability(capability));
}
