const secretaryIdentityPatterns = [
  /(?:我是|作为)\s*(?:AI\s*Work\s*Center\s*(?:的\s*)?)?(?:企业\s*)?工作秘书/gi
];

const modelIdentityPatterns = [
  /(?:我是|作为)\s*(?:一个)?\s*[^，,。.!！?？：:\n]{0,30}?(?:语言模型|模型)[，,：:\s]*/giu
];

const providerSelfIdentityPatterns = [
  /(?:我是|作为)\s*(?:DeepSeek|通义千问|Qwen|Kimi|Moonshot|智谱(?:\s*AI)?|GLM|豆包|Doubao|OpenAI|ChatGPT|Claude|Gemini)(?:\s*(?:AI|助手|大模型))?/gi
];

const providerIdentityPatterns = [
  /(?:由|基于)\s*(?:DeepSeek|通义千问|Qwen|Kimi|Moonshot|智谱(?:\s*AI)?|GLM)(?:\s*提供|\s*驱动)?[，,：:\s]*/gi
];

export function applyResponsePolicy(content = '', { programResult = '' } = {}) {
  let next = String(programResult || content || '');
  secretaryIdentityPatterns.forEach((pattern) => {
    next = next.replace(pattern, '我是AI分身');
  });
  providerSelfIdentityPatterns.forEach((pattern) => {
    next = next.replace(pattern, '我是AI分身');
  });
  modelIdentityPatterns.forEach((pattern) => {
    next = next.replace(pattern, '');
  });
  providerIdentityPatterns.forEach((pattern) => {
    next = next.replace(pattern, '');
  });
  return next.trim();
}

export default applyResponsePolicy;
