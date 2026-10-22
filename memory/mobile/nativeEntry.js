import { createMobileMemoryRuntime } from './runtime.js';
if (!globalThis.structuredClone) globalThis.structuredClone = function copy(value) {
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [copy(k), copy(v)]));
  if (value instanceof Set) return new Set([...value].map(copy));
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]));
  return value;
};
let runtime;
function unwrap(json) {
  const result = JSON.parse(json);
  if (result.error) throw Object.assign(new Error(result.error), { code: result.error });
  return result.value;
}
globalThis.MobileMemoryHost = {
  async initialize(ownerUserId) {
    runtime?.close();
    runtime = await createMobileMemoryRuntime({ ownerUserId, storage: {
      load: scope => unwrap(globalThis.__memoryLoad(scope)),
      commit: (scope, command) => unwrap(globalThis.__memoryCommit(scope, JSON.stringify(command)))
    } });
    return { ready: true };
  },
  invoke(id, commandJSON) {
    Promise.resolve().then(() => runtime.execute(JSON.parse(commandJSON))).then(
      value => globalThis.__memoryDone(id, JSON.stringify({ value })),
      error => globalThis.__memoryDone(id, JSON.stringify({ error: error.code || 'LOCAL_MEMORY_FAILED' })));
  },
  start(id, ownerUserId) {
    this.initialize(ownerUserId).then(value => globalThis.__memoryDone(id, JSON.stringify({ value })),
      error => globalThis.__memoryDone(id, JSON.stringify({ error: error.code || 'LOCAL_MEMORY_FAILED' })));
  },
  close() { runtime?.close(); runtime = null; }
};
