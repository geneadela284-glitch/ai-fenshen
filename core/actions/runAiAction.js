import aiEngine from '../ai/AIEngine.js';

const actionToMethod = {
  generate: 'generate',
  chat: 'chat',
  summarize: 'summarize',
  classify: 'classify',
  extract: 'extract',
  analyze: 'analyze'
};

export async function runAiAction(action) {
  const method = actionToMethod[action.type || 'generate'];
  if (!method) {
    throw new Error(`Unsupported AI action type: ${action.type}`);
  }

  return aiEngine[method]({
    capability: action.capability,
    prompt: action.prompt,
    input: action.input,
    messages: action.messages,
    options: action.options,
    workspaceId: action.workspaceId,
    memory: action.memory,
    knowledge: action.knowledge,
    temperature: action.temperature,
    metadata: action.metadata
  });
}
