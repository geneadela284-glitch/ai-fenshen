import { isAllowedCategory } from './constants.js';
import { getFinanceCapabilities } from './financeCapabilities.js';
import { buildFinanceQueryPlan } from './queryPlan.js';

function entryBody(entry) {
  return entry ? { ...entry } : null;
}

function listParameter(searchParams, name) {
  return searchParams.getAll(name).flatMap((value) => value.split(','))
    .map((value) => value.trim()).filter(Boolean);
}

function historyQueryFromUrl(url, runtime) {
  const search = url.searchParams;
  return {
    period: search.get('period') || (search.has('startAt') || search.has('endAt') ? 'custom' : 'all_time'),
    startAt: search.get('startAt'),
    endAt: search.get('endAt'),
    timezone: search.get('timezone') || runtime.timezone || 'Asia/Shanghai',
    now: runtime.clock?.() || new Date(),
    types: listParameter(search, 'types'),
    categories: listParameter(search, 'categories'),
    statuses: search.has('statuses') ? listParameter(search, 'statuses') : undefined,
    keyword: search.get('keyword'),
    limit: search.get('limit'),
    cursor: search.get('cursor')
  };
}

function idempotencyKey(req) {
  const value = req.headers['idempotency-key'];
  return String(Array.isArray(value) ? value[0] : value || '').trim();
}

function mutationInput(req, body) {
  return {
    expectedVersion: Number(body.expectedVersion),
    mutationRequestId: idempotencyKey(req)
  };
}

function sendFinanceError(error, res, sendJson) {
  const code = String(error?.code || '');
  if (code === 'FINANCE_VERSION_CONFLICT') {
    sendJson(res, 409, { ok: false, code, message: '账目已发生变化，请刷新后重试。' });
    return true;
  }
  if (code === 'FINANCE_IDEMPOTENCY_CONFLICT') {
    sendJson(res, 409, { ok: false, code, message: '请求唯一标识与首次请求内容不一致。' });
    return true;
  }
  if (['FINANCE_ENTRY_NOT_ACTIVE', 'FINANCE_MUTATION_REQUEST_INCOMPLETE'].includes(code)) {
    sendJson(res, 409, { ok: false, code, message: '账目当前状态不允许此操作。' });
    return true;
  }
  if (['FINANCE_EXPECTED_VERSION_REQUIRED', 'MUTATION_REQUEST_ID_REQUIRED'].includes(code)) {
    sendJson(res, 400, { ok: false, code, message: '缺少有效的版本或请求唯一标识。' });
    return true;
  }
  return false;
}

export async function handleFinanceApi({ req, res, url, user, runtime, privacyLifecycle = null, readJson, sendJson }) {
  if (!url.pathname.startsWith('/api/finance/')) return false;
  if (!user) {
    sendJson(res, 401, { ok: false, message: '请先登录。' });
    return true;
  }
  if (!runtime?.repository) {
    sendJson(res, 503, { ok: false, message: '暂时无法读取账本，请稍后再试。' });
    return true;
  }
  if (url.pathname === '/api/finance/reports/current-month' && req.method === 'GET') {
    const format = String(url.searchParams.get('format') || '').toLowerCase();
    if (!['pdf', 'xlsx'].includes(format)) {
      sendJson(res, 400, { ok: false, message: '报表格式无效。' });
      return true;
    }
    if (!runtime.reportService) {
      sendJson(res, 503, { ok: false, message: '报表暂时无法生成，请稍后再试。' });
      return true;
    }
    try {
      const result = await runtime.reportService.exportCurrentMonth({ ownerId: user.id, format });
      privacyLifecycle?.recordGeneratedReport?.({
        ownerId: user.id,
        reportType: result.snapshot.reportType,
        format,
        periodStart: result.snapshot.period.startAt,
        periodEnd: result.snapshot.period.endAt
      });
      const encodedFilename = encodeURIComponent(result.filename);
      res.writeHead(200, {
        'Content-Type': result.contentType,
        'Content-Length': String(result.buffer.length),
        'Content-Disposition': `attachment; filename="finance-report.${format}"; filename*=UTF-8''${encodedFilename}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(result.buffer);
    } catch {
      sendJson(res, 503, { ok: false, message: '报表暂时无法生成，请稍后再试。' });
    }
    return true;
  }
  try {
    if (url.pathname === '/api/finance/overview' && req.method === 'GET') {
      const plan = buildFinanceQueryPlan({
        metrics: ['income', 'expense'],
        periodExpression: '本月',
        timezone: runtime.timezone || 'Asia/Shanghai',
        now: runtime.clock?.() || new Date(),
        text: '本月收支情况'
      });
      const summary = runtime.repository.query(plan, { ownerId: user.id });
      sendJson(res, 200, { ok: true, summary: { incomeMinor: summary.incomeMinor, expenseMinor: summary.expenseMinor, balanceMinor: summary.balanceMinor, categories: summary.categories }, entries: runtime.repository.list({ ownerId: user.id, limit: 10 }).map(entryBody), capabilities: getFinanceCapabilities() });
      return true;
    }
    if (url.pathname === '/api/finance/entries' && req.method === 'GET') {
      if (runtime.repository.f201Enabled) {
        try {
          const result = runtime.repository.queryHistory({
            ownerId: user.id,
            ...historyQueryFromUrl(url, runtime)
          });
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          if (String(error?.code || '').startsWith('FINANCE_HISTORY_')) {
            sendJson(res, 400, { ok: false, message: '历史查询条件或游标无效。' });
            return true;
          }
          throw error;
        }
        return true;
      }
      sendJson(res, 200, { ok: true, entries: runtime.repository.list({ ownerId: user.id, limit: url.searchParams.get('limit') || 10 }).map(entryBody) });
      return true;
    }

    const revisionMatch = url.pathname.match(/^\/api\/finance\/entries\/([^/]+)\/revisions$/);
    if (revisionMatch && req.method === 'GET') {
      if (!runtime.repository.f201Enabled) return false;
      const revisions = runtime.repository.listRevisions({
        ownerId: user.id,
        entryId: decodeURIComponent(revisionMatch[1])
      });
      sendJson(res, revisions ? 200 : 404, revisions
        ? { ok: true, revisions }
        : { ok: false, message: '账目不存在。' });
      return true;
    }

    const actionMatch = url.pathname.match(/^\/api\/finance\/entries\/([^/]+)\/(restore|archive|unarchive)$/);
    if (actionMatch && req.method === 'POST') {
      if (!runtime.repository.f201Enabled) return false;
      const body = await readJson(req);
      const entry = runtime.repository[actionMatch[2]]({
        ownerId: user.id,
        id: decodeURIComponent(actionMatch[1]),
        ...mutationInput(req, body)
      });
      sendJson(res, entry ? 200 : 404, entry
        ? { ok: true, entry: entryBody(entry) }
        : { ok: false, message: '账目不存在。' });
      return true;
    }

    const match = url.pathname.match(/^\/api\/finance\/entries\/([^/]+)$/);
    if (!match) return false;
    const id = decodeURIComponent(match[1]);
    if (req.method === 'GET') {
      const entry = runtime.repository.get({ ownerId: user.id, id });
      sendJson(res, entry ? 200 : 404, entry ? { ok: true, entry: entryBody(entry) } : { ok: false, message: '账目不存在。' });
      return true;
    }
    if (req.method === 'PATCH') {
      const current = runtime.repository.get({ ownerId: user.id, id });
      if (!current) {
        sendJson(res, 404, { ok: false, message: '账目不存在。' });
        return true;
      }
      const body = await readJson(req);
      const patch = {};
      if (body.amountMinor !== undefined) {
        const amountMinor = Number(body.amountMinor);
        if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
          sendJson(res, 400, { ok: false, message: '金额无效。' });
          return true;
        }
        patch.amountMinor = amountMinor;
      }
      if (body.category !== undefined) {
        if (!isAllowedCategory(current.type, body.category)) {
          sendJson(res, 400, { ok: false, message: '分类无效。' });
          return true;
        }
        patch.category = body.category;
      }
      if (body.note !== undefined) patch.note = body.note;
      const entry = runtime.repository.update({
        ownerId: user.id,
        id,
        patch,
        ...(runtime.repository.f201Enabled ? mutationInput(req, body) : {})
      });
      sendJson(res, entry ? 200 : 404, entry
        ? { ok: true, entry: entryBody(entry) }
        : { ok: false, message: '账目不存在。' });
      return true;
    }
    if (req.method === 'DELETE') {
      if (runtime.repository.f201Enabled) {
        const body = await readJson(req);
        const entry = runtime.repository.softDelete({
          ownerId: user.id,
          id,
          ...mutationInput(req, body)
        });
        sendJson(res, entry ? 200 : 404, entry
          ? { ok: true, entry: entryBody(entry) }
          : { ok: false, message: '账目不存在。' });
        return true;
      }
      const removed = runtime.repository.softDelete({ ownerId: user.id, id });
      sendJson(res, removed ? 200 : 404, removed
        ? { ok: true }
        : { ok: false, message: '账目不存在。' });
      return true;
    }
    return false;
  } catch (error) {
    if (sendFinanceError(error, res, sendJson)) return true;
    sendJson(res, 503, { ok: false, message: '暂时无法读取账本，请稍后再试。' });
    return true;
  }
}
