import crypto from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

import { attachmentError } from './contract.js';

function secureDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = openSync(directory, 'r');
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export class AttachmentStorage {
  constructor({ root } = {}) {
    if (!root || !path.isAbsolute(root)) {
      throw new TypeError('AttachmentStorage requires an absolute root.');
    }
    this.root = path.normalize(root);
    this.objectsRoot = path.join(this.root, 'objects');
    this.derivedRoot = path.join(this.root, 'derived');
    this.temporaryRoot = path.join(this.root, 'temporary');
    for (const directory of [this.root, this.objectsRoot, this.derivedRoot, this.temporaryRoot]) {
      secureDirectory(directory);
    }
  }

  resolveReference(reference) {
    const normalized = String(reference || '').replaceAll('\\', '/');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 });
    }
    const resolved = path.resolve(this.root, ...normalized.split('/'));
    if (!resolved.startsWith(`${this.root}${path.sep}`)) {
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 });
    }
    return resolved;
  }

  writeObject({ attachmentId, extension, buffer } = {}) {
    const safeId = String(attachmentId || '');
    if (!/^att_[0-9a-f-]{36}$/i.test(safeId) || !['jpg', 'png', 'webp'].includes(extension)) {
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 });
    }
    const shard = crypto.createHash('sha256').update(safeId).digest('hex').slice(0, 2);
    const directory = path.join(this.objectsRoot, shard);
    secureDirectory(directory);
    const reference = path.posix.join('objects', shard, `${safeId}.${extension}`);
    const destination = this.resolveReference(reference);
    const temporary = path.join(this.temporaryRoot, `${crypto.randomUUID()}.upload`);
    let descriptor;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, buffer);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(temporary, 0o600);
      renameSync(temporary, destination);
      chmodSync(destination, 0o600);
      fsyncDirectory(directory);
      return reference;
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      if (existsSync(temporary)) {
        try { unlinkSync(temporary); } catch {}
      }
      if (existsSync(destination)) {
        try { unlinkSync(destination); } catch {}
      }
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503, cause: error });
    }
  }

  writeDerived({ processingId, kind, value } = {}) {
    const safeProcessingId = String(processingId || '');
    const safeKind = String(kind || '');
    if (!/^proc_[0-9a-f-]{36}$/i.test(safeProcessingId) ||
        !/^[a-z0-9_-]{1,80}$/i.test(safeKind)) {
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 });
    }
    const directory = path.join(this.derivedRoot, safeProcessingId);
    secureDirectory(directory);
    const reference = path.posix.join('derived', safeProcessingId, `${safeKind}.json`);
    const destination = this.resolveReference(reference);
    const temporary = path.join(this.temporaryRoot, `${crypto.randomUUID()}.derived`);
    let descriptor;
    try {
      descriptor = openSync(temporary, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify(value));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(temporary, 0o600);
      renameSync(temporary, destination);
      chmodSync(destination, 0o600);
      fsyncDirectory(directory);
      return reference;
    } catch (error) {
      if (descriptor !== undefined) {
        try { closeSync(descriptor); } catch {}
      }
      if (existsSync(temporary)) {
        try { unlinkSync(temporary); } catch {}
      }
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503, cause: error });
    }
  }

  readJson(reference) {
    try {
      return JSON.parse(this.readObject(reference).toString('utf8'));
    } catch (error) {
      if (error?.code === 'ATTACHMENT_STORE_UNAVAILABLE') throw error;
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503, cause: error });
    }
  }

  readObject(reference) {
    try {
      const target = this.resolveReference(reference);
      if (!existsSync(target)) {
        throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503 });
      }
      return readFileSync(target);
    } catch (error) {
      if (error?.code === 'ATTACHMENT_STORE_UNAVAILABLE') throw error;
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503, cause: error });
    }
  }

  deleteReference(reference) {
    if (!reference) return false;
    try {
      const target = this.resolveReference(reference);
      if (!existsSync(target)) return false;
      unlinkSync(target);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      if (error?.code === 'ATTACHMENT_STORE_UNAVAILABLE') throw error;
      throw attachmentError('ATTACHMENT_STORE_UNAVAILABLE', { status: 503, cause: error });
    }
  }

  cleanupTemporaryFiles({ beforeMs }) {
    let cleaned = 0;
    for (const name of readdirSync(this.temporaryRoot)) {
      const candidate = path.join(this.temporaryRoot, name);
      const stat = statSync(candidate);
      if (stat.isFile() && stat.mtimeMs <= beforeMs) {
        unlinkSync(candidate);
        cleaned += 1;
      }
    }
    return cleaned;
  }
}
