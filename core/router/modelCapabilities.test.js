import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAPABILITIES } from './CapabilityMap.js';
import { TaskClassifier } from './TaskClassifier.js';
import { inferModelCapabilities, modelSupportsCapability } from './ModelCapabilities.js';

test('qwen vision and OCR models keep distinct verified responsibilities', () => {
  assert.equal(modelSupportsCapability('qwen', 'qwen-max', CAPABILITIES.VISION), false);
  assert.equal(modelSupportsCapability('qwen', 'qwen3-vl-plus', CAPABILITIES.VISION), true);
  assert.equal(modelSupportsCapability('qwen', 'qwen3-vl-plus', CAPABILITIES.OCR), false);
  assert.equal(modelSupportsCapability('qwen', 'qwen3.5-ocr', CAPABILITIES.OCR), true);
  assert.equal(modelSupportsCapability('qwen', 'qwen3.5-ocr', CAPABILITIES.VISION), false);
});

test('current Chinese provider defaults declare only inferred model capabilities', () => {
  assert.equal(inferModelCapabilities('deepseek', 'deepseek-chat').includes(CAPABILITIES.VISION), false);
  assert.equal(inferModelCapabilities('deepseek', 'deepseek-chat').includes(CAPABILITIES.MEETING_SUMMARY), true);
  assert.equal(inferModelCapabilities('kimi', 'moonshot-v1-32k').includes(CAPABILITIES.MEETING_SUMMARY), true);
  assert.equal(inferModelCapabilities('zhipu', 'glm-4.5').includes(CAPABILITIES.VISION), false);
  assert.equal(inferModelCapabilities('zhipu', 'glm-4v-plus').includes(CAPABILITIES.VISION), true);
});

test('doubao multimodal models support vision and OCR without treating text models as visual', () => {
  assert.equal(modelSupportsCapability('doubao', 'doubao-1.5-pro-32k', CAPABILITIES.VISION), false);
  assert.equal(modelSupportsCapability('doubao', 'doubao-seed-1-6-250615', CAPABILITIES.VISION), true);
  assert.equal(modelSupportsCapability('doubao', 'doubao-seed-2-0-lite-260215', CAPABILITIES.VISION), true);
  assert.equal(modelSupportsCapability('doubao', 'doubao-seed-2-0-lite-260215', CAPABILITIES.OCR), true);
});

test('opaque doubao endpoint IDs require explicit per-model capability configuration', () => {
  const endpointId = 'ep-20260714-vision';
  assert.equal(modelSupportsCapability('doubao', endpointId, CAPABILITIES.VISION), false);
  assert.equal(modelSupportsCapability('doubao', endpointId, CAPABILITIES.VISION, {
    modelCapabilities: { [endpointId]: [CAPABILITIES.CHAT, CAPABILITIES.VISION, CAPABILITIES.OCR] }
  }), true);
});

test('task classifier exposes the Sprint 18 capabilities', () => {
  const classifier = new TaskClassifier();
  assert.equal(classifier.classify({ input: '帮我写一篇产品介绍' }), CAPABILITIES.WRITING);
  assert.equal(classifier.classify({ input: '分析这个方案的逻辑风险' }), CAPABILITIES.REASONING);
  assert.equal(classifier.classify({ input: '把这些内容提取成 JSON' }), CAPABILITIES.STRUCTURED_EXTRACTION);
  assert.equal(classifier.classify({ input: '分析表格里的销售趋势' }), CAPABILITIES.DATA_ANALYSIS);
  assert.equal(classifier.classify({ input: '整理这次会议纪要' }), CAPABILITIES.MEETING_SUMMARY);
});
