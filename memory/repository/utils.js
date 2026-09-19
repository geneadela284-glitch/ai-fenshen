import { createHash } from 'node:crypto';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function clone(value) {
  return structuredClone(value);
}

export function freezeClone(value) {
  const output = clone(value);
  const stack = [output];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object' || Object.isFrozen(current)) continue;
    for (const nested of Object.values(current)) stack.push(nested);
    Object.freeze(current);
  }
  return output;
}
