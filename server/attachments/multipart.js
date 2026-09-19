import { attachmentError } from './contract.js';

const CRLF = Buffer.from('\r\n');
const HEADER_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_FIELD_BYTES = 8 * 1024;

function boundaryFromContentType(contentType) {
  const match = String(contentType || '').match(
    /^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i
  );
  const boundary = match?.[1] || match?.[2] || '';
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw attachmentError('UPLOAD_FAILED');
  }
  return boundary;
}

function disposition(headers) {
  const line = headers.split('\r\n').find((item) =>
    item.toLowerCase().startsWith('content-disposition:')
  );
  if (!line || !/^\s*content-disposition:\s*form-data\b/i.test(line)) {
    throw attachmentError('UPLOAD_FAILED');
  }
  const name = line.match(/;\s*name="([^"]*)"/i)?.[1] || '';
  const filenameMatch = line.match(/;\s*filename="([^"]*)"/i);
  if (!name) throw attachmentError('UPLOAD_FAILED');
  return {
    name,
    filename: filenameMatch ? filenameMatch[1] : null
  };
}

function mimeType(headers) {
  const line = headers.split('\r\n').find((item) =>
    item.toLowerCase().startsWith('content-type:')
  );
  return line ? line.slice(line.indexOf(':') + 1).trim().toLowerCase() : '';
}

function appendPart(part, bytes, limits) {
  if (!bytes.length) return;
  part.size += bytes.length;
  const maximum = part.filename === null ? MAX_FIELD_BYTES : limits.maxFileBytes;
  if (part.size > maximum) {
    throw attachmentError(
      part.filename === null ? 'UPLOAD_FAILED' : 'FILE_TOO_LARGE',
      { status: part.filename === null ? 400 : 413 }
    );
  }
  part.chunks.push(bytes);
}

function finalizePart(part, result) {
  const value = Buffer.concat(part.chunks, part.size);
  if (part.filename === null) {
    if (!Object.hasOwn(result.fields, part.name)) {
      result.fields[part.name] = value.toString('utf8');
    }
    return;
  }
  result.files.push({
    name: part.filename,
    type: part.type,
    buffer: value
  });
}

export async function parseMultipartUpload(req, {
  contentType,
  maxRequestBytes,
  limits
} = {}) {
  const boundary = boundaryFromContentType(contentType);
  const firstBoundary = Buffer.from(`--${boundary}\r\n`);
  const nextBoundary = Buffer.from(`\r\n--${boundary}`);
  const result = { files: [], fields: {}, totalBytes: 0 };
  let pending = Buffer.alloc(0);
  let state = 'start';
  let part = null;
  let ended = false;

  function consume() {
    while (true) {
      if (state === 'start') {
        if (pending.length < firstBoundary.length) return;
        if (!pending.subarray(0, firstBoundary.length).equals(firstBoundary)) {
          throw attachmentError('UPLOAD_FAILED');
        }
        pending = pending.subarray(firstBoundary.length);
        state = 'headers';
      }
      if (state === 'headers') {
        const end = pending.indexOf(HEADER_END);
        if (end === -1) {
          if (pending.length > MAX_HEADER_BYTES) throw attachmentError('UPLOAD_FAILED');
          return;
        }
        const headers = pending.subarray(0, end).toString('utf8');
        pending = pending.subarray(end + HEADER_END.length);
        const identity = disposition(headers);
        if (identity.filename !== null &&
            !['file', 'files', 'attachments'].includes(identity.name)) {
          throw attachmentError('UPLOAD_FAILED');
        }
        if (identity.filename !== null && result.files.length >= limits.maxAttachmentsPerMessage) {
          throw attachmentError('TOO_MANY_ATTACHMENTS');
        }
        part = {
          ...identity,
          type: mimeType(headers),
          chunks: [],
          size: 0
        };
        state = 'body';
      }
      if (state === 'body') {
        const boundaryIndex = pending.indexOf(nextBoundary);
        if (boundaryIndex === -1) {
          const keep = nextBoundary.length + 4;
          if (pending.length > keep) {
            appendPart(part, pending.subarray(0, pending.length - keep), limits);
            pending = pending.subarray(pending.length - keep);
          }
          return;
        }
        appendPart(part, pending.subarray(0, boundaryIndex), limits);
        finalizePart(part, result);
        part = null;
        pending = pending.subarray(boundaryIndex + nextBoundary.length);
        if (pending.length < 2) {
          state = 'boundary-tail';
          return;
        }
        if (pending.subarray(0, 2).equals(Buffer.from('--'))) {
          pending = pending.subarray(2);
          ended = true;
          state = 'end';
          return;
        }
        if (!pending.subarray(0, 2).equals(CRLF)) throw attachmentError('UPLOAD_FAILED');
        pending = pending.subarray(2);
        state = 'headers';
      }
      if (state === 'boundary-tail') {
        if (pending.length < 2) return;
        if (pending.subarray(0, 2).equals(Buffer.from('--'))) {
          pending = pending.subarray(2);
          ended = true;
          state = 'end';
          return;
        }
        if (!pending.subarray(0, 2).equals(CRLF)) throw attachmentError('UPLOAD_FAILED');
        pending = pending.subarray(2);
        state = 'headers';
      }
      if (state === 'end') return;
    }
  }

  for await (const chunk of req) {
    result.totalBytes += chunk.length;
    if (result.totalBytes > maxRequestBytes) {
      throw attachmentError('FILE_TOO_LARGE', { status: 413 });
    }
    pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
    consume();
  }
  consume();
  if (!ended || result.files.length === 0) {
    throw attachmentError(result.files.length === 0 ? 'FILE_EMPTY' : 'UPLOAD_FAILED');
  }
  return result;
}
