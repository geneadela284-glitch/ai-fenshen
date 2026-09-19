export function shouldDismissMeetingOverflowMenu({ root, target } = {}) {
  if (!root || typeof root.contains !== 'function') return false;
  return !root.contains(target);
}
