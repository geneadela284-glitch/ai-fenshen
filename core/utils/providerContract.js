const requiredMethods = ['generate', 'chat', 'image', 'embedding'];

export function assertProviderContract(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Provider must be an object.');
  }

  if (!provider.id || !provider.name) {
    throw new Error('Provider must include id and name.');
  }

  requiredMethods.forEach((method) => {
    if (typeof provider[method] !== 'function') {
      throw new Error(`Provider ${provider.id} is missing ${method}().`);
    }
  });
}
