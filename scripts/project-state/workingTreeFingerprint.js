import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const WORKING_TREE_FINGERPRINT_VERSION = 2;
// Algorithm ID binds the digest primitive to the complete v2 record format:
// raw-byte path ordering, length-prefixed records, Git index metadata, and
// normalized worktree type/mode/content digests. It is not merely a hash name.
export const WORKING_TREE_FINGERPRINT_ALGORITHM = 'aiwc-working-tree-fingerprint-v2-sha256';

const FORMAT_HEADER = Buffer.from('AIWC_WORKING_TREE_FINGERPRINT\0V2\0', 'ascii');
const DIGEST_ALGORITHM = 'sha256';
const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

function gitBuffer(repoRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'buffer',
      maxBuffer: MAX_GIT_OUTPUT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    throw new Error(`Working-tree fingerprint Git command failed: git ${args[0]}.`);
  }
}

function splitNul(buffer, source) {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) throw new Error(`${source} did not return NUL-terminated output.`);
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) records.push(Buffer.from(buffer.subarray(start, index)));
    start = index + 1;
  }
  return records;
}

function pathKey(pathBytes) {
  return pathBytes.toString('base64');
}

function comparePathBytes(left, right) {
  return Buffer.compare(left.pathBytes, right.pathBytes);
}

function validateRelativePathBytes(pathBytes, source) {
  if (pathBytes.length === 0 || pathBytes[0] === 0x2f || pathBytes.includes(0)) {
    throw new Error(`${source} returned an unsafe repository path.`);
  }
  const components = [];
  let start = 0;
  for (let index = 0; index <= pathBytes.length; index += 1) {
    if (index !== pathBytes.length && pathBytes[index] !== 0x2f) continue;
    components.push(pathBytes.subarray(start, index));
    start = index + 1;
  }
  if (components.some((component) => component.length === 0 || component.equals(Buffer.from('..')))) {
    throw new Error(`${source} returned an unsafe repository path.`);
  }
}

function normalizeExcludedPaths(excludedPaths) {
  if (!Array.isArray(excludedPaths)) throw new Error('excludedPaths must be an array.');
  const unique = new Map();
  for (const excludedPath of excludedPaths) {
    if (typeof excludedPath !== 'string' || excludedPath.length === 0 || path.isAbsolute(excludedPath) || excludedPath.includes('\\')) {
      throw new Error('An excluded working-tree path is invalid.');
    }
    if (path.posix.normalize(excludedPath) !== excludedPath || excludedPath === '.' || excludedPath.startsWith('../')) {
      throw new Error('An excluded working-tree path is invalid.');
    }
    const pathBytes = Buffer.from(excludedPath, 'utf8');
    validateRelativePathBytes(pathBytes, 'excludedPaths');
    unique.set(pathKey(pathBytes), pathBytes);
  }
  return [...unique.values()].sort(Buffer.compare);
}

function isExcluded(pathBytes, excludedKeys) {
  return excludedKeys.has(pathKey(pathBytes));
}

function uniqueSortedPaths(records, source, excludedKeys) {
  const unique = new Map();
  for (const pathBytes of records) {
    validateRelativePathBytes(pathBytes, source);
    if (!isExcluded(pathBytes, excludedKeys)) unique.set(pathKey(pathBytes), pathBytes);
  }
  return [...unique.values()].sort(Buffer.compare);
}

function parseIndexRecords(records, excludedKeys) {
  const parsed = [];
  for (const record of records) {
    const delimiter = record.indexOf(0x09);
    if (delimiter < 1 || delimiter === record.length - 1) throw new Error('git ls-files --stage returned a damaged record.');
    const header = record.subarray(0, delimiter).toString('ascii');
    const match = /^([0-7]{6}) ([0-9a-f]+) ([0-3])$/.exec(header);
    if (!match) throw new Error('git ls-files --stage returned an invalid header.');
    const pathBytes = Buffer.from(record.subarray(delimiter + 1));
    validateRelativePathBytes(pathBytes, 'git ls-files --stage');
    if (isExcluded(pathBytes, excludedKeys)) continue;
    parsed.push({
      pathBytes,
      mode: Buffer.from(match[1], 'ascii'),
      objectId: Buffer.from(match[2], 'ascii'),
      stage: Buffer.from(match[3], 'ascii')
    });
  }
  return parsed.sort((left, right) => {
    const pathOrder = Buffer.compare(left.pathBytes, right.pathBytes);
    return pathOrder || Buffer.compare(left.stage, right.stage);
  });
}

function absolutePathBuffer(repoRoot, pathBytes) {
  return Buffer.concat([Buffer.from(path.resolve(repoRoot) + path.sep), pathBytes]);
}

function digest(buffer) {
  return crypto.createHash(DIGEST_ALGORITHM).update(buffer).digest();
}

function inspectWorktreePath(repoRoot, pathBytes) {
  const absolutePath = absolutePathBuffer(repoRoot, pathBytes);
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { mode: Buffer.from('000000', 'ascii'), contentDigest: Buffer.alloc(0) };
    throw new Error('A working-tree path could not be inspected.');
  }
  if (stat.isSymbolicLink()) {
    try {
      return { mode: Buffer.from('120000', 'ascii'), contentDigest: digest(fs.readlinkSync(absolutePath, { encoding: 'buffer' })) };
    } catch {
      throw new Error('A working-tree symlink could not be read.');
    }
  }
  if (stat.isFile()) {
    const mode = stat.mode & 0o111 ? '100755' : '100644';
    try {
      return { mode: Buffer.from(mode, 'ascii'), contentDigest: digest(fs.readFileSync(absolutePath)) };
    } catch {
      throw new Error('A working-tree file could not be hashed.');
    }
  }
  throw new Error('Unsupported working-tree file type; fingerprint aborted.');
}

function lengthBuffer(length) {
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64BE(BigInt(length));
  return result;
}

function updateRecord(hash, tag, fields) {
  const tagBuffer = Buffer.from(tag, 'ascii');
  hash.update(lengthBuffer(tagBuffer.length));
  hash.update(tagBuffer);
  hash.update(lengthBuffer(fields.length));
  for (const field of fields) {
    hash.update(lengthBuffer(field.length));
    hash.update(field);
  }
}

function buildEntries(trackedChanged, untracked) {
  const entries = [
    ...trackedChanged.map((pathBytes) => ({ kind: 'tracked', pathBytes })),
    ...untracked.map((pathBytes) => ({ kind: 'untracked', pathBytes }))
  ].sort(comparePathBytes);
  return entries.map((entry) => ({
    kind: entry.kind,
    path_encoding: 'base64',
    path: pathKey(entry.pathBytes)
  }));
}

export function collectWorkingTreeSnapshot(repoRoot, excludedPaths = []) {
  const excluded = normalizeExcludedPaths(excludedPaths);
  const excludedKeys = new Set(excluded.map(pathKey));
  const trackedChanged = uniqueSortedPaths(
    splitNul(gitBuffer(repoRoot, ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']), 'git diff'),
    'git diff',
    excludedKeys
  );
  const untracked = uniqueSortedPaths(
    splitNul(gitBuffer(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']), 'git ls-files --others'),
    'git ls-files --others',
    excludedKeys
  );
  const trackedPaths = uniqueSortedPaths(
    splitNul(gitBuffer(repoRoot, ['ls-files', '-z']), 'git ls-files'),
    'git ls-files',
    excludedKeys
  );
  const indexRecords = parseIndexRecords(
    splitNul(gitBuffer(repoRoot, ['ls-files', '--stage', '-z']), 'git ls-files --stage'),
    excludedKeys
  );
  const trackedWorktree = trackedPaths.map((pathBytes) => ({
    pathBytes,
    ...inspectWorktreePath(repoRoot, pathBytes)
  }));
  const stageZeroIndexModes = new Map(
    indexRecords
      .filter((record) => record.stage.equals(Buffer.from('0', 'ascii')))
      .map((record) => [pathKey(record.pathBytes), record.mode])
  );
  const allTrackedChanged = uniqueSortedPaths([
    ...trackedChanged,
    ...trackedWorktree
      .filter((record) => {
        const indexMode = stageZeroIndexModes.get(pathKey(record.pathBytes));
        return indexMode && !indexMode.equals(record.mode);
      })
      .map((record) => record.pathBytes)
  ], 'working-tree mode comparison', excludedKeys);
  const entries = buildEntries(allTrackedChanged, untracked);
  const hash = crypto.createHash(DIGEST_ALGORITHM);
  hash.update(FORMAT_HEADER);
  for (const pathBytes of excluded) updateRecord(hash, 'excluded', [pathBytes]);
  for (const entry of [...allTrackedChanged.map((pathBytes) => ({ kind: 'tracked', pathBytes })), ...untracked.map((pathBytes) => ({ kind: 'untracked', pathBytes }))].sort(comparePathBytes)) {
    updateRecord(hash, 'change', [Buffer.from(entry.kind, 'ascii'), entry.pathBytes]);
  }
  for (const record of indexRecords) {
    updateRecord(hash, 'index', [record.pathBytes, record.mode, record.objectId, record.stage]);
  }
  for (const record of trackedWorktree) {
    updateRecord(hash, 'tracked-worktree', [record.pathBytes, record.mode, record.contentDigest]);
  }
  for (const pathBytes of untracked) {
    const record = inspectWorktreePath(repoRoot, pathBytes);
    updateRecord(hash, 'untracked-worktree', [pathBytes, record.mode, record.contentDigest]);
  }
  return {
    state: entries.length ? 'dirty' : 'clean',
    entries,
    fingerprint: {
      version: WORKING_TREE_FINGERPRINT_VERSION,
      algorithm: WORKING_TREE_FINGERPRINT_ALGORITHM,
      value: hash.digest('hex')
    }
  };
}
