import crypto from 'node:crypto';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export class FakeBusinessRecordAdapter {
  constructor({ now = () => new Date().toISOString(), fail = false, duplicateWindowMs = 5 * 60 * 1000 } = {}) {
    this.now = now;
    this.fail = fail;
    this.duplicateWindowMs = duplicateWindowMs;
    this.records = [];
    this.calls = [];
  }

  inspect({ ownerUserId, structuredValue, idempotencyKey }) {
    const exact = this.records.find((record) =>
      record.ownerUserId === ownerUserId && record.idempotencyKey === idempotencyKey
    );
    if (exact) return { duplicateStatus: 'exact', recordId: exact.recordId };
    const digest = fingerprint(structuredValue);
    const now = Date.parse(this.now());
    const possible = this.records.find((record) =>
      record.ownerUserId === ownerUserId &&
      record.structuredValueDigest === digest &&
      Math.abs(now - Date.parse(record.committedAt)) <= this.duplicateWindowMs
    );
    return possible
      ? { duplicateStatus: 'possible', recordId: possible.recordId }
      : { duplicateStatus: 'none', recordId: null };
  }

  commit(input) {
    this.calls.push(structuredClone(input));
    const replay = this.records.find((record) =>
      record.ownerUserId === input.ownerUserId && record.idempotencyKey === input.idempotencyKey
    );
    if (replay) return { committed: true, recordId: replay.recordId, replayed: true };
    if (this.fail) return { committed: false, errorCode: 'BUSINESS_COMMIT_FAILED' };
    const record = Object.freeze({
      recordId: `business-${this.records.length + 1}`,
      ownerUserId: input.ownerUserId,
      idempotencyKey: input.idempotencyKey,
      structuredValueDigest: fingerprint(input.structuredValue),
      committedAt: this.now()
    });
    this.records.push(record);
    return { committed: true, recordId: record.recordId, replayed: false };
  }
}
