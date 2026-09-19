function normalizeOwnerId(value) {
  const ownerId = String(value || '').trim();
  return ownerId || null;
}

export function createAccountSessionBoundary({ initialOwnerId = null } = {}) {
  let ownerId = normalizeOwnerId(initialOwnerId);
  let generation = 1;

  const snapshot = () => Object.freeze({ ownerId, generation });

  return Object.freeze({
    transitionTo(nextOwnerId) {
      const normalized = normalizeOwnerId(nextOwnerId);
      if (normalized === ownerId) return Object.freeze({ changed: false, token: snapshot() });
      ownerId = normalized;
      generation += 1;
      return Object.freeze({ changed: true, token: snapshot() });
    },
    capture() {
      return snapshot();
    },
    isCurrent(token) {
      return Boolean(token) && token.ownerId === ownerId && token.generation === generation;
    },
    isOwner(candidateOwnerId) {
      return ownerId !== null && ownerId === normalizeOwnerId(candidateOwnerId);
    },
    currentOwnerId() {
      return ownerId;
    }
  });
}

export function createAccountWorkspaceTransition({
  initialOwnerId = null,
  onReset = () => {}
} = {}) {
  if (typeof onReset !== 'function') throw new TypeError('onReset must be a function');
  const boundary = createAccountSessionBoundary({ initialOwnerId });

  return Object.freeze({
    transitionTo(nextOwnerId) {
      const previousOwnerId = boundary.currentOwnerId();
      const transition = boundary.transitionTo(nextOwnerId);
      if (transition.changed) {
        onReset(Object.freeze({
          previousOwnerId,
          nextOwnerId: boundary.currentOwnerId()
        }));
      }
      return transition.token;
    },
    capture() {
      return boundary.capture();
    },
    commit(token, writer) {
      if (!boundary.isCurrent(token)) return false;
      if (typeof writer !== 'function') throw new TypeError('writer must be a function');
      writer();
      return true;
    },
    isCurrent(token) {
      return boundary.isCurrent(token);
    },
    isOwner(ownerId) {
      return boundary.isOwner(ownerId);
    },
    currentOwnerId() {
      return boundary.currentOwnerId();
    }
  });
}
