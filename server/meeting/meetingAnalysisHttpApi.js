import { randomUUID } from 'node:crypto';
import { PUBLIC_MESSAGES } from '../access/accessErrors.js';

export const MEETING_ANALYSIS_PATH = '/api/meeting/analysis';
const MAX_INPUT_CHARS = 16 * 1024;
const MAX_MESSAGES = 4;
const MAX_MESSAGE_CHARS = 16 * 1024;
const SAFE_FAILURE_MESSAGE = '会议整理暂时不可用，请稍后重试。';
const SAFE_CODES = new Set([
  'ACCOUNT_ACCESS_DISABLED',
  'ACCOUNT_CONCURRENCY_LIMITED',
  'ACCOUNT_QUOTA_NOT_CONFIGURED',
  'ACCOUNT_REQUEST_RATE_LIMITED',
  'ACCOUNT_USAGE_LIMIT_REACHED',
  'ACCESS_CONTROL_UNAVAILABLE',
  'AUTH_REQUIRED',
  'MEETING_ANALYSIS_REQUEST_INVALID',
  'RATE_LIMITED',
  'TIMEOUT',
  'AI_ANALYSIS_UNAVAILABLE'
]);

function codedError(code, details = null) {
  const error = new Error(code);
  error.code = code;
  if (details !== null) error.details = details;
  return error;
}

function requiredString(value, code, maximum = MAX_INPUT_CHARS) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maximum) throw codedError(code);
  return normalized;
}

function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_MESSAGES) {
    throw codedError('MEETING_ANALYSIS_REQUEST_INVALID');
  }
  const messages = value.map((message) => {
    const role = String(message?.role || '').trim();
    if (!['system', 'user'].includes(role)) throw codedError('MEETING_ANALYSIS_REQUEST_INVALID');
    return Object.freeze({
      role,
      content: requiredString(message?.content, 'MEETING_ANALYSIS_REQUEST_INVALID', MAX_MESSAGE_CHARS)
    });
  });
  if (!messages.some((message) => message.role === 'user')) throw codedError('MEETING_ANALYSIS_REQUEST_INVALID');
  return Object.freeze(messages);
}

function clientRequestId(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > 160) throw codedError('MEETING_ANALYSIS_REQUEST_INVALID');
  return normalized;
}

function publicCode(error) {
  const code = String(error?.code || 'AI_ANALYSIS_UNAVAILABLE');
  return SAFE_CODES.has(code) ? code : 'AI_ANALYSIS_UNAVAILABLE';
}

function publicMessage(code) {
  if (PUBLIC_MESSAGES[code]) return PUBLIC_MESSAGES[code];
  if (code === 'AUTH_REQUIRED') return '请先登录。';
  if (code === 'RATE_LIMITED') return '请求过于频繁，请稍后再试。';
  if (code === 'TIMEOUT') return '会议整理超时，请稍后重试。';
  if (code === 'MEETING_ANALYSIS_REQUEST_INVALID') return '会议整理请求无效，请重新打开会议后重试。';
  return SAFE_FAILURE_MESSAGE;
}

function statusForCode(code, error = null) {
  if (Number.isInteger(error?.status)) return error.status;
  if (code === 'AUTH_REQUIRED') return 401;
  if (code === 'MEETING_ANALYSIS_REQUEST_INVALID') return 400;
  if (code === 'ACCOUNT_ACCESS_DISABLED') return 403;
  if (code === 'ACCOUNT_CONCURRENCY_LIMITED' || code === 'ACCOUNT_REQUEST_RATE_LIMITED' || code === 'RATE_LIMITED') return 429;
  return 503;
}

function sendFailure(res, sendJson, error) {
  const code = publicCode(error);
  sendJson(res, statusForCode(code, error), {
    ok: false,
    code,
    message: publicMessage(code)
  });
}

export async function handleMeetingAnalysisApi({
  req,
  res,
  url,
  session,
  aiService,
  accessControl,
  readJson,
  sendJson
} = {}) {
  if (url?.pathname !== MEETING_ANALYSIS_PATH) return false;
  if (!session?.user?.id || !session?.subject) {
    sendJson(res, 401, { ok: false, code: 'AUTH_REQUIRED', message: '请先登录。' });
    return true;
  }
  if (req?.method !== 'POST') {
    sendJson(res, 405, {
      ok: false,
      code: 'METHOD_NOT_ALLOWED',
      message: '请求方法不支持。'
    }, { Allow: 'POST' });
    return true;
  }
  if (typeof aiService?.run !== 'function' || typeof accessControl?.beginRequest !== 'function') {
    sendJson(res, 503, {
      ok: false,
      code: 'AI_ANALYSIS_UNAVAILABLE',
      message: SAFE_FAILURE_MESSAGE
    });
    return true;
  }

  let requestLease = null;
  try {
    const body = await readJson(req);
    // Read only the public request contract.  Client owner, scope, meeting and
    // revision claims are deliberately never forwarded to the AI service.
    const input = requiredString(body?.input, 'MEETING_ANALYSIS_REQUEST_INVALID');
    const messages = normalizeMessages(body?.messages);
    const idempotencyKey = clientRequestId(body?.clientRequestId);
    const requestId = `meeting-analysis:${randomUUID()}`;
    requestLease = accessControl.beginRequest({ subject: session.subject, requestId });
    const result = await aiService.run({
      input,
      messages,
      capability: 'MEETING_SUMMARY',
      metadata: {
        purpose: 'meeting_stage4_analysis',
        memoryPolicy: 'disabled',
        idempotencyKey
      },
      options: { timeoutMs: 90_000 }
    }, {
      subject: session.subject,
      requestLease,
      // Server-owned scope: public request fields cannot opt other AI calls in.
      meetingAnalysis: true
    });
    if (!result?.ok || !String(result.content || '').trim()) {
      throw codedError(result?.code || 'AI_ANALYSIS_UNAVAILABLE');
    }
    sendJson(res, 200, {
      ok: true,
      content: String(result.content)
    });
  } catch (error) {
    sendFailure(res, sendJson, error);
  } finally {
    if (requestLease) {
      try { accessControl.releaseRequest(requestLease); } catch { /* Keep the analysis response authoritative. */ }
    }
  }
  return true;
}
