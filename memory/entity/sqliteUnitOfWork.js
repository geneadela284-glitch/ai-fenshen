import crypto from 'node:crypto';

import {
  EntityFoundationError,
  assertOwnerUserId,
  immutableCopy
} from './inMemoryFoundationState.js';
import {
  assertConnectionAccess,
  decodeResult,
  encodeResult
} from './sqliteFoundationState.js';

export class SQLiteMemoryUnitOfWork {
  constructor(holder, buildRepositories) {
    this.holder = holder;
    this.buildRepositories = buildRepositories;
    this.tail = Promise.resolve();
  }

  run(context, work) {
    const operation = () => this.#run(context, work);
    const scheduled = this.tail.then(operation, operation);
    this.tail = scheduled.catch(() => undefined);
    return scheduled;
  }

  async #run(context, work) {
    const ownerUserId = context?.ownerUserId;
    assertOwnerUserId(ownerUserId);
    if (typeof work !== 'function') {
      throw new EntityFoundationError('UNIT_OF_WORK_CALLBACK_REQUIRED', 'Unit of Work callback is required.');
    }
    const idempotencyKey = context?.idempotencyKey;
    if (idempotencyKey !== undefined && idempotencyKey !== null &&
      (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0)) {
      throw new EntityFoundationError('IDEMPOTENCY_KEY_INVALID', 'idempotencyKey must be a non-empty string.');
    }
    assertConnectionAccess(this.holder);
    const receipt = idempotencyKey == null ? null : this.holder.db.prepare(`
      SELECT result_json FROM entity_uow_receipts WHERE owner_user_id = ? AND idempotency_key = ?
    `).get(ownerUserId, idempotencyKey);
    if (receipt) return decodeResult(receipt.result_json);

    const token = crypto.randomUUID();
    this.holder.db.exec('BEGIN IMMEDIATE');
    this.holder.activeTransactionToken = token;
    try {
      const inside = idempotencyKey == null ? null : this.holder.db.prepare(`
        SELECT result_json FROM entity_uow_receipts WHERE owner_user_id = ? AND idempotency_key = ?
      `).get(ownerUserId, idempotencyKey);
      if (inside) {
        this.holder.db.exec('COMMIT');
        return decodeResult(inside.result_json);
      }
      const result = await work(this.buildRepositories(this.holder, ownerUserId, token));
      if (idempotencyKey != null) {
        this.holder.db.prepare(`
          INSERT INTO entity_uow_receipts (owner_user_id, idempotency_key, result_json)
          VALUES (?, ?, ?)
        `).run(ownerUserId, idempotencyKey, encodeResult(result));
      }
      this.holder.db.exec('COMMIT');
      return immutableCopy(result);
    } catch (error) {
      try { this.holder.db.exec('ROLLBACK'); } catch (rollbackError) {
        const recovery = new EntityFoundationError('UNIT_OF_WORK_RECOVERY_REQUIRED', 'SQLite rollback could not be confirmed.');
        recovery.cause = rollbackError;
        throw recovery;
      }
      throw error;
    } finally {
      this.holder.activeTransactionToken = null;
    }
  }
}
