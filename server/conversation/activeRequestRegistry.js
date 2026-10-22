export class ActiveRequestRegistry {
  constructor({ settledLimit = 500 } = {}) {
    this.active = new Map();
    this.settled = new Map();
    this.settledLimit = settledLimit;
  }

  get activeCount() {
    return this.active.size;
  }

  register(entry) {
    if (this.active.has(entry.requestId)) throw new Error('REQUEST_ALREADY_ACTIVE');
    for (const previous of this.active.values()) {
      if (previous.ownerId === entry.ownerId && previous.conversationId === entry.conversationId && !previous.controller.signal.aborted) previous.controller.abort('superseded_by_new_input');
    }
    this.active.set(entry.requestId, entry);
    return entry;
  }

  cancelForOwner(requestId, ownerId) {
    const entry = this.active.get(requestId);
    if (entry) {
      if (entry.ownerId !== ownerId) return { status: 'not_found' };
      if (!entry.controller.signal.aborted) entry.controller.abort('user_cancelled');
      return { status: 'cancelled', requestId };
    }
    const settled = this.settled.get(requestId);
    if (settled?.ownerId === ownerId) return { status: 'already_finished', requestId, finalStatus: settled.status };
    return { status: 'not_found' };
  }

  cancelAllForOwner(ownerId) {
    let cancelled = 0;
    for (const entry of this.active.values()) {
      if (entry.ownerId !== ownerId) continue;
      if (!entry.controller.signal.aborted) entry.controller.abort('account_deleted');
      cancelled += 1;
    }
    for (const [requestId, entry] of this.settled.entries()) {
      if (entry.ownerId === ownerId) this.settled.delete(requestId);
    }
    return cancelled;
  }

  settle(requestId, status) {
    const entry = this.active.get(requestId);
    if (!entry) return false;
    this.active.delete(requestId);
    this.settled.set(requestId, { ownerId: entry.ownerId, status });
    while (this.settled.size > this.settledLimit) this.settled.delete(this.settled.keys().next().value);
    return true;
  }

  close() {
    for (const entry of this.active.values()) entry.controller.abort('runtime_closed');
    this.active.clear();
    this.settled.clear();
  }
}
