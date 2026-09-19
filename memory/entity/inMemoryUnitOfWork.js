import {
  EntityFoundationError,
  assertOwnerUserId,
  cloneFoundationState,
  immutableCopy
} from './inMemoryFoundationState.js';

export class InMemoryMemoryUnitOfWork {
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
    if (idempotencyKey !== undefined && idempotencyKey !== null && (
      typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0
    )) {
      throw new EntityFoundationError('IDEMPOTENCY_KEY_INVALID', 'idempotencyKey must be a non-empty string.');
    }
    const replayKey = idempotencyKey === undefined || idempotencyKey === null
      ? null
      : JSON.stringify([ownerUserId, idempotencyKey]);
    if (replayKey && this.holder.state.unitOfWorkIdempotency.has(replayKey)) {
      return immutableCopy(this.holder.state.unitOfWorkIdempotency.get(replayKey));
    }

    const baseState = this.holder.state;
    const draftHolder = { state: cloneFoundationState(baseState) };
    const repositories = this.buildRepositories(draftHolder, ownerUserId);
    const result = await work(repositories);
    if (this.holder.state !== baseState) {
      throw new EntityFoundationError('UNIT_OF_WORK_CONFLICT', 'Foundation changed while Unit of Work was running.');
    }
    if (replayKey) draftHolder.state.unitOfWorkIdempotency.set(replayKey, immutableCopy(result));
    this.holder.state = draftHolder.state;
    return immutableCopy(result);
  }
}
