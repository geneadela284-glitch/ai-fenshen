import { randomUUID } from 'node:crypto';

const UNSAFE_KEY = /(?:password|passcode|token|cookie|api.?key|private.?key|secret|body|content|prompt|authorization)/i;

function freeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freeze);
  return value;
}

export class MemoryIntegrationAudit {
  constructor({ clock = () => new Date(), idFactory = randomUUID } = {}) {
    this.clock = clock;
    this.idFactory = idFactory;
    this.events = [];
  }

  record({ userId, action, result, reasonCode, memoryId = null, requestId, metadata = {} }) {
    if (Object.keys(metadata).some((key) => UNSAFE_KEY.test(key))) {
      const error = new Error('Unsafe audit metadata.');
      error.code = 'MEMORY_AUDIT_UNSAFE_METADATA';
      throw error;
    }
    const value = this.clock();
    const event = freeze({
      eventId: this.idFactory(),
      userId: String(userId || ''),
      action: String(action || ''),
      result: String(result || ''),
      reasonCode: String(reasonCode || ''),
      memoryId: memoryId ? String(memoryId) : null,
      requestId: String(requestId || ''),
      occurredAt: (value instanceof Date ? value : new Date(value)).toISOString(),
      metadata: structuredClone(metadata)
    });
    this.events.push(event);
    return event;
  }

  list(userId) {
    return freeze(this.events.filter((event) => event.userId === userId).map((event) => structuredClone(event)));
  }
}
