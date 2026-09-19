export const ENTITY_RESOLUTION_PURPOSES = Object.freeze(['capture', 'recall']);

export function validateAIEntityResolver(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('AI Entity Resolver must be an object.');
  } else if (typeof value.resolve !== 'function') {
    errors.push('AI Entity Resolver must expose resolve(input).');
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}
