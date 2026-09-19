import crypto from 'node:crypto';
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

import { normalizePrivacyPolicy, publicPrivacyNotice } from './privacyPolicy.js';
import { PrivacyStore } from './privacyStore.js';

const EXPORT_SCHEMA_VERSION = 'closed-beta-user-export-v2';
const DELETION_SCOPE_VERSION = 'closed-beta-p0-b1-online-data-v2';
const TOMBSTONE_VERSION = 'backup-deletion-tombstone-v1';

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw Object.assign(new Error(code), { code });
  return normalized;
}

function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function durableJson(filePath, value) {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${crypto.randomUUID()}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    JSON.parse(readFileSync(temporary, 'utf8'));
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

function signature(secret, receipt) {
  return crypto.createHmac('sha256', secret).update([
    receipt.receiptId,
    receipt.subjectRef,
    receipt.completedAt,
    receipt.scopeVersion,
    receipt.tombstoneVersion,
    receipt.status
  ].join('\u0000')).digest('base64url');
}

function accountExport(account) {
  if (!account) return null;
  return {
    id: account.id,
    username: account.username,
    displayName: account.displayName,
    status: account.status,
    role: account.role,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    lastLoginAt: account.lastLoginAt || null
  };
}

export class PrivacyLifecycle {
  constructor({
    dbPath,
    exportDir,
    policy,
    secret,
    auth,
    accessControl,
    conversationRuntime,
    learningRuntime = null,
    protectedMemoryRuntime,
    financeRuntime,
    tasksRuntime,
    diaryRuntime,
    healthRuntime,
    attachmentRuntime,
    exportStorageGuard = null,
    privacyStoreFactory = (input) => new PrivacyStore(input),
    exportTtlMs = 10 * 60 * 1000,
    deletionTtlMs = 15 * 60 * 1000,
    cleanupIntervalMs = 60 * 1000,
    now = () => new Date().toISOString()
  } = {}) {
    this.policy = normalizePrivacyPolicy(policy);
    this.secret = required(secret, 'PRIVACY_SIGNING_SECRET_REQUIRED');
    this.exportDir = path.resolve(required(exportDir, 'PRIVACY_EXPORT_DIR_REQUIRED'));
    this.exportTtlMs = Math.max(1, Number(exportTtlMs) || 10 * 60 * 1000);
    this.deletionTtlMs = Math.max(1, Number(deletionTtlMs) || 15 * 60 * 1000);
    this.now = now;
    this.auth = auth;
    this.accessControl = accessControl;
    this.conversationRuntime = conversationRuntime;
    this.learningRuntime = learningRuntime;
    this.protectedMemoryRuntime = protectedMemoryRuntime;
    this.financeRuntime = financeRuntime;
    this.tasksRuntime = tasksRuntime;
    this.diaryRuntime = diaryRuntime;
    this.healthRuntime = healthRuntime;
    this.attachmentRuntime = attachmentRuntime;
    this.exportStorageGuard = typeof exportStorageGuard === 'function' ? exportStorageGuard : null;
    this.closeState = 'active';
    this.exportCleanupCompleted = false;
    this.exportFileBindings = new Map();
    this.cleanupTimer = null;
    this.store = null;
    try {
      if (this.exportStorageGuard) {
        this.assertExportStorage('initialize');
      } else {
        mkdirSync(this.exportDir, { recursive: true, mode: 0o700 });
        chmodSync(this.exportDir, 0o700);
      }
      this.exportDirRealpath = realpathSync(this.exportDir);
      this.store = privacyStoreFactory({ dbPath, policy: this.policy, now });
      if (!this.store || typeof this.store.initialize !== 'function' || typeof this.store.close !== 'function') {
        throw Object.assign(new Error('PrivacyStore factory returned an invalid resource.'), {
          code: 'PRIVACY_STORE_FACTORY_INVALID'
        });
      }
      this.store.initialize();
      this.databasePath = this.store.dbPath;
      this.rebuildExportFileBindings();
      this.cleanupExports();
    } catch (error) {
      try {
        this.store?.close();
      } catch (cleanupError) {
        error.cleanupCompleted = false;
        error.unprovenPartialInitialization = 'privacy';
        error.cleanupCodes = [
          ...(Array.isArray(error.cleanupCodes) ? error.cleanupCodes : []),
          `privacy:${String(cleanupError?.code || cleanupError?.message || 'FAILED')}`
        ];
      }
      throw error;
    }
    this.cleanupTimer = setInterval(() => {
      try { this.cleanupExports(); } catch {}
    }, Math.max(10, Number(cleanupIntervalMs) || 60 * 1000));
    this.cleanupTimer.unref?.();
  }

  close() {
    if (this.closeState === 'closed') return;
    if (this.closeState === 'closing') {
      throw Object.assign(new Error('Privacy close is already running.'), { code: 'PRIVACY_CLOSE_IN_PROGRESS' });
    }
    this.closeState = 'closing';
    clearInterval(this.cleanupTimer);
    let cleanupError = null;
    if (!this.exportCleanupCompleted) {
      try {
        this.cleanupExports();
        this.exportCleanupCompleted = true;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      this.closeState = 'cleanup_failed';
      throw Object.assign(new Error('Privacy close is incomplete and must be retried.'), {
        code: 'PRIVACY_CLOSE_INCOMPLETE',
        cleanupCompleted: false,
        cleanupCodes: [String(cleanupError?.code || cleanupError?.message || 'PRIVACY_EXPORT_CLEANUP_FAILED')],
        requiresIsolationRootDestruction: cleanupError?.requiresIsolationRootDestruction === true ||
          cleanupError?.code === 'PRIVACY_STORAGE_UNSAFE' ||
          cleanupError?.code === 'PRIVACY_EXPORT_FILE_UNSAFE',
        cause: cleanupError
      });
    }
    let closeError = null;
    try { this.store.close(); } catch (error) { closeError = error; }
    if (closeError) {
      this.closeState = 'cleanup_failed';
      throw Object.assign(new Error('Privacy close is incomplete and must be retried.'), {
        code: 'PRIVACY_CLOSE_INCOMPLETE',
        cleanupCompleted: false,
        cleanupCodes: [String(closeError?.code || closeError?.message || 'PRIVACY_STORE_CLOSE_FAILED')],
        cause: closeError
      });
    }
    this.closeState = 'closed';
  }

  closeStatus() {
    return Object.freeze({ state: this.closeState });
  }

  assertExportStorage(action) {
    if (!this.exportStorageGuard) return true;
    try {
      this.exportStorageGuard(action);
      return true;
    } catch (error) {
      if (error?.code === 'PRIVACY_STORAGE_UNSAFE') throw error;
      throw Object.assign(new Error('Privacy export storage is unsafe.'), {
        code: 'PRIVACY_STORAGE_UNSAFE',
        cause: error
      });
    }
  }

  assertExportFile(filePath, action) {
    this.assertExportStorage(action);
    const relative = path.relative(this.exportDir, path.resolve(filePath));
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw Object.assign(new Error('Privacy export file escaped its storage directory.'), {
        code: 'PRIVACY_STORAGE_UNSAFE'
      });
    }
  }

  bindExportFile(filePath, ownerId, persistedBinding = null) {
    this.assertExportStorage('export_bind');
    let stats;
    let canonical;
    try {
      stats = lstatSync(filePath);
      canonical = realpathSync(filePath);
    } catch (error) {
      throw Object.assign(new Error('Privacy export file cannot be bound.'), {
        code: 'PRIVACY_EXPORT_FILE_UNSAFE',
        cause: error
      });
    }
    const relative = path.relative(this.exportDirRealpath, canonical);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || !relative ||
        relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw Object.assign(new Error('Privacy export file is not a private regular file.'), {
        code: 'PRIVACY_EXPORT_FILE_UNSAFE'
      });
    }
    const binding = Object.freeze({
      ownerId: String(ownerId),
      dev: String(stats.dev),
      ino: String(stats.ino),
      nlink: stats.nlink,
      realpath: canonical
    });
    if (persistedBinding && (
      String(persistedBinding.ownerId) !== binding.ownerId ||
      path.resolve(persistedBinding.filePath) !== path.resolve(filePath) ||
      String(persistedBinding.dev) !== binding.dev ||
      String(persistedBinding.ino) !== binding.ino ||
      Number(persistedBinding.nlink) !== binding.nlink ||
      persistedBinding.realpath !== binding.realpath
    )) {
      throw Object.assign(new Error('Privacy export persisted file binding changed.'), {
        code: 'PRIVACY_EXPORT_FILE_UNSAFE'
      });
    }
    this.exportFileBindings.set(path.resolve(filePath), binding);
    return binding;
  }

  rebuildExportFileBindings() {
    const authorizations = this.store.listExportAuthorizations();
    for (const authorization of authorizations) {
      let present = true;
      try {
        lstatSync(authorization.filePath);
      } catch (error) {
        if (error?.code === 'ENOENT') present = false;
        else {
          throw Object.assign(new Error('Privacy export file cannot be inspected.'), {
            code: 'PRIVACY_EXPORT_FILE_UNSAFE',
            cause: error
          });
        }
      }
      if (!present) {
        const inactive = Boolean(authorization.consumedAt) ||
          Date.parse(this.now()) >= Date.parse(authorization.expiresAt);
        if (inactive) continue;
        throw Object.assign(new Error('Active Privacy export file is missing.'), {
          code: 'PRIVACY_EXPORT_FILE_UNSAFE'
        });
      }
      if (!authorization.binding) {
        throw Object.assign(new Error('Privacy export has no persisted file binding.'), {
          code: 'PRIVACY_EXPORT_FILE_UNSAFE'
        });
      }
      this.bindExportFile(authorization.filePath, authorization.ownerId, authorization.binding);
    }
  }

  validateBoundExportFile(filePath, action) {
    this.assertExportFile(filePath, action);
    const resolved = path.resolve(filePath);
    const binding = this.exportFileBindings.get(resolved);
    let stats;
    let canonical;
    try {
      stats = lstatSync(resolved);
      canonical = realpathSync(resolved);
    } catch (error) {
      throw Object.assign(new Error('Privacy export file binding is unavailable.'), {
        code: 'PRIVACY_EXPORT_FILE_UNSAFE',
        cause: error
      });
    }
    if (!binding || !stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 ||
        String(stats.dev) !== binding.dev || String(stats.ino) !== binding.ino || canonical !== binding.realpath) {
      throw Object.assign(new Error('Privacy export file binding changed.'), {
        code: 'PRIVACY_EXPORT_FILE_UNSAFE'
      });
    }
    return binding;
  }

  readExportDescriptor(descriptor) {
    return readFileSync(descriptor);
  }

  readBoundExportFile(filePath) {
    const resolved = path.resolve(filePath);
    const binding = this.validateBoundExportFile(resolved, 'export_read');
    if (typeof constants.O_NOFOLLOW !== 'number') {
      throw Object.assign(new Error('No-follow file reads are unavailable.'), {
        code: 'PRIVACY_EXPORT_FILE_UNSAFE'
      });
    }
    let descriptor;
    try {
      descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stats = fstatSync(descriptor);
      if (!stats.isFile() || stats.nlink !== 1 ||
          String(stats.dev) !== binding.dev || String(stats.ino) !== binding.ino) {
        throw Object.assign(new Error('Privacy export descriptor binding changed.'), {
          code: 'PRIVACY_EXPORT_FILE_UNSAFE'
        });
      }
      return this.readExportDescriptor(descriptor);
    } catch (error) {
      if (error?.code === 'PRIVACY_EXPORT_FILE_UNSAFE') throw error;
      throw Object.assign(new Error('Privacy export cannot be opened safely.'), {
        code: 'PRIVACY_EXPORT_FILE_UNSAFE',
        cause: error
      });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }

  removeExportFile(filePath, action) {
    this.validateBoundExportFile(filePath, action);
    if (existsSync(filePath)) unlinkSync(filePath);
    this.exportFileBindings.delete(path.resolve(filePath));
  }

  cleanupExports() {
    this.assertExportStorage('retention_cleanup');
    const count = this.store.cleanupExports({
      validateFile: (filePath, action) => this.validateBoundExportFile(filePath, action)
    });
    for (const filePath of this.exportFileBindings.keys()) {
      if (!existsSync(filePath)) this.exportFileBindings.delete(filePath);
    }
    return count;
  }

  hasOwnerExports(ownerId) {
    this.assertExportStorage('export_status');
    return this.store.hasOwnerExports(ownerId, {
      validateFile: (filePath, action) => this.validateBoundExportFile(filePath, action)
    });
  }

  invalidateOwnerExports(ownerId) {
    this.assertExportStorage('export_invalidate');
    const count = this.store.invalidateOwnerExports(ownerId, {
      validateFile: (filePath, action) => this.validateBoundExportFile(filePath, action)
    });
    for (const [filePath, binding] of this.exportFileBindings) {
      if (binding.ownerId === String(ownerId)) this.exportFileBindings.delete(filePath);
    }
    return count;
  }

  notice() {
    return publicPrivacyNotice(this.policy);
  }

  consent(ownerId) {
    return this.store.getConsent(ownerId);
  }

  consentHistory(ownerId) {
    return this.store.listConsents(ownerId);
  }

  hasCurrentConsent(ownerId) {
    return this.consent(ownerId).current === true;
  }

  requireCurrentConsent(ownerId) {
    if (!this.hasCurrentConsent(ownerId)) {
      throw Object.assign(new Error('PRIVACY_CONSENT_REQUIRED'), {
        code: 'PRIVACY_CONSENT_REQUIRED',
        status: 403
      });
    }
    return true;
  }

  acceptConsent({ ownerId, accepted, privacyNoticeVersion, termsVersion, locale, source } = {}) {
    if (accepted !== true) {
      throw Object.assign(new Error('EXPLICIT_CONSENT_REQUIRED'), { code: 'EXPLICIT_CONSENT_REQUIRED' });
    }
    return this.store.acceptConsent({
      ownerId,
      privacyNoticeVersion,
      termsVersion,
      locale,
      source
    });
  }

  withdrawConsent({ ownerId, source } = {}) {
    return this.store.withdrawConsent(ownerId, source);
  }

  recordGeneratedReport(value) {
    return this.store.recordGeneratedReport(value);
  }

  buildExport(ownerId) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const account = this.auth.getAccountById(owner);
    if (!account) throw Object.assign(new Error('ACCOUNT_NOT_FOUND'), { code: 'ACCOUNT_NOT_FOUND' });
    const conversation = this.conversationRuntime?.conversations?.exportForOwner?.(
      owner,
      this.conversationRuntime.messages
    ) || [];
    const memory = this.protectedMemoryRuntime?.exportOwner?.(owner) || {
      entities: [], aliases: [], relations: [], allMemories: [], currentMemories: []
    };
    const financeEntries = this.financeRuntime?.repository?.exportForOwner?.(owner) || [];
    const financeSummary = this.financeRuntime?.repository?.summarizeAllForOwner?.(owner) || {
      incomeMinor: 0, expenseMinor: 0, balanceMinor: 0
    };
    const tasks = this.tasksRuntime?.repository?.exportForOwner?.(owner) || [];
    const attachments = this.attachmentRuntime?.service?.exportOwner?.(owner) || [];
    const quota = this.accessControl?.getAccountUsageSummary?.(owner) || null;
    const reports = this.store.listGeneratedReports(owner);
    return {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      generatedAt: this.now(),
      account: accountExport(account),
      conversations: conversation.filter(c=>!this.learningRuntime?.repository.isLearningConversation(c.id,owner)),
      ...(this.learningRuntime ? {learning:this.learningRuntime.service.export(owner)} : {}),
      memory: {
        rawAndVersioned: memory.allMemories || [],
        structured: {
          entities: memory.entities || [],
          aliases: memory.aliases || [],
          relations: memory.relations || []
        },
        current: memory.currentMemories || []
      },
      finance: {
        entries: financeEntries,
        summary: financeSummary
      },
      tasks,
      ...(this.healthRuntime ? {health: this.healthRuntime.service.export(owner)} : {}),
      ...(this.diaryRuntime ? {diary: this.diaryRuntime.service.list(owner,{})} : {}),
      attachments,
      calendar: {
        birthdayEvidence: (memory.allMemories || []).filter((item) => item.predicate === 'birthday')
      },
      generatedReports: reports,
      quotaUsage: quota,
      privacyConsents: this.store.listConsents(owner),
      dataSources: [
        { name: 'auth', capturedAt: this.now(), version: 'accounts-v1' },
        { name: 'conversation', capturedAt: this.now(), version: 'conversation-schema-v1' },
        { name: 'memory', capturedAt: this.now(), version: 'memory-record-v2' },
        { name: 'finance', capturedAt: this.now(), version: 'finance-schema-v1' },
        { name: 'tasks', capturedAt: this.now(), version: 'tasks-schema-v1' },
        { name: 'attachments', capturedAt: this.now(), version: 'attachments-schema-v1' },
        { name: 'access-control', capturedAt: this.now(), version: 'access-control-generation-120' },
        { name: 'privacy', capturedAt: this.now(), version: this.policy.privacyNoticeVersion }
      ]
    };
  }

  createExport(ownerId) {
    this.requireCurrentConsent(ownerId);
    this.cleanupExports();
    const payload = this.buildExport(ownerId);
    const token = randomToken();
    const filePath = path.join(this.exportDir, `user-export-${crypto.randomUUID()}.json`);
    this.assertExportFile(filePath, 'export_create');
    durableJson(filePath, payload);
    const fileBinding = this.bindExportFile(filePath, ownerId);
    try {
      const grant = this.store.createExportGrant({
        ownerId,
        token,
        filePath,
        fileBinding,
        ttlMs: this.exportTtlMs
      });
      return {
        downloadUrl: `/api/privacy/exports/download/${encodeURIComponent(token)}`,
        expiresAt: grant.expiresAt
      };
    } catch (error) {
      if (this.exportFileBindings.has(path.resolve(filePath))) {
        this.removeExportFile(filePath, 'export_create_rollback');
      }
      throw error;
    }
  }

  consumeExport(ownerId, token) {
    this.cleanupExports();
    const grant = this.store.getConsumableExport({ ownerId, token });
    let buffer;
    try {
      buffer = this.readBoundExportFile(grant.filePath);
      JSON.parse(buffer.toString('utf8'));
    } catch (error) {
      if (this.exportFileBindings.has(path.resolve(grant.filePath))) {
        this.removeExportFile(grant.filePath, 'export_read_failure_delete');
      }
      throw error;
    }
    this.store.consumeExport({ ownerId, token, expectedGrantId: grant.id });
    if (this.exportFileBindings.has(path.resolve(grant.filePath))) {
      this.removeExportFile(grant.filePath, 'export_consume_delete');
    }
    return { buffer, filename: 'ai-fenshen-my-data.json', grant };
  }

  initiateDeletion(ownerId) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    this.requireCurrentConsent(owner);
    const token = randomToken();
    const subjectRef = this.accessControl.digest(`deletion-subject:${owner}`);
    const request = this.store.createDeletionRequest({
      ownerId: owner,
      subjectRef,
      token,
      ttlMs: this.deletionTtlMs
    });
    return {
      confirmationToken: token,
      expiresAt: request.expiresAt,
      impact: {
        account: true,
        sessions: true,
        conversations: true,
        memory: true,
        finance: true,
        tasks: true,
        attachments: true,
        calendarEvidence: true,
        quotaAndUsage: true,
        reportsAndTemporaryFiles: true,
        backups: 'tombstone_pending_physical_cleanup'
      }
    };
  }

  executeDeletion({ ownerId, confirmationToken } = {}) {
    const owner = required(ownerId, 'OWNER_REQUIRED');
    const subjectRef = this.accessControl.digest(`deletion-subject:${owner}`);
    const request = this.store.getDeletionRequest({
      ownerId: owner,
      subjectRef,
      token: confirmationToken
    });
    if (request.status === 'completed') {
      return this.store.getDeletionReceipt(request.receipt_id);
    }
    this.store.markDeletionProcessing(request.id);
    let username = '';
    try {
      const account = this.auth.getAccountById(owner);
      username = account?.username || '';
      this.auth.disableAccountById(owner);
      this.conversationRuntime?.registry?.cancelAllForOwner?.(owner);
      this.invalidateOwnerExports(owner);
      this.attachmentRuntime?.service?.cancelAllForOwner?.(owner);
      this.learningRuntime?.service?.deleteAllForOwner?.(owner);
      this.conversationRuntime?.conversations?.deleteAllForOwner?.(owner);
      this.protectedMemoryRuntime?.deleteOwner?.(owner);
      this.financeRuntime?.repository?.deleteAllForOwner?.(owner);
      this.diaryRuntime?.service?.deleteAllForOwner?.(owner);
      this.healthRuntime?.service?.deleteAllForOwner?.(owner);
      this.tasksRuntime?.repository?.deleteAllForOwner?.(owner);
      this.attachmentRuntime?.service?.deleteAllForOwner?.(owner);
      this.accessControl.deleteAccountData({ accountId: owner, username });
      this.auth.deleteAccountById(owner);
      this.store.deleteOwnerPrivacyData(owner);

      const verified = [
        !this.auth.getAccountById(owner),
        (this.conversationRuntime?.conversations?.listForOwner?.(owner) || []).length === 0,
        this.protectedMemoryRuntime?.verifyOwnerDeleted?.(owner) !== false,
        (this.financeRuntime?.repository?.exportForOwner?.(owner) || []).length === 0,
        (this.tasksRuntime?.repository?.exportForOwner?.(owner) || []).length === 0,
        (!this.diaryRuntime || this.diaryRuntime.service.list(owner,{}).length === 0) &&
        (!this.healthRuntime || this.healthRuntime.service.list(owner,{}).length === 0),
        this.attachmentRuntime?.service?.verifyOwnerDeleted?.(owner) !== false,
        this.accessControl.getAccountAccess(owner) == null,
        !this.hasOwnerExports(owner),
        !this.store.hasOwnerExportMetadata(owner),
        this.store.listConsents(owner).length === 0
      ].every(Boolean);
      if (!verified) throw Object.assign(new Error('DELETION_VERIFICATION_FAILED'), { code: 'DELETION_VERIFICATION_FAILED' });

      const receipt = {
        receiptId: `del_${crypto.randomUUID()}`,
        subjectRef,
        status: 'completed',
        completedAt: this.now(),
        scopeVersion: DELETION_SCOPE_VERSION,
        tombstoneVersion: TOMBSTONE_VERSION
      };
      receipt.signature = signature(this.secret, receipt);
      return this.store.completeDeletion({ requestId: request.id, receipt });
    } catch (error) {
      this.store.markDeletionFailed(request.id, error?.code || 'DELETION_FAILED');
      throw Object.assign(new Error('DELETION_NOT_COMPLETED'), {
        code: 'DELETION_NOT_COMPLETED',
        cause: error
      });
    }
  }

  listDeletionReceipts() {
    return this.store.listDeletionReceipts();
  }
}

export {
  DELETION_SCOPE_VERSION,
  EXPORT_SCHEMA_VERSION,
  TOMBSTONE_VERSION
};
