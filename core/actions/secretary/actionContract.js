const LIFECYCLE_METHODS = Object.freeze([
  'validate',
  'prepare',
  'confirm',
  'execute',
  'rollback',
  'audit'
]);

export function validateActionContract(action) {
  if (!action || typeof action !== 'object') throw new Error('Action Contract 必须是对象');
  if (!String(action.name || '').trim()) throw new Error('Action Contract 缺少 name');
  if (!String(action.type || '').trim()) throw new Error('Action Contract 缺少 type');
  for (const method of LIFECYCLE_METHODS) {
    if (typeof action[method] !== 'function') {
      throw new Error(`Action Contract 缺少 ${method}()`);
    }
  }
  return true;
}

export { LIFECYCLE_METHODS };
