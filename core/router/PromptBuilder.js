export class PromptBuilder {
  constructor({ now = () => new Date() } = {}) {
    this.now = now;
  }

  build(task = {}, route = {}) {
    const metadata = task.metadata || {};
    const date = new Date(metadata.currentTime || this.now());
    const timeZone = metadata.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
    const dateText = new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(date);
    const trustedContext = [
      '应用可信上下文：',
      `- 当前日期时间：${dateText}`,
      `- 用户时区：${timeZone}`,
      `- 当前页面：${metadata.pageContext || 'unknown'}`,
      `- 当前会话 ID：${metadata.conversationId || 'unknown'}`,
      '- 应用提供的日期、时间和程序计算结果是可信事实，不得否认或改写。',
      '- 不得向普通用户暴露 Provider、Model、API Key 或内部路由。'
    ].join('\n');
    const messages = Array.isArray(task.messages) ? task.messages.map((message) => ({ ...message })) : [];
    const systemIndex = messages.findIndex((message) => message.role === 'system');
    if (systemIndex >= 0 && typeof messages[systemIndex].content === 'string') {
      messages[systemIndex].content = `${trustedContext}\n\n${messages[systemIndex].content}`;
    } else {
      messages.unshift({ role: 'system', content: trustedContext });
    }
    if (!messages.some((message) => message.role !== 'system') && (task.input || task.prompt)) {
      messages.push({ role: 'user', content: task.input || task.prompt });
    }
    return {
      ...task,
      provider: undefined,
      providerId: undefined,
      metadata: {
        ...metadata,
        capability: route.capability,
        routedBy: 'AIRouter'
      },
      messages,
      options: {
        ...(task.options || {}),
        model: route.model
      }
    };
  }
}

export const promptBuilder = new PromptBuilder();
export default promptBuilder;
