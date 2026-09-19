import { nutritionFor } from '../../core/health/nutrition.js';
import { randomUUID } from 'node:crypto';
import { healthError } from './repository.js';
import { assertTimezone, addCalendarDays, localDateKey } from '../tasks/time.js';
const KINDS = new Set(['profile', 'metric', 'meal', 'workout', 'report', 'reminder', 'plan']);
const PLAN_STATUSES = new Set(['draft', 'active', 'superseded', 'paused']);
const MAX_RECORD_BYTES = 1_000_000;
const MAX_REPORT_BYTES = 12 * 1024 * 1024;
const MAX_VERSIONS = 20;
function ownerId(value) {
  if (typeof value !== 'string' || !value.trim()) throw healthError('AUTH_REQUIRED', 401);
  return value.trim();
}
function requiredText(value, max, code, {
  empty = false
} = {}) {
  if (typeof value !== 'string' || !empty && !value.trim() || value.length > max) throw healthError(code);
  return value;
}
function dateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw healthError('HEALTH_DATE_INVALID');
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw healthError('HEALTH_DATE_INVALID');
  }
  return value;
}
function instant(value, code = 'HEALTH_INSTANT_INVALID') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw healthError(code);
  }
  dateKey(value.slice(0, 10));
  const time = value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!time || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] || 0) > 59) throw healthError(code);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw healthError(code);
  return parsed.toISOString();
}
function timezone(value) {
  try {
    return assertTimezone(value);
  } catch {
    throw healthError('HEALTH_TIMEZONE_INVALID');
  }
}
function integer(value, min, max, code) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw healthError(code);
  return value;
}
function optionalStrings(value, code, maxItems = 100) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems || value.some(item => typeof item !== 'string' || item.length > 200)) {
    throw healthError(code);
  }
  return [...value];
}
function profilePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw healthError('HEALTH_PROFILE_INVALID');
  if (value.subject !== 'self') throw healthError('HEALTH_SUBJECT_INVALID');
  if (typeof value.consentStorage !== 'boolean') throw healthError('HEALTH_STORAGE_CONSENT_INVALID');
  if (typeof value.consentAI !== 'boolean') throw healthError('HEALTH_AI_CONSENT_INVALID');
  const result = {
    subject: 'self',
    consentStorage: value.consentStorage,
    consentAI: value.consentAI
  };
  if (value.goal !== undefined) {
    if (!['health', 'fitness', 'muscle', 'weight'].includes(value.goal)) throw healthError('HEALTH_GOAL_INVALID');
    result.goal = value.goal;
  }
  if (value.experience !== undefined) {
    if (!['beginner', 'regular'].includes(value.experience)) throw healthError('HEALTH_EXPERIENCE_INVALID');
    result.experience = value.experience;
  }
  for (const [key, min, max] of [['daysPerWeek', 1, 7], ['minutesPerSession', 5, 120], ['servings', 1, 8], ['cookingMinutes', 5, 120]]) {
    if (value[key] !== undefined) result[key] = integer(value[key], min, max, `HEALTH_${key.toUpperCase()}_INVALID`);
  }
  for (const key of ['equipment', 'allergies', 'dislikes', 'favorites', 'pantry']) {
    const normalized = optionalStrings(value[key], `HEALTH_${key.toUpperCase()}_INVALID`);
    if (normalized !== undefined) result[key] = normalized;
  }
  if (value.restrictions !== undefined) result.restrictions = requiredText(value.restrictions, 2000, 'HEALTH_RESTRICTIONS_INVALID', {
    empty: true
  });
  for (const key of ['adult', 'pregnant', 'medicalDiet']) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== 'boolean') throw healthError(`HEALTH_${key.toUpperCase()}_INVALID`);
      result[key] = value[key];
    }
  }
  return result;
}
function metricPayload(value) {
  if (!value || typeof value !== 'object') throw healthError('HEALTH_METRIC_INVALID');
  if (!['weight', 'bloodPressure', 'glucose', 'temperature'].includes(value.type)) throw healthError('HEALTH_METRIC_TYPE_INVALID');
  if (!Number.isFinite(value.value) || value.value <= 0) throw healthError('HEALTH_METRIC_VALUE_INVALID');
  if (value.secondaryValue !== undefined && (!Number.isFinite(value.secondaryValue) || value.secondaryValue <= 0)) throw healthError('HEALTH_METRIC_VALUE_INVALID');
  const units = {
    weight: ['kg', 'jin'],
    bloodPressure: ['mmHg'],
    glucose: ['mmol/L', 'mg/dL'],
    temperature: ['°C', '°F']
  };
  if (!units[value.type].includes(value.unit) && !(value.status === 'draft' && (value.unit === '' || value.unit === undefined))) throw healthError('HEALTH_METRIC_UNIT_INVALID');
  if (value.type === 'bloodPressure') {
    if (!Number.isFinite(value.secondaryValue) || value.value > 400 || value.secondaryValue > 400 || value.value <= value.secondaryValue) {
      throw healthError('HEALTH_BLOOD_PRESSURE_INVALID');
    }
  }
  if (!['confirmed', 'draft'].includes(value.status)) throw healthError('HEALTH_METRIC_STATUS_INVALID');
  if (value.type === 'glucose' && value.status === 'confirmed' && !['fasting', 'afterMeal', 'random'].includes(value.context)) {
    throw healthError('HEALTH_GLUCOSE_CONTEXT_REQUIRED');
  }
  const result = {
    ...value,
    measuredAt: instant(value.measuredAt, 'HEALTH_MEASURED_AT_INVALID')
  };
  requiredText(value.context ?? '', 200, 'HEALTH_METRIC_CONTEXT_INVALID', {
    empty: value.status === 'draft'
  });
  if (value.note !== undefined) requiredText(value.note, 5000, 'HEALTH_NOTE_INVALID', {
    empty: true
  });
  if (value.source !== undefined) {
    if (!value.source || !['manual', 'conversation'].includes(value.source.kind)) throw healthError('HEALTH_SOURCE_INVALID');
    if (value.source.text !== undefined) requiredText(value.source.text, 5000, 'HEALTH_SOURCE_INVALID', {
      empty: true
    });
    result.source = {
      ...value.source
    };
  }
  return result;
}
function mealPayload(value) {
  if (!value || typeof value !== 'object') throw healthError('HEALTH_MEAL_INVALID');
  requiredText(value.name, 300, 'HEALTH_MEAL_NAME_INVALID');
  if (!['breakfast', 'lunch', 'dinner', 'snack'].includes(value.meal)) throw healthError('HEALTH_MEAL_SLOT_INVALID');
  if (value.items !== undefined) {
    nutritionFor(value.items);
    if (!Array.isArray(value.items) || value.items.length > 100 || value.items.some(item => !item || typeof item.foodId !== 'string' || !Number.isFinite(item.grams) || item.grams <= 0)) throw healthError('HEALTH_MEAL_ITEMS_INVALID');
  }
  if (value.servings !== undefined && (!Number.isFinite(value.servings) || value.servings <= 0 || value.servings > 100)) throw healthError('HEALTH_MEAL_SERVINGS_INVALID');
  return structuredClone(value);
}
function workoutPayload(value) {
  if (!value || typeof value !== 'object') throw healthError('HEALTH_WORKOUT_INVALID');
  requiredText(value.name, 300, 'HEALTH_WORKOUT_NAME_INVALID');
  integer(value.minutes, 1, 300, 'HEALTH_WORKOUT_MINUTES_INVALID');
  if (!['comfortable', 'tired', 'pain', 'unrecorded'].includes(value.feeling)) throw healthError('HEALTH_WORKOUT_FEELING_INVALID');
  optionalStrings(value.exerciseIds, 'HEALTH_EXERCISES_INVALID');
  return structuredClone(value);
}
function reportPayload(value) {
  if (!value || typeof value !== 'object') throw healthError('HEALTH_REPORT_INVALID');
  const filename = requiredText(value.filename, 300, 'HEALTH_REPORT_FILE_INVALID');
  if (!filename.toLocaleLowerCase().endsWith('.pdf')) throw healthError('HEALTH_REPORT_FILE_INVALID');
  if (typeof value.dataBase64 !== 'string' || value.dataBase64.length > Math.ceil(MAX_REPORT_BYTES * 4 / 3) + 4) throw healthError('HEALTH_REPORT_TOO_LARGE');
  let decoded;
  try {
    decoded = Buffer.from(value.dataBase64, 'base64');
  } catch {
    throw healthError('HEALTH_REPORT_FILE_INVALID');
  }
  if (decoded.length > MAX_REPORT_BYTES) throw healthError('HEALTH_REPORT_TOO_LARGE');
  if (!['review', 'unrecognized', 'archived'].includes(value.status)) throw healthError('HEALTH_REPORT_STATUS_INVALID');
  if (!Array.isArray(value.pages) || value.pages.length > 200 || !Array.isArray(value.items) || value.items.length > 1000) throw healthError('HEALTH_REPORT_CONTENT_INVALID');
  return structuredClone(value);
}
function reminderPayload(value) {
  if (!value || typeof value !== 'object') throw healthError('HEALTH_REMINDER_INVALID');
  requiredText(value.title, 300, 'HEALTH_REMINDER_TITLE_INVALID');
  const scheduledAt = instant(value.scheduledAt, 'HEALTH_SCHEDULE_INVALID');
  const zone = timezone(value.timezone);
  if (!['none', 'weekly'].includes(value.repeat)) throw healthError('HEALTH_REPEAT_INVALID');
  if (!['pending', 'completed', 'cancelled'].includes(value.status)) throw healthError('HEALTH_REMINDER_STATUS_INVALID');
  if (value.history !== undefined && (!Array.isArray(value.history) || value.history.length > 500)) throw healthError('HEALTH_REMINDER_HISTORY_INVALID');
  return {
    ...structuredClone(value),
    history: structuredClone(value.history || []),
    scheduledAt,
    timezone: zone
  };
}
function planPayload(value) {
  if (!value || typeof value !== 'object') throw healthError('HEALTH_PLAN_INVALID');
  if (!PLAN_STATUSES.has(value.status)) throw healthError('HEALTH_PLAN_STATUS_INVALID');
  dateKey(value.startDate);
  if (!Array.isArray(value.days) || value.days.length > 60 || !Array.isArray(value.basis) || value.basis.length > 100) throw healthError('HEALTH_PLAN_CONTENT_INVALID');
  if (!['ai', 'rules'].includes(value.mode)) throw healthError('HEALTH_PLAN_MODE_INVALID');
  if (value.versions !== undefined && (!Array.isArray(value.versions) || value.versions.length > MAX_VERSIONS)) throw healthError('HEALTH_PLAN_VERSIONS_INVALID');
  const result = structuredClone(value);
  result.versions ||= [];
  return result;
}
function normalizePayload(kind, payload) {
  const normalizers = {
    profile: profilePayload,
    metric: metricPayload,
    meal: mealPayload,
    workout: workoutPayload,
    report: reportPayload,
    reminder: reminderPayload,
    plan: planPayload
  };
  const result = normalizers[kind](payload);
  if (kind !== 'report' && Buffer.byteLength(JSON.stringify(result)) > MAX_RECORD_BYTES) throw healthError('HEALTH_RECORD_TOO_LARGE');
  return result;
}
function checkRevision(record, revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw healthError('HEALTH_REVISION_REQUIRED');
  if (record.revision !== revision) throw healthError('HEALTH_REVISION_CONFLICT', 409);
}
function withoutReportFile(record) {
  if (record.kind !== 'report') return structuredClone(record);
  const copy = structuredClone(record);
  delete copy.payload.dataBase64;
  return copy;
}
function localParts(value, zone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
}
function localInstant(parts, zone) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  let result = desired;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const observed = localParts(result, zone);
    const difference = desired - Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    if (!difference) return new Date(result).toISOString();
    result += difference;
  }
  throw healthError('HEALTH_TIME_AMBIGUOUS');
}
export class HealthService {
  constructor({
    repository,
    tasksService,
    clock = () => new Date()
  } = {}) {
    this.repository = repository;
    this.tasksService = tasksService;
    this.clock = clock;
  }
  current(owner, id) {
    const record = this.repository.getForOwner(owner, id);
    if (!record) throw healthError('HEALTH_NOT_FOUND', 404);
    if (record.kind === 'reminder') {
      const taskIds = this.repository.taskLinks(owner, id);
      const task = taskIds.length ? this.tasksService.repository.getForOwner(owner, taskIds.at(-1)) : null;
      record.payload.status = task?.status || 'cancelled';
      if (task) {
        record.payload.scheduledAt = task.scheduledAt;
        record.payload.timezone = task.timezone;
      }
    }
    return record;
  }
  get(owner, id) {
    return this.current(ownerId(owner), id);
  }
  list(owner, options = {}) {
    owner = ownerId(owner);
    const query = {};
    if (options.kind !== undefined) {
      if (!KINDS.has(options.kind)) throw healthError('HEALTH_KIND_INVALID');
      query.kind = options.kind;
    }
    if (options.from !== undefined) query.from = dateKey(options.from);
    if (options.to !== undefined) query.to = dateKey(options.to);
    if (query.from && query.to && query.from > query.to) throw healthError('HEALTH_RANGE_INVALID');
    return this.repository.listForOwner(owner, query).map(record => withoutReportFile(this.current(owner, record.id)));
  }
  profile(owner) {
    return this.repository.listForOwner(ownerId(owner), {
      kind: 'profile'
    })[0] || null;
  }
  saveProfile(owner, input = {}) {
    owner = ownerId(owner);
    const payload = profilePayload(input.payload);
    const key = requiredText(input.idempotencyKey, 200, 'HEALTH_IDEMPOTENCY_REQUIRED');
    return this.repository.transaction(() => {
      const current = this.profile(owner);
      const normalized = {
        kind: 'profile',
        occurredOn: localDateKey(this.clock(), 'UTC'),
        payload
      };
      const hash = this.repository.contentHash(normalized);
      const request = this.repository.request(owner, key);
      if (request) return this.resolveRetry(owner, request, hash);
      const now = this.clock().toISOString();
      let record;
      if (current) {
        checkRevision(current, input.revision);
        record = {
          ...current,
          payload,
          revision: current.revision + 1,
          updatedAt: now
        };
        this.repository.update(owner, record, current.revision);
      } else {
        record = {
          id: `health_${randomUUID()}`,
          ...normalized,
          revision: 1,
          createdAt: now,
          updatedAt: now
        };
        this.repository.insert(owner, record);
      }
      this.repository.saveRequest(owner, key, hash, record.id);
      if (!payload.consentStorage) this.stopReminders(owner);
      return record;
    });
  }
  requireStorageConsent(owner) {
    if (this.profile(owner)?.payload.consentStorage !== true) throw healthError('HEALTH_STORAGE_CONSENT_REQUIRED', 403);
  }
  resolveRetry(owner, request, hash) {
    if (request.content_hash !== hash) throw healthError('HEALTH_IDEMPOTENCY_CONFLICT', 409);
    const record = this.repository.getForOwner(owner, request.health_id);
    if (!record) throw healthError('HEALTH_IDEMPOTENCY_DELETED', 409);
    return record;
  }
  create(owner, input = {}) {
    owner = ownerId(owner);
    if (!KINDS.has(input.kind) || input.kind === 'profile') throw healthError('HEALTH_KIND_INVALID');
    this.requireStorageConsent(owner);
    const key = requiredText(input.idempotencyKey, 200, 'HEALTH_IDEMPOTENCY_REQUIRED');
    const occurredOn = dateKey(input.occurredOn);
    const payload = normalizePayload(input.kind, input.payload);
    if (input.kind === 'reminder' && payload.history.length) throw healthError('HEALTH_REMINDER_HISTORY_INVALID');
    if (input.kind === 'reminder' && payload.status !== 'pending') throw healthError('HEALTH_REMINDER_CREATE_STATUS_INVALID');
    if (input.kind === 'plan' && payload.status === 'active') throw healthError('HEALTH_PLAN_CONFIRMATION_REQUIRED');
    if (input.kind === 'report' && payload.status === 'archived') throw healthError('HEALTH_REPORT_ARCHIVE_CONFIRMATION_REQUIRED');
    const normalized = {
      kind: input.kind,
      occurredOn,
      payload
    };
    const hash = this.repository.contentHash(normalized);
    return this.repository.transaction(() => {
      const request = this.repository.request(owner, key);
      if (request) return this.resolveRetry(owner, request, hash);
      const now = this.clock().toISOString();
      const record = {
        id: `health_${randomUUID()}`,
        ...normalized,
        revision: 1,
        createdAt: now,
        updatedAt: now
      };
      if (record.kind === 'reminder') this.createReminderTask(owner, record, `health:${record.id}:initial`);
      this.repository.insert(owner, record);
      this.repository.saveRequest(owner, key, hash, record.id);
      return record;
    });
  }
  createReminderTask(owner, record, idempotencyKey) {
    const task = this.tasksService.create(owner, {
      title: '有一项健康提醒',
      description: null,
      scheduledAt: record.payload.scheduledAt,
      timezone: record.payload.timezone,
      status: 'pending'
    }, {
      idempotencyKey
    });
    this.repository.linkTask(owner, record.id, task.id);
    return task;
  }
  update(owner, id, input = {}) {
    owner = ownerId(owner);
    this.requireStorageConsent(owner);
    return this.repository.transaction(() => {
      const current = this.current(owner, id);
      checkRevision(current, input.revision);
      if (current.kind === 'reminder') throw healthError('HEALTH_REMINDER_ACTION_REQUIRED');
      const payload = normalizePayload(current.kind, input.payload);
      if (current.kind === 'plan' && payload.status === 'active' && input.confirmed !== true) throw healthError('HEALTH_PLAN_CONFIRMATION_REQUIRED');
      if (current.kind === 'report' && payload.status === 'archived' && input.confirmed !== true) throw healthError('HEALTH_REPORT_ARCHIVE_CONFIRMATION_REQUIRED');
      if (current.kind === 'plan') {
        const snapshot = structuredClone(current.payload);
        delete snapshot.versions;
        payload.versions = [...(payload.versions || []), {
          revision: current.revision,
          payload: snapshot
        }].slice(-MAX_VERSIONS);
      }
      const record = {
        ...current,
        occurredOn: input.occurredOn === undefined ? current.occurredOn : dateKey(input.occurredOn),
        payload,
        revision: current.revision + 1,
        updatedAt: this.clock().toISOString()
      };
      return this.repository.update(owner, record, current.revision);
    });
  }
  delete(owner, id, input = {}) {
    owner = ownerId(owner);
    if (input.confirmed !== true) throw healthError('HEALTH_DELETE_CONFIRMATION_REQUIRED');
    return this.repository.transaction(() => {
      const record = this.current(owner, id);
      checkRevision(record, input.revision);
      if (record.kind === 'reminder') {
        for (const taskId of this.repository.taskLinks(owner, id)) this.tasksService.update(owner, taskId, {
          status: 'cancelled'
        });
      }
      return this.repository.delete(owner, record);
    });
  }
  reminderAction(owner, id, input = {}) {
    owner = ownerId(owner);
    this.requireStorageConsent(owner);
    return this.repository.transaction(() => {
      const current = this.current(owner, id);
      checkRevision(current, input.revision);
      if (current.kind !== 'reminder' || current.payload.status !== 'pending') throw healthError('HEALTH_REMINDER_NOT_PENDING', 409);
      const taskId = this.repository.taskLinks(owner, id).at(-1);
      let payload = structuredClone(current.payload);
      if (input.action === 'snooze') {
        const scheduledAt = instant(input.scheduledAt, 'HEALTH_SCHEDULE_INVALID');
        if (Date.parse(scheduledAt) <= this.clock().getTime()) throw healthError('HEALTH_SNOOZE_NOT_FUTURE');
        this.tasksService.update(owner, taskId, {
          scheduledAt,
          status: 'pending'
        });
        payload.scheduledAt = scheduledAt;
      } else if (input.action === 'cancel') {
        this.tasksService.update(owner, taskId, {
          status: 'cancelled'
        });
        payload.status = 'cancelled';
      } else if (input.action === 'complete') {
        this.tasksService.complete(owner, taskId);
        payload.history = [...payload.history, {
          action: 'completed',
          occurredAt: this.clock().toISOString(),
          scheduledAt: payload.scheduledAt
        }].slice(-500);
        if (payload.repeat === 'weekly') {
          const parts = localParts(payload.scheduledAt, payload.timezone);
          let nextDate = addCalendarDays(`${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`, 7);
          let next;
          do {
            const [year, month, day] = nextDate.split('-').map(Number);
            next = localInstant({
              ...parts,
              year,
              month,
              day
            }, payload.timezone);
            nextDate = addCalendarDays(nextDate, 7);
          } while (Date.parse(next) <= this.clock().getTime());
          payload.scheduledAt = next;
          const pendingRecord = {
            ...current,
            payload
          };
          this.createReminderTask(owner, pendingRecord, `health:${id}:weekly:revision:${current.revision}`);
          payload.status = 'pending';
        } else payload.status = 'completed';
      } else throw healthError('HEALTH_REMINDER_ACTION_INVALID');
      const record = {
        ...current,
        payload,
        revision: current.revision + 1,
        updatedAt: this.clock().toISOString()
      };
      return this.repository.update(owner, record, current.revision);
    });
  }
  reminders(owner, {
    timezone: requestedZone = 'Asia/Shanghai'
  } = {}) {
    owner = ownerId(owner);
    const zone = timezone(requestedZone);
    const tomorrow = addCalendarDays(localDateKey(this.clock(), zone), 1);
    return this.repository.listForOwner(owner, {
      kind: 'reminder'
    }).map(record => this.current(owner, record.id)).filter(record => record.payload.status === 'pending' && localDateKey(record.payload.scheduledAt, zone) <= tomorrow).map(record => {
      const taskId = this.repository.taskLinks(owner, record.id).at(-1);
      const task = this.tasksService.repository.getForOwner(owner, taskId);
      return {
        ...task,
        title: '有一项健康提醒',
        description: null,
        source: 'health',
        healthId: record.id,
        healthRevision: record.revision
      };
    }).sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
  }
  stopReminders(owner) {
    for (const record of this.repository.listForOwner(owner, {
      kind: 'reminder'
    })) {
      for (const taskId of this.repository.taskLinks(owner, record.id)) {
        const task = this.tasksService.repository.getForOwner(owner, taskId);
        if (task?.status === 'pending') this.tasksService.update(owner, taskId, {
          status: 'cancelled'
        });
      }
    }
  }
  healthIdForTask(owner, taskId) {
    return this.repository.healthIdForTask(ownerId(owner), taskId);
  }
  export(owner) {
    owner = ownerId(owner);
    return {
      version: 'health-v1',
      exportedAt: this.clock().toISOString(),
      records: this.list(owner)
    };
  }
  deleteAllForOwner(owner) {
    owner = ownerId(owner);
    return this.repository.transaction(() => {
      const links = this.repository.database.prepare('SELECT task_id FROM health_task_links WHERE user_id = ?').all(owner);
      for (const link of links) this.tasksService.update(owner, link.task_id, {
        status: 'cancelled'
      });
      const removed = Number(this.repository.database.prepare('DELETE FROM health_records WHERE user_id = ?').run(owner).changes);
      for (const table of ['health_requests', 'health_audit', 'health_task_links']) {
        this.repository.database.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(owner);
      }
      return removed;
    });
  }
}
