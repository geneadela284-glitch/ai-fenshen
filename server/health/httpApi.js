import { randomUUID, createHash } from 'node:crypto';
import { foods, recipes, exercises, exerciseNotice } from '../../core/health/catalog.js';
import { recipeDetails, shoppingList, nutritionFor } from '../../core/health/nutrition.js';
import { allowedRecipes, healthConstraint } from '../../core/health/constraints.js';
import { draftPlan, changePlan, validatePlan, dateKey, assertNoRecentPain, planningFingerprint } from './planner.js';
import { importReport, confirmReport, publicRecord } from './reports.js';
import { localDateKey } from '../tasks/time.js';
const identityKeys = new Set(['userId', 'user_id', 'owner', 'ownerId', 'owner_id', 'accountId', 'account_id']);
const forged = value => value && typeof value === 'object' && Object.entries(value).some(([key, item]) => identityKeys.has(key) || forged(item));
const inflight = new WeakMap();
function revision(record, value) {
  if (record.revision !== value) throw healthConstraint('HEALTH_REVISION_CONFLICT', '内容已被修改，请刷新后核对，当前输入仍保留。', 409);
}
function requireStorage(service, owner) {
  const profile = service.profile(owner);
  if (profile?.payload.consentStorage !== true) throw healthConstraint('HEALTH_CONSENT_REQUIRED', '请先在健康档案确认保存授权。');
  return profile;
}
function safeResponseError(error) {
  const code = error?.code || 'HEALTH_UNAVAILABLE';
  const messages = {
    HEALTH_REVISION_CONFLICT: '记录已被修改，请刷新核对后再保存。',
    HEALTH_NOT_FOUND: '记录不存在或已被删除。',
    HEALTH_CONSENT_REQUIRED: '请先在健康档案确认保存授权。',
    HEALTH_STORAGE_CONSENT_REQUIRED: '请先在健康档案确认保存授权。',
    HEALTH_IDEMPOTENCY_CONFLICT: '这次保存与先前请求不同，请核对后重新提交。'
  };
  return {
    ok: false,
    code,
    message: messages[code] || (/[\u4e00-\u9fff]/.test(error?.message || '') ? error.message : '操作未完成，请检查填写内容后重试。')
  };
}
export async function readHealthJson(req, reportUpload = false) {
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += Buffer.byteLength(chunk);
    if (length > (reportUpload ? 12 * 1024 * 1024 : 512 * 1024)) throw healthConstraint('HEALTH_INPUT_LIMIT', '提交内容过大，请缩小文件或记录。', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  } catch {
    throw healthConstraint('HEALTH_INPUT_INVALID', '提交内容格式无效。');
  }
}
export function healthSummary(service, owner, {
  from,
  to
}) {
  dateKey(from);
  dateKey(to);
  if (from > to) throw healthConstraint('HEALTH_DATE_INVALID', '开始日期不能晚于结束日期。');
  const actual = service.list(owner, {
    from,
    to
  }).filter(r => ['metric', 'meal', 'workout'].includes(r.kind));
  const meals = actual.filter(r => r.kind === 'meal'),
    workouts = actual.filter(r => r.kind === 'workout');
  const accounted = meals.filter(r => r.payload.items?.length),
    kcal = accounted.reduce((sum, r) => sum + (nutritionFor(r.payload.items)?.kcal || 0), 0);
  return {
    approxKcal: Math.round(kcal),
    accountedMeals: accounted.length,
    from,
    to,
    recordedDays: new Set(actual.map(r => r.occurredOn)).size,
    mealCount: meals.length,
    workoutCount: workouts.length,
    workoutMinutes: workouts.reduce((n, r) => n + r.payload.minutes, 0),
    metricCount: actual.filter(r => r.kind === 'metric' && r.payload.status === 'confirmed').length,
    notes: ['只统计已保存的实际记录；未记录不等于没有吃饭或运动。', ...(workouts.some(r => r.payload.feeling === 'pain') ? ['曾记录运动疼痛，请先核对适用运动。'] : [])]
  };
}
export async function handleHealthApi({
  req,
  res,
  url,
  user,
  subject,
  runtime,
  lifecycleRuntime,
  aiService,
  accessControl,
  sendJson
}) {
  if (url.pathname !== '/api/health' && !url.pathname.startsWith('/api/health/')) return false;
  if (!user?.id) {
    sendJson(res, 401, {
      ok: false,
      code: 'AUTH_REQUIRED',
      message: '请先登录。'
    });
    return true;
  }
  const rt = runtime || lifecycleRuntime;
  if (!rt?.service) {
    sendJson(res, 503, {
      ok: false,
      code: 'HEALTH_UNAVAILABLE',
      message: '健康功能暂未启用。'
    });
    return true;
  }
  const service = rt.service,
    owner = user.id,
    p = url.pathname,
    method = req.method;
  let lease = null;
  try {
    const input = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ? await readHealthJson(req, p === '/api/health/reports/import') : {};
    if (!input || typeof input !== 'object' || Array.isArray(input) || forged(input) || [...url.searchParams.keys()].some(k => identityKeys.has(k))) throw healthConstraint('HEALTH_FORGED_IDENTITY', '不能指定其他账号。', 403);
    if (!runtime && method !== 'GET' && method !== 'DELETE') throw healthConstraint('HEALTH_DISABLED', '健康功能已关闭，仍可查看、导出和删除已有资料。', 503);
    const result = value => sendJson(res, 200, {
      ok: true,
      ...value
    });
    if (p === '/api/health' && method === 'GET') result({
      enabled: !!runtime,
      profile: publicRecord(service.profile(owner)),
      records: service.list(owner).filter(r => r.kind !== 'profile').map(publicRecord)
    });else if (p === '/api/health' && method === 'DELETE') {
      if (input.confirmed !== true) throw healthConstraint('HEALTH_DELETE_CONFIRMATION_REQUIRED', '请先确认删除本人所有健康资料。');
      service.deleteAllForOwner(owner);
      result({});
    } else if (p === '/api/health/catalog' && method === 'GET') result({
      foods,
      recipes: recipes.map(r => recipeDetails(r)),
      exercises,
      exerciseNotice
    });else if (p === '/api/health/profile' && method === 'PUT') result({
      record: service.saveProfile(owner, {
        ...input,
        idempotencyKey: input.idempotencyKey || randomUUID()
      })
    });else if (p === '/api/health/export' && method === 'GET') result(service.export(owner));else if (p === '/api/health/recipes' && method === 'GET') result({
      recipes: allowedRecipes(service.profile(owner)?.payload || {}).map(r => recipeDetails(r, Number(url.searchParams.get('servings') || 1)))
    });else if (p === '/api/health/summary' && method === 'GET') result({
      summary: healthSummary(service, owner, {
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to')
      })
    });else if (p === '/api/health/records' && method === 'POST') {
      if (!['metric', 'meal', 'workout', 'reminder'].includes(input.kind)) throw healthConstraint('HEALTH_KIND_INVALID', '请使用对应资料的核对入口。');
      if (input.kind === 'meal' && input.payload?.items?.length) nutritionFor(input.payload.items);
      result({
        record: publicRecord(service.create(owner, input))
      });
    } else if (p === '/api/health/reports/import' && method === 'POST') {
      requireStorage(service, owner);
      result({
        record: publicRecord(await importReport({
          owner,
          input,
          service,
          clock: rt.clock
        }))
      });
    } else if (p === '/api/health/plans/draft' && method === 'POST') {
      const profile = requireStorage(service, owner);
      if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw healthConstraint('HEALTH_IDEMPOTENCY_REQUIRED', '请重新提交本次请求。');
      const today = localDateKey(rt.clock?.() || new Date(), 'Asia/Shanghai');
      if (dateKey(input.startDate) < today) throw healthConstraint('HEALTH_PLAN_PAST', '新计划从今天或未来日期开始。');
      const fingerprint = createHash('sha256').update(JSON.stringify({
        request: input.request || '',
        startDate: input.startDate,
        mode: input.mode || 'ai'
      })).digest('hex');
      const old = service.list(owner, {
        kind: 'plan'
      }).find(r => r.payload.requestKey === input.idempotencyKey);
      if (old) {
        if (old.payload.requestFingerprint !== fingerprint) throw healthConstraint('HEALTH_IDEMPOTENCY_CONFLICT', '这次请求与原来不同。', 409);
        result({
          record: publicRecord(old)
        });
      } else {
        let running = inflight.get(rt);
        if (!running) {
          running = new Set();
          inflight.set(rt, running);
        }
        const key = owner + ':' + input.idempotencyKey;
        if (running.has(key)) throw healthConstraint('HEALTH_PLAN_IN_PROGRESS', '本次计划正在生成，请稍后查看。', 409);
        running.add(key);
        try {
          if ((input.mode || 'ai') === 'ai' && accessControl) lease = accessControl.beginRequest({
            subject,
            requestId: `health-plan:${randomUUID()}`
          });
          const payload = await draftPlan({
            profile: profile.payload,
            profileRevision: profile.revision,
            startDate: input.startDate,
            mode: input.mode,
            request: input.request,
            aiService,
            invocation: {
              subject,
              requestLease: lease
            },
            records: service.list(owner)
          });
          const latest = requireStorage(service, owner);
          revision(latest, profile.revision);
          result({
            record: service.create(owner, {
              kind: 'plan',
              occurredOn: input.startDate,
              idempotencyKey: input.idempotencyKey,
              payload: {
                ...payload,
                requestKey: input.idempotencyKey,
                requestFingerprint: fingerprint
              }
            })
          });
        } finally {
          running.delete(key);
        }
      }
    } else {
      const match = p.match(/^\/api\/health\/(records|plans|reminders|reports)\/([^/]+)(?:\/(action|confirm|change|shopping|file))?$/);
      if (!match) throw healthConstraint('HEALTH_NOT_FOUND', '页面不存在。', 404);
      const [, group, rawId, action] = match,
        id = decodeURIComponent(rawId),
        old = service.get(owner, id);
      if (group !== 'records' && old.kind !== {
        plans: 'plan',
        reminders: 'reminder',
        reports: 'report'
      }[group]) throw healthConstraint('HEALTH_NOT_FOUND', '记录不存在。', 404);
      if (group === 'records' && !action) {
        if (method === 'GET') result({
          record: publicRecord(old)
        });else if (method === 'DELETE') {
          service.delete(owner, id, input);
          result({});
        } else if (method === 'PATCH') {
          if (['profile', 'plan', 'report'].includes(old.kind)) throw healthConstraint('HEALTH_CONFIRM_ROUTE_REQUIRED', '请使用资料核对或计划调整入口。');
          if (old.kind === 'meal' && input.payload?.items?.length) nutritionFor(input.payload.items);
          result({
            record: publicRecord(service.update(owner, id, input))
          });
        } else throw healthConstraint('METHOD_NOT_ALLOWED', '不支持此操作。', 405);
      } else if (group === 'reminders' && action === 'action' && method === 'POST') result({
        record: service.reminderAction(owner, id, input)
      });else if (group === 'reports' && action === 'confirm' && method === 'POST') result({
        record: publicRecord(confirmReport({
          service,
          owner,
          id,
          input
        }))
      });else if (group === 'reports' && action === 'file' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'inline; filename="health-report.pdf"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(Buffer.from(old.payload.dataBase64, 'base64'));
      } else if (group === 'plans' && action === 'shopping' && method === 'GET') result({
        items: shoppingList(old.payload, service.profile(owner)?.payload.pantry || [])
      });else if (group === 'plans' && action === 'confirm' && method === 'POST') {
        const profile = requireStorage(service, owner);
        revision(old, input.revision);
        if (old.payload.status !== 'draft') throw healthConstraint('HEALTH_PLAN_STATE', '此计划不再是待确认草案。', 409);
        if (old.payload.profileFingerprint ? planningFingerprint(profile.payload) !== old.payload.profileFingerprint : profile.revision !== old.payload.profileRevision) throw healthConstraint('HEALTH_PLAN_PROFILE_CHANGED', '档案已变化，请重新生成或调整计划后核对。', 409);
        assertNoRecentPain(service.list(owner), localDateKey(rt.clock?.() || new Date(), 'Asia/Shanghai'));
        validatePlan(old.payload, profile.payload);
        const record = rt.repository.transaction(() => {
          const previous = old.payload.previousPlanId ? service.get(owner, old.payload.previousPlanId) : null;
          if (previous && previous.revision !== old.payload.previousRevision) throw healthConstraint('HEALTH_PLAN_CHANGED', '原计划已变化，请重新调整。', 409);
          for (const active of service.list(owner, {
            kind: 'plan'
          }).filter(r => r.payload.status === 'active' && r.payload.days.some(d => old.payload.days.some(n => n.date === d.date)))) service.update(owner, active.id, {
            revision: active.revision,
            payload: {
              ...active.payload,
              status: 'superseded'
            },
            confirmed: true
          });
          return service.update(owner, id, {
            revision: old.revision,
            confirmed: true,
            payload: {
              ...old.payload,
              status: 'active'
            }
          });
        });
        result({
          record
        });
      } else if (group === 'plans' && action === 'change' && method === 'POST') {
        const profile = requireStorage(service, owner);
        revision(old, input.revision);
        if (!['active', 'draft'].includes(old.payload.status)) throw healthConstraint('HEALTH_PLAN_STATE', '请从当前计划发起调整。', 409);
        assertNoRecentPain(service.list(owner), localDateKey(rt.clock?.() || new Date(), 'Asia/Shanghai'));
        const payload = changePlan(old.payload, input, profile.payload, localDateKey(rt.clock?.() || new Date(), 'Asia/Shanghai'));
        delete payload.requestKey;
        delete payload.requestFingerprint;
        result({
          record: service.create(owner, {
            kind: 'plan',
            occurredOn: old.occurredOn,
            idempotencyKey: input.idempotencyKey,
            payload: {
              ...payload,
              profileRevision: profile.revision,
              profileFingerprint: planningFingerprint(profile.payload),
              previousPlanId: old.id,
              previousRevision: old.revision,
              versions: [...(old.payload.versions || []).slice(-19), {
                id: old.id,
                revision: old.revision
              }]
            }
          })
        });
      } else throw healthConstraint('METHOD_NOT_ALLOWED', '不支持此操作。', 405);
    }
  } catch (error) {
    sendJson(res, [400, 401, 403, 404, 405, 409, 413, 503].includes(error?.status) ? error.status : 503, safeResponseError(error));
  } finally {
    if (lease) try {
      accessControl.releaseRequest(lease);
    } catch {/* Keep original response. */}
  }
  return true;
}
