function validateRegistration(tool) {
  if (!tool || typeof tool !== 'object') throw new TypeError('Tool registration requires a contract and declared schemas.');
  if (typeof tool.id !== 'string' || !tool.id || typeof tool.description !== 'string' || !tool.description) throw new TypeError('Tool schema requires id and description.');
  if (!tool.argumentSchema || typeof tool.argumentSchema !== 'object') throw new TypeError('Tool argument schema is required.');
  if (!Array.isArray(tool.actions) || tool.actions.length === 0) throw new TypeError('Tool action schema is required.');
  if (!tool.evidenceSchema || typeof tool.evidenceSchema !== 'object') throw new TypeError('Tool evidence schema is required.');
  if (!Array.isArray(tool.permissions) || tool.permissions.length === 0) throw new TypeError('Tool permission declaration is required.');
  if (typeof tool.planSchema !== 'function') throw new TypeError('Tool plan schema is required.');
  if (typeof tool.resultSchema !== 'function') throw new TypeError('Tool result schema is required.');
  if (typeof tool.failureBehavior !== 'string' || !tool.failureBehavior) throw new TypeError('Tool failure behavior is required.');
  if (typeof tool.contract !== 'function') throw new TypeError('Tool contract is required.');
  if (typeof tool.execute !== 'function') throw new TypeError('Tool execute is required.');
}

export function createAssistantToolRegistry() {
  const tools = new Map();
  return Object.freeze({
    register(tool) {
      validateRegistration(tool);
      if (tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
      tools.set(tool.id, Object.freeze({ ...tool }));
    },
    descriptors() {
      return [...tools.values()].map((tool) => ({
        id: tool.id,
        description: tool.description,
        argumentSchema: structuredClone(tool.argumentSchema),
        actions: [...tool.actions],
        evidenceSchema: structuredClone(tool.evidenceSchema),
        permissions: [...tool.permissions],
        planSchema: 'declared',
        resultSchema: 'declared',
        failureBehavior: tool.failureBehavior
      }));
    },
    validatePlan(id, plan, context = {}) {
      const tool = tools.get(id);
      if (!tool) return { ok: false, errors: ['tool: not registered'] };
      try {
        const result = tool.planSchema(plan, context);
        return result?.ok === true ? { ok: true, errors: [] } : { ok: false, errors: result?.errors || ['tool plan invalid'] };
      } catch {
        return { ok: false, errors: ['tool plan invalid'] };
      }
    },
    async invoke(id, input) {
      const tool = tools.get(id);
      if (!tool) throw new Error(`Tool not registered: ${id}`);
      const contract = await tool.contract(input);
      if (contract?.decision !== 'ACCEPT') return contract;
      let result;
      try { result = await tool.execute(contract.input); } catch { return { decision: 'ERROR', code: 'TOOL_EXECUTION_FAILED' }; }
      if (!tool.resultSchema(result)) return { decision: 'ERROR', code: 'TOOL_RESULT_INVALID' };
      return { decision: 'ACCEPT', result };
    }
  });
}
