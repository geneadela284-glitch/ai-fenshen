function key(ownerId, conversationId) {
  const owner = String(ownerId || '').trim();
  const conversation = String(conversationId || '').trim();
  return owner && conversation ? `${owner}\u0000${conversation}` : null;
}
function frozenClone(value) {
  return value === null || value === undefined ? null : Object.freeze(structuredClone(value));
}

export function createAssistantContextStateStore({ limit = 1000 } = {}) {
  const states = new Map();
  return Object.freeze({
    read(ownerId, conversationId) {
      const state = states.get(key(ownerId, conversationId));
      return frozenClone(state);
    },
    commit({ ownerId, conversationId, plan, toolResult = null } = {}) {
      const stateKey = key(ownerId, conversationId);
      if (!stateKey || !plan || typeof plan !== 'object') return false;
      const state = {
        owner: String(ownerId),
        conversation: String(conversationId),
        active_entity: plan.entity ? structuredClone(plan.entity) : null,
        active_predicate: plan.predicate ?? null,
        active_domain: plan.domain ?? null,
        active_action: plan.action ?? null,
        active_tool: plan.tool ?? null,
        active_arguments: structuredClone(plan.canonical_arguments || {}),
        required_evidence: structuredClone(plan.required_evidence || []),
        last_tool_result: toolResult === null ? null : structuredClone(toolResult)
      };
      states.delete(stateKey);
      states.set(stateKey, Object.freeze(state));
      while (states.size > limit) states.delete(states.keys().next().value);
      return true;
    },
    clear(ownerId, conversationId) {
      return states.delete(key(ownerId, conversationId));
    }
  });
}
