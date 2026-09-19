import { assertTimezone, groupTodayTomorrow } from './time.js';

const STATUSES = new Set(['pending', 'completed', 'cancelled']);

function validationError(code) {
  return Object.assign(new Error(code), { code, status: 400 });
}

function title(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 200) throw validationError('TASK_TITLE_INVALID');
  return normalized;
}

function description(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (normalized.length > 2000) throw validationError('TASK_DESCRIPTION_INVALID');
  return normalized || null;
}

function scheduledAt(value) {
  const instant = new Date(value);
  if (!value || !Number.isFinite(instant.getTime())) throw validationError('TASK_SCHEDULE_INVALID');
  return instant.toISOString();
}

function timezone(value) {
  try {
    return assertTimezone(value);
  } catch {
    throw validationError('TASK_TIMEZONE_INVALID');
  }
}

function status(value) {
  const normalized = String(value || '');
  if (!STATUSES.has(normalized)) throw validationError('TASK_STATUS_INVALID');
  return normalized;
}

function requiredOwner(value) {
  const owner = String(value || '').trim();
  if (!owner) throw Object.assign(new Error('TASK_USER_REQUIRED'), { code: 'TASK_USER_REQUIRED' });
  return owner;
}

export class TasksService {
  constructor({ repository, clock = () => new Date() } = {}) {
    this.repository = repository;
    this.clock = clock;
  }

  create(userId, input = {}, options = {}) {
    const normalizedStatus = input.status === undefined ? 'pending' : status(input.status);
    return this.repository.createForOwner(requiredOwner(userId), {
      title: title(input.title),
      description: description(input.description),
      scheduledAt: scheduledAt(input.scheduledAt),
      timezone: timezone(input.timezone),
      status: normalizedStatus,
      completedAt: normalizedStatus === 'completed' ? this.clock().toISOString() : null
    }, options);
  }

  listRange(userId, { start, end } = {}) {
    const rangeStart = scheduledAt(start);
    const rangeEnd = scheduledAt(end);
    if (rangeStart >= rangeEnd) throw validationError('TASK_RANGE_INVALID');
    return this.repository.listRangeForOwner(requiredOwner(userId), rangeStart, rangeEnd);
  }

  todayTomorrow(userId, { timezone: requestedTimezone } = {}) {
    const owner = requiredOwner(userId);
    const zone = timezone(requestedTimezone);
    const now = this.clock();
    const start = new Date(now.getTime() - (48 * 60 * 60 * 1000)).toISOString();
    const end = new Date(now.getTime() + (96 * 60 * 60 * 1000)).toISOString();
    const tasks = this.repository.listRangeForOwner(owner, start, end);
    return groupTodayTomorrow(tasks, { timezone: zone, now });
  }

  update(userId, id, patch = {}) {
    const owner = requiredOwner(userId);
    const current = this.repository.getForOwner(owner, id);
    if (!current) return null;
    const nextStatus = patch.status === undefined ? current.status : status(patch.status);
    let completedAt = current.completedAt;
    if (nextStatus === 'completed' && current.status !== 'completed') completedAt = this.clock().toISOString();
    if (nextStatus !== 'completed') completedAt = null;
    return this.repository.updateForOwner(owner, id, {
      title: patch.title === undefined ? current.title : title(patch.title),
      description: patch.description === undefined ? current.description : description(patch.description),
      scheduledAt: patch.scheduledAt === undefined ? current.scheduledAt : scheduledAt(patch.scheduledAt),
      timezone: patch.timezone === undefined ? current.timezone : timezone(patch.timezone),
      status: nextStatus,
      completedAt
    });
  }

  complete(userId, id) {
    return this.update(userId, id, { status: 'completed' });
  }

  restore(userId, id) {
    return this.update(userId, id, { status: 'pending' });
  }

  delete(userId, id) {
    return this.repository.deleteForOwner(requiredOwner(userId), id);
  }
}
