const MAX_ATTACHMENTS = 3;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PIXELS = 20_000_000;
const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const HEIC_TYPES = new Set(['image/heic', 'image/heif']);
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx']);

const ERROR_MESSAGES = Object.freeze({
  DUPLICATE_ATTACHMENT: '这张图片已经在待发送队列中。',
  TOO_MANY_ATTACHMENTS: '每条消息最多选择3张图片。',
  UNSUPPORTED_FILE_TYPE: '当前只支持JPEG、PNG和WebP图片。',
  DOCUMENT_PHASE_NOT_AVAILABLE: 'PDF、Word、Excel将在后续文档阶段开放',
  FILE_TOO_LARGE: '单张图片不能超过8 MiB。',
  HEIC_CONVERSION_UNAVAILABLE: '此照片为HEIC/HEIF格式，当前浏览器无法安全转换为JPEG，请改用截图或JPEG照片。'
});

function codedError(code) {
  const error = new Error(ERROR_MESSAGES[code] || '图片无法加入待发送队列。');
  error.code = code;
  return error;
}

function fileExtension(name) {
  return String(name || '').split('.').pop()?.toLowerCase() || '';
}

function isHeic(file) {
  return HEIC_TYPES.has(String(file?.type || '').toLowerCase()) ||
    ['heic', 'heif'].includes(fileExtension(file?.name));
}

function signature(file) {
  return [
    String(file?.name || '').toLowerCase(),
    Number(file?.size || 0),
    Number(file?.lastModified || 0),
    String(file?.type || '').toLowerCase()
  ].join(':');
}

function imageElementDecode(file) {
  if (!globalThis.document?.createElement || !globalThis.URL?.createObjectURL) {
    return Promise.reject(codedError('HEIC_CONVERSION_UNAVAILABLE'));
  }
  const url = URL.createObjectURL(file);
  const image = document.createElement('img');
  image.decoding = 'async';
  return new Promise((resolve, reject) => {
    const cleanup = () => URL.revokeObjectURL(url);
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(codedError('HEIC_CONVERSION_UNAVAILABLE'));
    };
    image.src = url;
  });
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob?.size) resolve(blob);
      else reject(codedError('HEIC_CONVERSION_UNAVAILABLE'));
    }, 'image/jpeg', 0.9);
  });
}

export async function convertHeicInBrowser(file) {
  try {
    const image = await imageElementDecode(file);
    const sourceWidth = Number(image.naturalWidth || image.width);
    const sourceHeight = Number(image.naturalHeight || image.height);
    if (!sourceWidth || !sourceHeight) throw codedError('HEIC_CONVERSION_UNAVAILABLE');
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (sourceWidth * sourceHeight)));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw codedError('HEIC_CONVERSION_UNAVAILABLE');
    context.drawImage(image, 0, 0, width, height);
    const blob = await canvasBlob(canvas);
    const name = String(file.name || 'photo.heic').replace(/\.(heic|heif)$/i, '') || 'photo';
    return new File([blob], `${name}.jpg`, {
      type: 'image/jpeg',
      lastModified: Number(file.lastModified || Date.now())
    });
  } catch {
    throw codedError('HEIC_CONVERSION_UNAVAILABLE');
  }
}

export async function addSelectedImages(current = [], files = [], {
  convertHeic = convertHeicInBrowser,
  createObjectURL = (file) => URL.createObjectURL(file),
  idFactory = () => globalThis.crypto?.randomUUID?.() || `local_${Date.now()}_${Math.random()}`
} = {}) {
  const items = [...current];
  const errors = [];
  const signatures = new Set(items.map((item) => item.signature));
  for (const original of Array.from(files || [])) {
    const originalSignature = signature(original);
    if (signatures.has(originalSignature)) {
      errors.push(codedError('DUPLICATE_ATTACHMENT'));
      continue;
    }
    if (items.length >= MAX_ATTACHMENTS) {
      errors.push(codedError('TOO_MANY_ATTACHMENTS'));
      continue;
    }
    let selected = original;
    let convertedFromHeic = false;
    try {
      if (DOCUMENT_TYPES.has(String(original?.type || '').toLowerCase()) ||
          DOCUMENT_EXTENSIONS.has(fileExtension(original?.name))) {
        throw codedError('DOCUMENT_PHASE_NOT_AVAILABLE');
      }
      if (isHeic(original)) {
        selected = await convertHeic(original);
        convertedFromHeic = true;
      }
      if (!SUPPORTED_TYPES.has(String(selected?.type || '').toLowerCase())) {
        throw codedError('UNSUPPORTED_FILE_TYPE');
      }
      if (!Number.isSafeInteger(selected.size) || selected.size <= 0) {
        throw codedError('UNSUPPORTED_FILE_TYPE');
      }
      if (selected.size > MAX_FILE_BYTES) throw codedError('FILE_TOO_LARGE');
      const previewUrl = createObjectURL(selected);
      items.push({
        id: idFactory(selected),
        file: selected,
        name: selected.name,
        size: selected.size,
        mimeType: selected.type,
        signature: originalSignature,
        previewUrl,
        status: 'selected',
        convertedFromHeic,
        attachmentId: null,
        error: ''
      });
      signatures.add(originalSignature);
    } catch (error) {
      errors.push(error?.code ? error : codedError('UNSUPPORTED_FILE_TYPE'));
    }
  }
  return { items: items.length === current.length ? items : items.map(({ clientRequestId, ...item }) => item), errors };
}

export function removeSelectedImage(items = [], id, {
  revokeObjectURL = (url) => URL.revokeObjectURL(url)
} = {}) {
  const removed = items.find((item) => item.id === id);
  if (removed?.previewUrl?.startsWith?.('blob:')) revokeObjectURL(removed.previewUrl);
  if (!removed) return items;
  return items.filter((item) => item.id !== id).map(({ clientRequestId, ...item }) => item);
}

export function releaseAttachmentPreviews(items = [], {
  revokeObjectURL = (url) => URL.revokeObjectURL(url)
} = {}) {
  for (const item of items) {
    if (item?.previewUrl?.startsWith?.('blob:')) revokeObjectURL(item.previewUrl);
  }
}

export function attachmentSelectionErrorMessage(error) {
  return ERROR_MESSAGES[error?.code] || error?.message || '图片无法加入待发送队列。';
}
