const workspaceModules = import.meta.glob('../../../data/workspaces/*.json', {
  eager: true
});

export const workspaceConfigs = Object.fromEntries(
  Object.values(workspaceModules).map((module) => {
    const config = module.default;
    return [config.id, config];
  })
);

function createDefaultWorkspaceConfig(tool) {
  return {
    id: tool.id,
    title: tool.name,
    subtitle: tool.description,
    categoryLabel: '场景分类',
    inputLabel: '输入需求',
    resultLabel: '生成结果',
    mockBadge: 'AI 工具',
    placeholder: `请输入你想让「${tool.name}」完成的任务。`,
    exportFilePrefix: 'AI-Work-Center',
    categories: ['默认'],
    mockResults: {}
  };
}

export function getWorkspaceConfig(tool) {
  if (!tool) return null;
  const toolId = typeof tool === 'string' ? tool : tool.id;
  const toolConfig = typeof tool === 'string' ? { id: toolId, name: toolId } : tool;
  return {
    ...createDefaultWorkspaceConfig(toolConfig),
    ...(workspaceConfigs[toolId] || {}),
    tool: toolConfig,
    promptId: toolConfig.promptId || toolId,
    action: toolConfig.action || 'chat',
    capability: toolConfig.capability || workspaceConfigs[toolId]?.capability || 'CHAT'
  };
}
