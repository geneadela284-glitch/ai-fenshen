export const modelCapabilities = {
  text: ['generate', 'chat'],
  vision: ['image'],
  embedding: ['embedding']
};

export function supportsCapability(model, capability) {
  return Boolean(model?.capabilities?.includes(capability));
}
