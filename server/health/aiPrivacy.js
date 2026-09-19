// Health history is never ambient context for unrelated conversations.
const healthTopic = /健康|体重|血压|血糖|体温|体检|复查|健身|运动|训练|饮食|菜谱|记餐|早餐|午餐|晚餐|health-turn-v1|health-proposal-v1|\/#health=/;
export function redactHealthHistory(messages = []) {
  if (!Array.isArray(messages)) return [];
  const redact = new Set();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!['user', 'assistant'].includes(m?.role)) continue;
    if (!healthTopic.test(String(m?.content || ''))) continue;
    redact.add(i);
    if (m.role === 'assistant' && messages[i - 1]?.role === 'user') redact.add(i - 1);
    if (m.role === 'user' && messages[i + 1]?.role === 'assistant') redact.add(i + 1);
  }
  return messages.filter((_, i) => !redact.has(i));
}
export function redactStreamHistory(messages = []) {
  if (!Array.isArray(messages)) return [];
  // The final user turn is the current explicit request, not ambient history.
  const current = messages.at(-1);
  if (current?.role === 'user') return [...redactHealthHistory(messages.slice(0, -1)), current];
  return redactHealthHistory(messages);
}
export function healthPrivateAiService(aiService) {
  // Preserve prototype methods and receiver binding without copying provider state.
  return new Proxy(aiService, {
    get(target, property) {
      if (property === 'stream') return (task, options, invocation) => target.stream({
        ...task,
        messages: redactStreamHistory(task.messages)
      }, options, invocation);
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
