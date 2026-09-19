import { createHash } from 'node:crypto';

import { deepFreeze } from './contracts.js';

function reference(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

export class CaptureAudit {
  constructor({ clock = () => new Date() } = {}) {
    this.clock = clock;
  }

  create({ context, outcome, reasonCode, intent, sensitivity = null, memoryType = null, memoryId = null }) {
    const clockValue = this.clock();
    return deepFreeze({
      eventId: reference(`${context.requestId}:${outcome}:${reasonCode}`),
      actorRef: reference(context.authenticatedUserId),
      requestRef: reference(context.requestId),
      outcome,
      reasonCode,
      intent,
      sensitivity,
      memoryType,
      memoryId,
      occurredAt: (clockValue instanceof Date ? clockValue : new Date(clockValue)).toISOString()
    });
  }
}
