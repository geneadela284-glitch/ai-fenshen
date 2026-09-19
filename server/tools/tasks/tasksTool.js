import { localDateTimeToUtc } from '../../../core/trust/dateRangeResolver.js';
import { addCalendarDays, assertTimezone, localDateKey } from '../../tasks/time.js';

const ALLOWED_ARGUMENTS = new Set([
  'title', 'description', 'date', 'relative_day_offset', 'local_time'
]);
const OWNER_KEYS = new Set(['ownerId', 'owner_id', 'ownerUserId', 'owner_user_id', 'userId', 'user_id']);

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function validTime(value) {
  return value === null || value === undefined ||
    /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value));
}

function planSchema(plan) {
  const errors = [];
  if (plan?.domain !== 'tool' || plan?.tool !== 'tasks.create' || plan?.action !== 'create_task') {
    errors.push('tasks.plan: invalid');
  }
  const args = plan?.arguments;
  if (!plainObject(args) || Object.keys(args).some((key) => !ALLOWED_ARGUMENTS.has(key))) {
    errors.push('tasks.arguments: invalid');
  } else {
    if (!String(args.title || '').trim()) errors.push('tasks.title: required');
    const relative = args.relative_day_offset;
    const explicitDate = args.date;
    if (Number.isInteger(relative) === Boolean(explicitDate)) {
      errors.push('tasks.date: exactly one date source required');
    }
    if (Number.isInteger(relative) && Math.abs(relative) > 36600) {
      errors.push('tasks.relative_day_offset: invalid');
    }
    if (explicitDate && !validDateKey(explicitDate)) errors.push('tasks.date: invalid');
    if (!validTime(args.local_time)) errors.push('tasks.local_time: invalid');
    if (Object.keys(args).some((key) => OWNER_KEYS.has(key))) errors.push('tasks.owner: forbidden');
  }
  if (!Array.isArray(plan?.required_evidence) || plan.required_evidence.length !== 0) {
    errors.push('tasks.evidence: must be empty');
  }
  return { ok: errors.length === 0, errors };
}

function resultSchema(value) {
  return Boolean(
    value?.ok &&
    value.tool === 'tasks.create' &&
    value.action === 'create_task' &&
    value.data?.task?.id &&
    value.data.task.status === 'pending' &&
    typeof value.safe_user_message === 'string' &&
    value.safe_user_message
  );
}

function reject(code) {
  return { decision: 'REJECT', code };
}

function evaluateContract({ plan, ownerId, timezone, now = new Date(), clientRequestId } = {}) {
  const checked = planSchema(plan);
  if (!checked.ok) return reject('TASKS_PLAN_INVALID');
  const owner = String(ownerId || '').trim();
  const idempotencyKey = String(clientRequestId || '').trim();
  if (!owner) return reject('TASKS_OWNER_REQUIRED');
  if (!idempotencyKey) return reject('TASKS_IDEMPOTENCY_KEY_REQUIRED');
  let zone;
  try {
    zone = assertTimezone(timezone);
  } catch {
    return reject('TASKS_TIMEZONE_INVALID');
  }
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) return reject('TASKS_CURRENT_TIME_INVALID');
  const args = plan.arguments;
  const today = localDateKey(current, zone);
  const dateKey = args.date || addCalendarDays(today, args.relative_day_offset);
  const localTime = args.local_time || '09:00';
  const scheduledAt = localDateTimeToUtc(dateKey, zone, `${localTime}:00`);
  if (!Number.isFinite(scheduledAt.getTime())) return reject('TASKS_SCHEDULE_INVALID');
  return {
    decision: 'ACCEPT',
    input: {
      ownerId: owner,
      idempotencyKey,
      title: String(args.title).trim(),
      description: args.description === null || args.description === undefined
        ? null
        : String(args.description).trim() || null,
      scheduledAt: scheduledAt.toISOString(),
      timezone: zone,
      dateKey,
      today
    }
  };
}

export function createTasksTool({ service } = {}) {
  if (!service?.create) throw new TypeError('Tasks tool requires TasksService.');
  return Object.freeze({
    id: 'tasks.create',
    description: '仅在用户明确表达待办、安排或提醒意图时创建正式事项。提取简洁标题，并提供唯一日期来源：相对runtime_context.local_date的relative_day_offset或明确date；可选local_time。普通聊天、长期事实、偏好、财务和生日日期问题不得调用。',
    actions: ['create_task'],
    argumentSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: ['string', 'null'], maxLength: 2000 },
        date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        relative_day_offset: { type: ['integer', 'null'] },
        local_time: { type: ['string', 'null'], pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }
      },
      required: ['title']
    },
    evidenceSchema: {
      source: 'authenticated_conversation',
      required: ['source_message_id', 'client_request_id']
    },
    permissions: ['authenticated_session', 'owner_scoped_tasks_write'],
    planSchema,
    resultSchema,
    failureBehavior: 'fail_closed_without_task_write',
    contract: evaluateContract,
    execute(input) {
      const task = service.create(input.ownerId, {
        title: input.title,
        description: input.description,
        scheduledAt: input.scheduledAt,
        timezone: input.timezone,
        status: 'pending'
      }, { idempotencyKey: input.idempotencyKey });
      const offset = input.dateKey === input.today
        ? 0
        : input.dateKey === addCalendarDays(input.today, 1) ? 1 : null;
      const label = offset === 0 ? '今日' : offset === 1 ? '明日' : input.dateKey;
      return {
        ok: true,
        tool: 'tasks.create',
        action: 'create_task',
        data: { task },
        safe_user_message: `已加入${label}事项。`
      };
    }
  });
}
