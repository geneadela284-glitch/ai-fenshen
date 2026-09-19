import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHECKPOINT_LOCKED = 'PROJECT_STATE_CHECKPOINT_LOCKED';
export const CHECKPOINT_RECOVERY_REQUIRED = 'PROJECT_STATE_RECOVERY_REQUIRED';
export const CHECKPOINT_TRANSACTION_VERSION = 1;

const TRANSACTION_DIRECTORY_NAME = 'aiwc-project-state';
const JOURNAL_NAME = 'transaction.json';
const ORIGINAL_NAME = 'original.bin';
const CANDIDATE_NAME = 'candidate.bin';
const LOCK_NAME = 'lock';
const OWNER_NAME = 'owner.json';
const OWNERLESS_LOCK_GRACE_MS = 30_000;

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function fsyncDirectory(directoryPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== 'win32' || !['EINVAL', 'EPERM', 'EBADF', 'EISDIR'].includes(error?.code)) throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function writeDurableExclusive(filePath, content, mode = 0o600) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'wx', mode);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(filePath));
}

function replaceDurable(filePath, content, transactionId) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${transactionId}.${crypto.randomUUID()}.tmp`
  );
  try {
    writeDurableExclusive(temporaryPath, content);
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (fs.existsSync(temporaryPath)) removeDurable(temporaryPath);
  }
}

function removeDurable(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return false;
  }
  fsyncDirectory(path.dirname(filePath));
  return true;
}

function gitTransactionParent(repoRoot) {
  let gitPath;
  try {
    gitPath = execFileSync('git', ['rev-parse', '--git-path', TRANSACTION_DIRECTORY_NAME], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).replace(/\r?\n$/, '');
  } catch {
    throw new Error('Checkpoint transaction Git directory cannot be determined.');
  }
  if (!gitPath) throw new Error('Checkpoint transaction Git directory is empty.');
  const absolute = path.isAbsolute(gitPath) ? gitPath : path.resolve(repoRoot, gitPath);
  const parent = fs.realpathSync(path.dirname(absolute));
  return path.join(parent, path.basename(absolute));
}

function canonicalIdentity(repoRoot, statePath) {
  const repository = fs.realpathSync(repoRoot);
  const absolute = path.resolve(statePath);
  const parent = fs.realpathSync(path.dirname(absolute));
  const resolved = path.join(parent, path.basename(absolute));
  if (resolved === repository || !resolved.startsWith(`${repository}${path.sep}`)) {
    throw new Error('Canonical state path must remain inside the repository.');
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Canonical state must be a regular file and must not be a symbolic link.');
  }
  if (fs.realpathSync(absolute) !== resolved) {
    throw new Error('Canonical state path resolves through an unsafe symbolic link.');
  }
  return {
    absolute: resolved,
    relative: path.relative(repository, resolved).split(path.sep).join('/'),
    mode: stat.mode & 0o777
  };
}

export function getCheckpointTransactionPaths(repoRoot) {
  const root = gitTransactionParent(repoRoot);
  const lock = path.join(root, LOCK_NAME);
  return {
    root,
    lock,
    owner: path.join(lock, OWNER_NAME),
    journal: path.join(root, JOURNAL_NAME),
    original: path.join(root, ORIGINAL_NAME),
    candidate: path.join(root, CANDIDATE_NAME)
  };
}

function ensureTransactionRoot(paths, statePath) {
  const parent = path.dirname(paths.root);
  try {
    fs.mkdirSync(paths.root, { mode: 0o700 });
    fsyncDirectory(parent);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(paths.root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Checkpoint transaction root is not a safe directory.');
  if (stat.dev !== fs.statSync(path.dirname(statePath)).dev) {
    throw new Error('Checkpoint transaction root and canonical state are on different filesystems.');
  }
}

function lockOwner(transactionId) {
  return Buffer.from(`${JSON.stringify({
    version: 1,
    transaction_id: transactionId,
    pid: process.pid,
    hostname: os.hostname(),
    started_at: new Date().toISOString()
  }, null, 2)}\n`);
}

function acquireLock(paths, statePath, transactionId) {
  ensureTransactionRoot(paths, statePath);
  try {
    fs.mkdirSync(paths.lock, { mode: 0o700 });
    fsyncDirectory(paths.root);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`${CHECKPOINT_LOCKED}: another checkpoint or recovery owns the lock.`);
    throw error;
  }
  try {
    writeDurableExclusive(paths.owner, lockOwner(transactionId));
    fsyncDirectory(paths.lock);
  } catch (error) {
    try {
      fs.rmSync(paths.lock, { recursive: true, force: true });
      fsyncDirectory(paths.root);
    } catch {
      // The caller will report the original lock acquisition failure.
    }
    throw error;
  }
  return () => {
    removeDurable(paths.owner);
    fs.rmdirSync(paths.lock);
    fsyncDirectory(paths.root);
  };
}

function knownTemporaryName(name) {
  return (name.startsWith(`.${JOURNAL_NAME}.`) || name.startsWith('.restore.')) && name.endsWith('.tmp');
}

function transactionRootEntries(paths) {
  if (!fs.existsSync(paths.root)) return [];
  return fs.readdirSync(paths.root);
}

function knownTemporaryPaths(paths) {
  return transactionRootEntries(paths)
    .filter(knownTemporaryName)
    .map((name) => path.join(paths.root, name));
}

function unexpectedRootEntries(paths) {
  const allowed = new Set([LOCK_NAME, JOURNAL_NAME, ORIGINAL_NAME, CANDIDATE_NAME]);
  return transactionRootEntries(paths).filter((name) => !allowed.has(name) && !knownTemporaryName(name));
}

function existingArtifacts(paths, { includeLock = true } = {}) {
  const artifacts = [];
  if (includeLock && fs.existsSync(paths.lock)) artifacts.push('lock');
  if (fs.existsSync(paths.journal)) artifacts.push('journal');
  if (fs.existsSync(paths.original)) artifacts.push('original');
  if (fs.existsSync(paths.candidate)) artifacts.push('candidate');
  if (knownTemporaryPaths(paths).length) artifacts.push('temporary-file');
  if (unexpectedRootEntries(paths).length) artifacts.push('unexpected-entry');
  return artifacts;
}

export function inspectCheckpointTransaction(repoRoot) {
  const paths = getCheckpointTransactionPaths(repoRoot);
  const artifacts = existingArtifacts(paths);
  return {
    pending: artifacts.length > 0,
    artifacts,
    paths
  };
}

function journalBytes(journal) {
  return Buffer.from(`${JSON.stringify(journal, null, 2)}\n`);
}

function writeJournal(paths, journal) {
  replaceDurable(paths.journal, journalBytes(journal), journal.transaction_id);
}

function readJournal(paths, expectedStatePath) {
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(paths.journal, 'utf8'));
  } catch {
    throw new Error(`${CHECKPOINT_RECOVERY_REQUIRED}: checkpoint journal is unreadable or damaged.`);
  }
  const required = [
    'version',
    'transaction_id',
    'phase',
    'state_path',
    'original_mode',
    'original_sha256',
    'candidate_sha256'
  ];
  if (
    journal.version !== CHECKPOINT_TRANSACTION_VERSION ||
    required.some((field) => journal[field] === undefined) ||
    !['PREPARED', 'INSTALLED', 'VERIFIED'].includes(journal.phase) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.transaction_id) ||
    journal.state_path !== expectedStatePath ||
    !Number.isInteger(journal.original_mode) || journal.original_mode < 0 || journal.original_mode > 0o777 ||
    !/^[0-9a-f]{64}$/.test(journal.original_sha256) ||
    !/^[0-9a-f]{64}$/.test(journal.candidate_sha256)
  ) {
    throw new Error(`${CHECKPOINT_RECOVERY_REQUIRED}: checkpoint journal contract is invalid.`);
  }
  return journal;
}

function cleanupTransactionArtifacts(paths, { keepOriginal = false, keepJournal = false } = {}) {
  for (const temporaryPath of knownTemporaryPaths(paths)) removeDurable(temporaryPath);
  removeDurable(paths.candidate);
  if (!keepJournal) removeDurable(paths.journal);
  if (!keepOriginal) removeDurable(paths.original);
}

function restoreOriginal({ paths, statePath, journal, validateRestored, faultInjector }) {
  if (!fs.existsSync(paths.original)) throw new Error('durable original backup is missing.');
  const original = fs.readFileSync(paths.original);
  if (sha256(original) !== journal.original_sha256) throw new Error('durable original backup digest mismatch.');
  const restorePath = path.join(paths.root, `.restore.${journal.transaction_id}.${crypto.randomUUID()}.tmp`);
  try {
    writeDurableExclusive(restorePath, original, journal.original_mode);
    faultInjector?.('before-rollback-rename');
    fs.renameSync(restorePath, statePath);
    faultInjector?.('after-rollback-rename');
    fsyncDirectory(path.dirname(statePath));
    faultInjector?.('after-rollback-directory-fsync');
  } finally {
    if (fs.existsSync(restorePath)) removeDurable(restorePath);
  }
  if (sha256(fs.readFileSync(statePath)) !== journal.original_sha256) {
    throw new Error('canonical digest does not match the durable original after rollback.');
  }
  validateRestored?.();
}

function rollbackAfterFailure(options, originalError) {
  const { paths, statePath, journal, validateRestored, faultInjector } = options;
  try {
    restoreOriginal({ paths, statePath, journal, validateRestored, faultInjector });
    cleanupTransactionArtifacts(paths);
  } catch (rollbackError) {
    throw new Error(
      `${CHECKPOINT_RECOVERY_REQUIRED}: checkpoint failed (${originalError.message}); ` +
      `automatic rollback could not be confirmed (${rollbackError.message}).`
    );
  }
  throw new Error(`${originalError.message}; rollback completed and original canonical bytes were restored.`);
}

export function runCheckpointTransaction({
  repoRoot,
  statePath,
  expectedStateToken,
  expectedGeneration,
  tokenForBytes,
  generationForBytes,
  createCandidate,
  validateCandidate,
  validateInstalled,
  validateRestored,
  faultInjector
}) {
  const identity = canonicalIdentity(repoRoot, statePath);
  statePath = identity.absolute;
  const transactionId = crypto.randomUUID();
  const paths = getCheckpointTransactionPaths(repoRoot);
  const releaseLock = acquireLock(paths, statePath, transactionId);
  let journal = null;
  let completed = false;
  let commitDecisionDurable = false;
  try {
    const leftovers = existingArtifacts(paths, { includeLock: false });
    if (leftovers.length) {
      throw new Error(`${CHECKPOINT_RECOVERY_REQUIRED}: unfinished checkpoint artifacts exist (${leftovers.join(', ')}).`);
    }
    const lockedIdentity = canonicalIdentity(repoRoot, statePath);
    if (lockedIdentity.relative !== identity.relative || lockedIdentity.mode !== identity.mode) {
      throw new Error('Canonical state identity or mode changed before checkpoint CAS validation.');
    }
    const original = fs.readFileSync(statePath);
    const actualStateToken = tokenForBytes(original);
    const actualGeneration = generationForBytes(original);
    if (actualStateToken !== expectedStateToken) {
      throw new Error('Checkpoint CAS rejected a stale state token.');
    }
    if (actualGeneration !== expectedGeneration) {
      throw new Error(`Checkpoint CAS rejected stale generation ${expectedGeneration}; current generation is ${actualGeneration}.`);
    }

    const candidate = Buffer.from(createCandidate({ original, actualStateToken, actualGeneration }));
    journal = {
      version: CHECKPOINT_TRANSACTION_VERSION,
      transaction_id: transactionId,
      phase: 'PREPARED',
      state_path: identity.relative,
      original_mode: identity.mode,
      original_sha256: sha256(original),
      candidate_sha256: sha256(candidate),
      expected_generation: expectedGeneration,
      next_generation: expectedGeneration + 1,
      started_at: new Date().toISOString()
    };

    writeDurableExclusive(paths.original, original);
    faultInjector?.('after-original-backup-durable');
    writeDurableExclusive(paths.candidate, candidate, identity.mode);
    faultInjector?.('after-candidate-durable');
    validateCandidate(paths.candidate);
    faultInjector?.('after-candidate-validation');
    writeJournal(paths, journal);
    faultInjector?.('after-journal-durable');

    fs.renameSync(paths.candidate, statePath);
    faultInjector?.('after-canonical-rename');
    faultInjector?.('before-canonical-directory-fsync');
    fsyncDirectory(path.dirname(statePath));
    faultInjector?.('after-canonical-directory-fsync');
    journal = { ...journal, phase: 'INSTALLED' };
    writeJournal(paths, journal);
    faultInjector?.('after-installed-journal-durable');

    const installed = validateInstalled();
    faultInjector?.('after-installed-validation');
    journal = { ...journal, phase: 'VERIFIED' };
    writeJournal(paths, journal);
    faultInjector?.('after-verified-journal-durable');

    // Removing the journal first records a durable commit decision. A crash
    // after this point leaves at most an orphan backup that recovery can clean.
    removeDurable(paths.journal);
    commitDecisionDurable = true;
    faultInjector?.('after-commit-decision-durable');
    removeDurable(paths.original);
    completed = true;
    return installed;
  } catch (error) {
    if (commitDecisionDurable) {
      throw new Error(
        `${CHECKPOINT_RECOVERY_REQUIRED}: the commit decision is durable, but checkpoint cleanup was not confirmed (${error.message}).`
      );
    }
    if (journal && fs.existsSync(paths.journal)) {
      rollbackAfterFailure({ paths, statePath, journal, validateRestored, faultInjector }, error);
    }
    try {
      cleanupTransactionArtifacts(paths);
    } catch (cleanupError) {
      throw new Error(`${CHECKPOINT_RECOVERY_REQUIRED}: pre-install failure cleanup could not be confirmed (${cleanupError.message}).`);
    }
    throw error;
  } finally {
    try {
      releaseLock();
    } catch (releaseError) {
      if (completed) {
        throw new Error(`${CHECKPOINT_RECOVERY_REQUIRED}: canonical committed but lock release failed (${releaseError.message}).`);
      }
    }
  }
}

function processIsAlive(owner) {
  if (!owner || owner.hostname !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function removeStaleLock(paths) {
  if (!fs.existsSync(paths.lock)) return;
  let owner = null;
  try {
    owner = JSON.parse(fs.readFileSync(paths.owner, 'utf8'));
  } catch {
    const age = Date.now() - fs.lstatSync(paths.lock).mtimeMs;
    if (age < OWNERLESS_LOCK_GRACE_MS) {
      throw new Error(`${CHECKPOINT_LOCKED}: lock ownership is not readable and the acquisition grace period has not elapsed.`);
    }
  }
  if (processIsAlive(owner)) throw new Error(`${CHECKPOINT_LOCKED}: checkpoint owner process ${owner.pid} is still active.`);
  const names = fs.readdirSync(paths.lock);
  if (names.some((name) => name !== OWNER_NAME)) {
    throw new Error(`${CHECKPOINT_RECOVERY_REQUIRED}: lock directory contains unexpected entries.`);
  }
  if (fs.existsSync(paths.owner)) fs.unlinkSync(paths.owner);
  fs.rmdirSync(paths.lock);
  fsyncDirectory(paths.root);
}

export function recoverCheckpointTransaction({ repoRoot, statePath, validateCanonical, faultInjector }) {
  const identity = canonicalIdentity(repoRoot, statePath);
  statePath = identity.absolute;
  const transactionId = `recovery-${crypto.randomUUID()}`;
  const paths = getCheckpointTransactionPaths(repoRoot);
  ensureTransactionRoot(paths, statePath);
  removeStaleLock(paths);
  const releaseLock = acquireLock(paths, statePath, transactionId);
  try {
    if (!fs.existsSync(paths.journal)) {
      const orphans = existingArtifacts(paths, { includeLock: false });
      if (!orphans.length) return { outcome: 'NO_RECOVERY_NEEDED' };
      if (unexpectedRootEntries(paths).length) {
        throw new Error(`${CHECKPOINT_RECOVERY_REQUIRED}: transaction directory contains unexpected entries.`);
      }
      validateCanonical();
      cleanupTransactionArtifacts(paths);
      return { outcome: 'ORPHANS_CLEANED' };
    }

    const journal = readJournal(paths, identity.relative);
    if (!fs.existsSync(paths.original) || sha256(fs.readFileSync(paths.original)) !== journal.original_sha256) {
      throw new Error(`${CHECKPOINT_RECOVERY_REQUIRED}: durable original backup is missing or damaged.`);
    }
    const currentDigest = fs.existsSync(statePath) ? sha256(fs.readFileSync(statePath)) : null;
    if (journal.phase === 'VERIFIED' && currentDigest === journal.candidate_sha256) {
      validateCanonical();
      cleanupTransactionArtifacts(paths);
      return { outcome: 'VERIFIED_COMMIT_FINALIZED' };
    }

    restoreOriginal({ paths, statePath, journal, validateRestored: validateCanonical, faultInjector });
    cleanupTransactionArtifacts(paths);
    return { outcome: 'ORIGINAL_RESTORED' };
  } catch (error) {
    if (String(error.message).includes(CHECKPOINT_RECOVERY_REQUIRED)) throw error;
    throw new Error(`${CHECKPOINT_RECOVERY_REQUIRED}: recovery could not be confirmed (${error.message}).`);
  } finally {
    releaseLock();
  }
}
