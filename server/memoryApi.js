const CLIENT_IDENTITY_FIELDS = new Set([
  'userId', 'authenticatedUserId', 'actorId', 'accountId', 'ownerId', 'requestedUserId'
]);

function query(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function statusFor(result) {
  if (result?.status === 'disabled') return 503;
  if (result?.status === 'not_found') return 404;
  if (result?.status === 'failed') return 409;
  return 200;
}

export async function handleMemoryApi({ req, res, url, user, service, readJson, sendJson }) {
  if (!url.pathname.startsWith('/api/memory/')) return false;
  if (!user) {
    sendJson(res, 401, { ok: false, code: 'MEMORY_AUTH_REQUIRED', message: '请先登录。' });
    return true;
  }
  try {
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readJson(req) : {};
    if (Object.keys(body).some((field) => CLIENT_IDENTITY_FIELDS.has(field))) {
      sendJson(res, 403, { ok: false, code: 'MEMORY_AUTH_FORGED_IDENTITY', message: '无权限。' });
      return true;
    }
    let result;
    const memoryMatch = url.pathname.match(/^\/api\/memory\/memories\/([^/]+)(?:\/(history|correct|delete|restore|purge))?$/);
    if (url.pathname === '/api/memory/status' && req.method === 'GET') result = service.getStatus(user);
    else if (url.pathname === '/api/memory/conversation' && req.method === 'POST') result = await service.processConversation(user, body);
    else if (url.pathname === '/api/memory/confirm' && req.method === 'POST') result = await service.confirmCapture(user, body);
    else if (url.pathname === '/api/memory/memories' && req.method === 'GET') result = await service.listMemories(user, query(url));
    else if (memoryMatch && req.method === 'GET' && memoryMatch[2] === 'history') result = await service.getMemoryHistory(user, decodeURIComponent(memoryMatch[1]), query(url));
    else if (memoryMatch && req.method === 'GET' && !memoryMatch[2]) result = await service.getMemoryDetails(user, decodeURIComponent(memoryMatch[1]), query(url));
    else if (memoryMatch && req.method === 'POST' && memoryMatch[2] === 'correct') result = await service.correctMemory(user, decodeURIComponent(memoryMatch[1]), body);
    else if (memoryMatch && req.method === 'POST' && memoryMatch[2] === 'delete') result = await service.deleteMemory(user, decodeURIComponent(memoryMatch[1]), body);
    else if (memoryMatch && req.method === 'POST' && memoryMatch[2] === 'restore') result = await service.restoreMemory(user, decodeURIComponent(memoryMatch[1]), body);
    else if (memoryMatch && req.method === 'POST' && memoryMatch[2] === 'purge') result = await service.purgeMemory(user, decodeURIComponent(memoryMatch[1]), body);
    else if (url.pathname === '/api/memory/timeline' && req.method === 'GET') result = await service.getTimeline(user, query(url));
    else if (url.pathname === '/api/memory/intelligence' && req.method === 'GET') result = await service.getIntelligence(user, query(url));
    else {
      sendJson(res, 404, { ok: false, message: 'Not found' });
      return true;
    }
    sendJson(res, statusFor(result), { ok: statusFor(result) < 400, result });
  } catch (error) {
    const status = error?.code === 'MEMORY_AUTH_REQUIRED' ? 401 : error?.code === 'MEMORY_AUTH_FORGED_IDENTITY' ? 403 : 503;
    sendJson(res, status, {
      ok: false,
      code: error?.code || 'MEMORY_TEMPORARILY_UNAVAILABLE',
      message: status === 401 ? '请先登录。' : status === 403 ? '无权限。' : '记忆暂时不可用，其他功能仍可继续。'
    });
  }
  return true;
}
