const MIB = 1024 * 1024;

export const ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 8 * MIB,
  maxAttachmentsPerMessage: 3,
  dailyUploadBytes: 32 * MIB,
  maxImagePixels: 20_000_000,
  unboundTtlMs: 60 * 60 * 1000,
  multipartOverheadBytes: 64 * 1024
});

export const ATTACHMENT_STATES = Object.freeze({
  UPLOADING: 'uploading',
  UPLOADED: 'uploaded',
  VALIDATING: 'validating',
  READY: 'ready_for_processing',
  PROCESSING: 'processing',
  REJECTED: 'rejected',
  FAILED: 'failed',
  EXPIRED: 'expired',
  DELETED: 'deleted'
});

export const ATTACHMENT_PROCESSING_STATES = Object.freeze({
  READY: 'ready_for_processing',
  OCR: 'processing_ocr',
  VISION: 'processing_vision',
  MERGING: 'merging_evidence',
  PROCESSED: 'processed',
  PARTIAL: 'processed_partial',
  FAILED: 'processing_failed',
  EXPIRED: 'expired',
  DELETED: 'deleted'
});

export const ATTACHMENT_ERROR_CODES = Object.freeze([
  'UPLOAD_FAILED',
  'UNSUPPORTED_FILE_TYPE',
  'FILE_TOO_LARGE',
  'TOO_MANY_ATTACHMENTS',
  'DAILY_UPLOAD_LIMIT_EXCEEDED',
  'MIME_SIGNATURE_MISMATCH',
  'IMAGE_DIMENSION_LIMIT_EXCEEDED',
  'FILE_EMPTY',
  'FILE_CORRUPT',
  'ATTACHMENT_NOT_FOUND',
  'ATTACHMENT_FORBIDDEN',
  'ATTACHMENT_EXPIRED',
  'ATTACHMENT_DELETED',
  'ATTACHMENT_STORE_UNAVAILABLE',
  'ATTACHMENT_NOT_READY',
  'ATTACHMENT_PROCESSING_FAILED',
  'ATTACHMENT_PROCESSING_INTERRUPTED',
  'OCR_PROVIDER_UNAVAILABLE',
  'VISION_PROVIDER_UNAVAILABLE',
  'SENSITIVE_ATTACHMENT_PROCESSING_REFUSED',
  'ATTACHMENT_CAPABILITY_UNSUPPORTED'
]);

export class AttachmentError extends Error {
  constructor(code, {
    status = 400,
    message = code,
    cause
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'AttachmentError';
    this.code = code;
    this.status = status;
  }
}

export function attachmentError(code, options) {
  return new AttachmentError(code, options);
}

export function mergeAttachmentLimits(value = {}) {
  const result = {};
  for (const [key, fallback] of Object.entries(ATTACHMENT_LIMITS)) {
    const candidate = Number(value?.[key]);
    result[key] = Number.isSafeInteger(candidate) && candidate > 0 ? candidate : fallback;
  }
  return Object.freeze(result);
}

export function publicAttachment(row = null) {
  if (!row) return null;
  return {
    attachmentId: row.attachmentId,
    conversationId: row.conversationId || null,
    messageId: row.messageId || null,
    originalFilename: row.originalFilename,
    safeFilename: row.safeFilename,
    mimeType: row.mimeType,
    mediaKind: row.mediaKind,
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    checksumSha256: row.checksumSha256,
    processingState: row.processingState,
    parserType: row.parserType || null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt || null,
    deletedAt: row.deletedAt || null
  };
}
