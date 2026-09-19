import { createHash, randomUUID } from 'node:crypto';

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw Object.assign(new Error(code), { code });
  return normalized;
}

function publicTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description || null,
    scheduledAt: row.scheduled_at,
    timezone: row.timezone,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  };
}

export class TasksRepository {
  constructor({ database, clock = () => new Date(), id = () => `task_${randomUUID()}` } = {}) {
    this.database = database;
    this.clock = clock;
    this.id = id;
  }

  createForOwner(userId, input, { idempotencyKey = null } = {}) {
    const owner = required(userId, 'TASK_USER_REQUIRED');
    const idempotency = String(idempotencyKey || '').trim();
    const taskId = idempotency
      ? `task_${createHash('sha256').update(`${owner}\0${idempotency}`).digest('hex')}`
      : this.id();
    const existing = this.getForOwner(owner, taskId);
    if (existing) return existing;
    const now = this.clock().toISOString();
    const task = {
      id: taskId,
      userId: owner,
      title: input.title,
      description: input.description,
      scheduledAt: input.scheduledAt,
      timezone: input.timezone,
      status: input.status,
      createdAt: now,
      updatedAt: now,
      completedAt: input.completedAt
    };
    const result = this.database.prepare(`
      INSERT INTO tasks (
        id, user_id, title, description, scheduled_at, timezone, status,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.userId,
      task.title,
      task.description,
      task.scheduledAt,
      task.timezone,
      task.status,
      task.createdAt,
      task.updatedAt,
      task.completedAt
    );
    if (Number(result.changes) !== 1) throw Object.assign(new Error('TASK_CREATE_FAILED'), { code: 'TASK_CREATE_FAILED' });
    return this.getForOwner(owner, task.id);
  }

  getForOwner(userId, id) {
    const row = this.database.prepare(`
      SELECT * FROM tasks WHERE user_id = ? AND id = ?
    `).get(required(userId, 'TASK_USER_REQUIRED'), required(id, 'TASK_ID_REQUIRED'));
    return publicTask(row);
  }

  listRangeForOwner(userId, startAt, endAt) {
    return this.database.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ? AND scheduled_at >= ? AND scheduled_at < ?
      ORDER BY scheduled_at ASC, created_at ASC, id ASC
    `).all(
      required(userId, 'TASK_USER_REQUIRED'),
      required(startAt, 'TASK_RANGE_START_REQUIRED'),
      required(endAt, 'TASK_RANGE_END_REQUIRED')
    ).map(publicTask);
  }

  exportForOwner(userId) {
    return this.database.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ?
      ORDER BY scheduled_at ASC, created_at ASC, id ASC
    `).all(required(userId, 'TASK_USER_REQUIRED')).map(publicTask);
  }

  updateForOwner(userId, id, task) {
    const owner = required(userId, 'TASK_USER_REQUIRED');
    const taskId = required(id, 'TASK_ID_REQUIRED');
    const result = this.database.prepare(`
      UPDATE tasks SET
        title = ?,
        description = ?,
        scheduled_at = ?,
        timezone = ?,
        status = ?,
        updated_at = ?,
        completed_at = ?
      WHERE user_id = ? AND id = ?
    `).run(
      task.title,
      task.description,
      task.scheduledAt,
      task.timezone,
      task.status,
      this.clock().toISOString(),
      task.completedAt,
      owner,
      taskId
    );
    return Number(result.changes) === 1 ? this.getForOwner(owner, taskId) : null;
  }

  deleteForOwner(userId, id) {
    const result = this.database.prepare(
      'DELETE FROM tasks WHERE user_id = ? AND id = ?'
    ).run(required(userId, 'TASK_USER_REQUIRED'), required(id, 'TASK_ID_REQUIRED'));
    return Number(result.changes) === 1;
  }

  deleteAllForOwner(userId) {
    return Number(this.database.prepare(
      'DELETE FROM tasks WHERE user_id = ?'
    ).run(required(userId, 'TASK_USER_REQUIRED')).changes);
  }
}

export { publicTask };
