const IDENTITY_FIELDS = new Set([
  'userId', 'user_id', 'ownerId', 'owner_id', 'accountId', 'account_id'
]);

function hasForgedIdentity(body) {
  return body && typeof body === 'object'
    && Object.keys(body).some((key) => IDENTITY_FIELDS.has(key));
}

function notFound(res, sendJson) {
  sendJson(res, 404, { ok: false, code: 'TASK_NOT_FOUND', message: '事项不存在。' });
}

function unavailable(res, sendJson) {
  sendJson(res, 503, {
    ok: false,
    state: 'error',
    code: 'TASKS_UNAVAILABLE',
    message: '事项暂时无法读取，请稍后重试。'
  });
}

export async function handleTasksApi({ req, res, url, user, runtime, readJson, sendJson }) {
  if (!url.pathname.startsWith('/api/tasks')) return false;
  if (!user) {
    sendJson(res, 401, { ok: false, code: 'AUTH_REQUIRED', message: '请先登录。' });
    return true;
  }
  if (!runtime?.service || !runtime?.repository) {
    unavailable(res, sendJson);
    return true;
  }
  try {
    if (url.pathname === '/api/tasks/today-tomorrow' && req.method === 'GET') {
      const result = runtime.service.todayTomorrow(user.id, {
        timezone: url.searchParams.get('timezone')
      });
      sendJson(res, 200, { ok: true, ...result });
      return true;
    }

    if (url.pathname === '/api/tasks' && req.method === 'GET') {
      const tasks = runtime.service.listRange(user.id, {
        start: url.searchParams.get('start'),
        end: url.searchParams.get('end')
      });
      sendJson(res, 200, {
        ok: true,
        state: tasks.length ? 'ready' : 'empty',
        tasks
      });
      return true;
    }

    if (url.pathname === '/api/tasks' && req.method === 'POST') {
      const body = await readJson(req);
      if (hasForgedIdentity(body)) {
        sendJson(res, 403, {
          ok: false,
          code: 'TASKS_FORGED_IDENTITY',
          message: '不能指定其他账号。'
        });
        return true;
      }
      const task = runtime.service.create(user.id, body);
      sendJson(res, 201, { ok: true, task });
      return true;
    }

    const actionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(complete|restore)$/);
    if (actionMatch && req.method === 'POST') {
      const body = await readJson(req);
      if (hasForgedIdentity(body)) {
        sendJson(res, 403, {
          ok: false,
          code: 'TASKS_FORGED_IDENTITY',
          message: '不能指定其他账号。'
        });
        return true;
      }
      const id = decodeURIComponent(actionMatch[1]);
      const task = actionMatch[2] === 'complete'
        ? runtime.service.complete(user.id, id)
        : runtime.service.restore(user.id, id);
      if (!task) notFound(res, sendJson);
      else sendJson(res, 200, { ok: true, task });
      return true;
    }

    const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (!taskMatch) return false;
    const id = decodeURIComponent(taskMatch[1]);
    if (req.method === 'PATCH') {
      const body = await readJson(req);
      if (hasForgedIdentity(body)) {
        sendJson(res, 403, {
          ok: false,
          code: 'TASKS_FORGED_IDENTITY',
          message: '不能指定其他账号。'
        });
        return true;
      }
      const task = runtime.service.update(user.id, id, body);
      if (!task) notFound(res, sendJson);
      else sendJson(res, 200, { ok: true, task });
      return true;
    }
    if (req.method === 'DELETE') {
      const removed = runtime.service.delete(user.id, id);
      if (!removed) notFound(res, sendJson);
      else sendJson(res, 200, { ok: true });
      return true;
    }
    return false;
  } catch (error) {
    if (error?.status === 400) {
      sendJson(res, 400, {
        ok: false,
        code: error.code || 'TASK_INVALID',
        message: '事项数据无效。'
      });
      return true;
    }
    unavailable(res, sendJson);
    return true;
  }
}
