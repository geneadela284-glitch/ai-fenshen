import {
  attachmentError
} from './contract.js';
import { parseMultipartUpload } from './multipart.js';
import { createImagePreview } from './imagePreview.js';

const PUBLIC_MESSAGES = Object.freeze({
  UPLOAD_FAILED: '附件上传失败，请重试。',
  UNSUPPORTED_FILE_TYPE: '当前只支持JPEG、PNG和WebP图片。',
  FILE_TOO_LARGE: '单个附件不能超过8 MiB。',
  TOO_MANY_ATTACHMENTS: '单条消息最多上传3个附件。',
  DAILY_UPLOAD_LIMIT_EXCEEDED: '今日附件上传额度已用完。',
  MIME_SIGNATURE_MISMATCH: '文件类型与实际内容不一致。',
  IMAGE_DIMENSION_LIMIT_EXCEEDED: '图片像素尺寸超过限制。',
  FILE_EMPTY: '不能上传空文件。',
  FILE_CORRUPT: '图片文件损坏或无法读取。',
  ATTACHMENT_NOT_FOUND: '附件不存在。',
  ATTACHMENT_FORBIDDEN: '无权访问该附件。',
  ATTACHMENT_EXPIRED: '附件已过期。',
  ATTACHMENT_DELETED: '附件已删除。',
  ATTACHMENT_STORE_UNAVAILABLE: '附件存储暂时不可用。',
  ATTACHMENT_FEATURE_DISABLED: '图片理解功能当前未开启。'
});

function errorStatus(error) {
  if (Number.isInteger(error?.status)) return error.status;
  if (error?.code === 'ATTACHMENT_STORE_UNAVAILABLE') return 503;
  if (error?.code === 'ACCOUNT_CONCURRENCY_LIMITED' ||
      error?.code === 'ACCOUNT_REQUEST_RATE_LIMITED') return 429;
  if (error?.code === 'ACCOUNT_ACCESS_DISABLED') return 403;
  if (error?.code === 'ACCOUNT_QUOTA_NOT_CONFIGURED' ||
      error?.code === 'ACCESS_CONTROL_UNAVAILABLE') return 503;
  return 400;
}

function sendError(res, sendJson, error) {
  const knownCode = String(error?.code || 'UPLOAD_FAILED');
  const code = Object.hasOwn(PUBLIC_MESSAGES, knownCode) ||
    knownCode.startsWith('ACCOUNT_') ||
    knownCode === 'ACCESS_CONTROL_UNAVAILABLE'
    ? knownCode
    : 'UPLOAD_FAILED';
  sendJson(res, errorStatus(error), {
    ok: false,
    code,
    message: PUBLIC_MESSAGES[code] || error?.publicMessage || '附件服务暂时不可用。'
  });
}

function clientRequestId(req) {
  const value = String(req.headers['x-client-request-id'] || '').trim();
  if (!value || value.length > 160) throw attachmentError('UPLOAD_FAILED');
  return value;
}

export async function handleAttachmentsApi({
  req,
  res,
  url,
  user,
  subject,
  accessControl,
  runtime,
  enabled = false,
  sendJson,
  createPreview = createImagePreview
} = {}) {
  if (!url.pathname.startsWith('/api/attachments')) return false;
  if (!user || !subject) {
    sendJson(res, 401, {
      ok: false,
      code: 'AUTH_REQUIRED',
      message: '请先登录。'
    });
    return true;
  }
  if (url.pathname === '/api/attachments/capabilities' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      enabled: enabled === true,
      supportedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      limits: {
        dailyUploadBytes: enabled === true && runtime?.service?.dailyUploadLimit?.(user.id) === Infinity
          ? null : Number(runtime?.limits?.dailyUploadBytes || 32 * 1024 * 1024),
        maxFileBytes: Number(runtime?.limits?.maxFileBytes || 8 * 1024 * 1024),
        maxAttachmentsPerMessage: Number(runtime?.limits?.maxAttachmentsPerMessage || 3)
      }
    });
    return true;
  }
  if (enabled !== true) {
    sendJson(res, 404, {
      ok: false,
      code: 'ATTACHMENT_FEATURE_DISABLED',
      message: PUBLIC_MESSAGES.ATTACHMENT_FEATURE_DISABLED
    });
    return true;
  }
  if (!runtime?.service || !runtime?.repository || !runtime?.storage) {
    sendError(res, sendJson, attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 }));
    return true;
  }
  if (url.pathname === '/api/attachments' && req.method === 'POST') {
    let lease = null;
    let requestId = '';
    try {
      requestId = clientRequestId(req);
      const replay = runtime.service.replay(user.id, requestId);
      if (replay) {
        sendJson(res, 200, { ok: true, ...replay });
        return true;
      }
      lease = accessControl.beginRequest({
        subject,
        requestId: `attachment:${requestId}`
      });
      const contentType = String(req.headers['content-type'] || '');
      const contentLength = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
        throw attachmentError('UPLOAD_FAILED');
      }
      const maxRequestBytes =
        runtime.limits.maxFileBytes * runtime.limits.maxAttachmentsPerMessage +
        runtime.limits.multipartOverheadBytes;
      if (contentLength > maxRequestBytes) {
        throw attachmentError('FILE_TOO_LARGE', { status: 413 });
      }
      const preflight = runtime.service.preflight(user.id, requestId, contentLength);
      const multipart = await parseMultipartUpload(req, {
        maxRequestBytes: Math.min(maxRequestBytes, preflight.maxReceiveBytes),
        contentType,
        limits: runtime.limits
      });
      const result = runtime.service.upload({
        userId: user.id,
        subject,
        clientRequestId: requestId,
        conversationId: String(multipart.fields.conversation_id || '').trim() || null,
        files: multipart.files,
        reservedBytes: contentLength
      });
      sendJson(res, result.replayed ? 200 : 201, { ok: true, ...result });
      return true;
    } catch (error) {
      sendError(res, sendJson, error);
      return true;
    } finally {
      if (lease) {
        try { accessControl.releaseRequest(lease); } catch {}
      }
    }
  }

  const contentMatch = url.pathname.match(/^\/api\/attachments\/([^/]+)\/content$/);
  if (contentMatch && req.method === 'GET') {
    try {
      const attachment = runtime.service.get(
        user.id,
        decodeURIComponent(contentMatch[1])
      );
      const original = runtime.storage.readObject(attachment.storageReference);
      const preview = url.searchParams.get('preview') === '1';
      const buffer = preview ? await createPreview(original) : original;
      res.writeHead(200, {
        'Content-Type': preview ? 'image/jpeg' : attachment.mimeType,
        'Content-Length': String(buffer.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox"
      });
      res.end(buffer);
      return true;
    } catch (error) {
      sendError(res, sendJson, error);
      return true;
    }
  }

  const match = url.pathname.match(/^\/api\/attachments\/([^/]+)$/);
  if (!match) {
    sendJson(res, 404, { ok: false, message: 'Not found' });
    return true;
  }
  const attachmentId = decodeURIComponent(match[1]);
  try {
    if (req.method === 'GET') {
      const attachment = runtime.service.get(user.id, attachmentId);
      sendJson(res, 200, {
        ok: true,
        attachment: {
          attachmentId: attachment.attachmentId,
          conversationId: attachment.conversationId,
          messageId: attachment.messageId,
          originalFilename: attachment.originalFilename,
          safeFilename: attachment.safeFilename,
          mimeType: attachment.mimeType,
          mediaKind: attachment.mediaKind,
          byteSize: attachment.byteSize,
          width: attachment.width,
          height: attachment.height,
          checksumSha256: attachment.checksumSha256,
          processingState: attachment.processingState,
          parserType: attachment.parserType,
          createdAt: attachment.createdAt,
          expiresAt: attachment.expiresAt,
          deletedAt: attachment.deletedAt
        }
      });
      return true;
    }
    if (req.method === 'DELETE') {
      runtime.service.delete(user.id, attachmentId);
      sendJson(res, 200, { ok: true, deleted: true });
      return true;
    }
  } catch (error) {
    sendError(res, sendJson, error);
    return true;
  }
  sendJson(res, 404, { ok: false, message: 'Not found' });
  return true;
}
