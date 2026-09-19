function safeError(res, sendJson, error) {
  const code = String(error?.code || 'PRIVACY_SERVICE_UNAVAILABLE');
  const status = code === 'PRIVACY_CONSENT_REQUIRED' ? 403
    : code === 'EXPORT_NOT_FOUND' || code === 'DELETION_REQUEST_NOT_FOUND' ? 404
      : code === 'EXPORT_GONE' || code === 'DELETION_REQUEST_EXPIRED' ? 410
        : ['EXPLICIT_CONSENT_REQUIRED', 'PRIVACY_VERSION_MISMATCH', 'CONSENT_SOURCE_REQUIRED'].includes(code) ? 400
          : 503;
  const messages = {
    PRIVACY_CONSENT_REQUIRED: '请先阅读并明确同意当前隐私说明。',
    EXPORT_NOT_FOUND: '导出文件不存在。',
    EXPORT_GONE: '下载链接已失效。',
    DELETION_REQUEST_NOT_FOUND: '删除确认请求不存在。',
    DELETION_REQUEST_EXPIRED: '删除确认已过期，请重新发起。',
    DELETION_NOT_COMPLETED: '账号删除尚未完成，请联系测试管理员。'
  };
  sendJson(res, status, { ok: false, code, message: messages[code] || '隐私服务暂时不可用。' });
}

export async function handlePrivacyApi({
  req,
  res,
  url,
  session,
  lifecycle,
  readJson,
  sendJson
}) {
  if (!url.pathname.startsWith('/api/privacy/')) return false;
  if (url.pathname === '/api/privacy/notice' && req.method === 'GET') {
    sendJson(res, 200, lifecycle.notice());
    return true;
  }
  if (!session?.user) {
    sendJson(res, 401, { ok: false, message: '请先登录。' });
    return true;
  }
  const ownerId = session.user.id;
  try {
    if (url.pathname === '/api/privacy/consent' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, consent: lifecycle.consent(ownerId), notice: lifecycle.notice() });
      return true;
    }
    if (url.pathname === '/api/privacy/consent' && req.method === 'POST') {
      const body = await readJson(req);
      const consent = lifecycle.acceptConsent({
        ownerId,
        accepted: body.accepted,
        privacyNoticeVersion: body.privacyNoticeVersion,
        termsVersion: body.termsVersion,
        locale: body.locale,
        source: body.source
      });
      sendJson(res, 200, { ok: true, consent });
      return true;
    }
    if (url.pathname === '/api/privacy/consent/withdraw' && req.method === 'POST') {
      const body = await readJson(req);
      sendJson(res, 200, {
        ok: true,
        consent: lifecycle.withdrawConsent({ ownerId, source: body.source || 'settings' })
      });
      return true;
    }
    if (url.pathname === '/api/privacy/exports' && req.method === 'POST') {
      sendJson(res, 201, { ok: true, ...lifecycle.createExport(ownerId) });
      return true;
    }
    const download = url.pathname.match(/^\/api\/privacy\/exports\/download\/([^/]+)$/);
    if (download && req.method === 'GET') {
      const result = lifecycle.consumeExport(ownerId, decodeURIComponent(download[1]));
      res.writeHead(200, {
        'Content-Type': 'application/json;charset=utf-8',
        'Content-Length': String(result.buffer.length),
        'Content-Disposition': `attachment; filename="${result.filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      res.end(result.buffer);
      return true;
    }
    if (url.pathname === '/api/privacy/deletion-requests' && req.method === 'POST') {
      sendJson(res, 201, { ok: true, ...lifecycle.initiateDeletion(ownerId) });
      return true;
    }
    if (url.pathname === '/api/privacy/deletion-requests/confirm' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.confirmation !== 'DELETE_MY_ACCOUNT') {
        sendJson(res, 400, { ok: false, code: 'DELETION_CONFIRMATION_REQUIRED', message: '请再次明确确认删除。' });
        return true;
      }
      const receipt = lifecycle.executeDeletion({
        ownerId,
        confirmationToken: body.confirmationToken
      });
      sendJson(res, 200, { ok: true, ...receipt });
      return true;
    }
  } catch (error) {
    safeError(res, sendJson, error);
    return true;
  }
  sendJson(res, 404, { ok: false, message: 'Not found' });
  return true;
}

export function sendConsentRequired(res, sendJson) {
  sendJson(res, 403, {
    ok: false,
    code: 'PRIVACY_CONSENT_REQUIRED',
    message: '请先阅读并明确同意当前隐私说明。'
  });
}
