import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_UNTRACKED = /(^|\/)(\.env(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|private[-_. ]?key(?:\.|$)|tokens?(?:\.|$)|data\/|uploads?\/|logs?\/|caches?\/)|\.(?:sqlite|sqlite3|db)$/i;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${options.label || command} failed with exit code ${result.status ?? 'unknown'}.`);
  }
  return result.stdout;
}

function git(repoRoot, args, options = {}) {
  return run('git', args, { cwd: repoRoot, input: options.input, label: `git ${args[0]}` });
}

function splitNul(buffer) {
  if (buffer.length > 0 && buffer.at(-1) !== 0) throw new Error('Git path output was not NUL terminated.');
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index > start) records.push(Buffer.from(buffer.subarray(start, index)));
    start = index + 1;
  }
  return records;
}

function gitPaths(repoRoot, args) {
  return splitNul(git(repoRoot, [...args, '-z']));
}

function absoluteBytes(root, relativeBytes) {
  return Buffer.concat([Buffer.from(`${root}${path.sep}`), relativeBytes]);
}

function parentBytes(absolutePath) {
  const separator = absolutePath.lastIndexOf(path.sep.charCodeAt(0));
  if (separator < 1) throw new Error('Exact-worktree path has no safe parent.');
  return absolutePath.subarray(0, separator);
}

function assertSafeUntracked(relativeBytes) {
  const display = relativeBytes.toString('utf8').replaceAll('\\', '/');
  if (SENSITIVE_UNTRACKED.test(display)) {
    throw new Error('SENSITIVE_UNTRACKED_PATH_BLOCKED');
  }
}

function copyUntracked(source, destination) {
  const paths = gitPaths(source, ['ls-files', '--others', '--exclude-standard']);
  for (const relativeBytes of paths) {
    assertSafeUntracked(relativeBytes);
    const from = absoluteBytes(source, relativeBytes);
    const to = absoluteBytes(destination, relativeBytes);
    const stat = fs.lstatSync(from);
    fs.mkdirSync(parentBytes(to), { recursive: true });
    if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, stat.mode & 0o777);
    } else if (stat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from, { encoding: 'buffer' }), to);
    } else {
      throw new Error('Unsupported untracked file type in exact-worktree copy.');
    }
  }
}

export function createExactWorktreeClone({ repoRoot, destination }) {
  const source = fs.realpathSync(repoRoot);
  const target = path.resolve(destination);
  if (target === source || target.startsWith(`${source}${path.sep}`)) {
    throw new Error('Exact-worktree clone must be outside the source repository.');
  }
  run('git', ['clone', '--no-hardlinks', '--local', source, target], { cwd: path.dirname(target), label: 'git clone' });
  const patch = git(source, ['diff', 'HEAD', '--binary', '--full-index', '--no-ext-diff']);
  if (patch.length > 0) git(target, ['apply', '--binary', '-'], { input: patch });
  copyUntracked(source, target);
  const sourceManifest = createExactWorktreeManifest(source);
  const cloneManifest = createExactWorktreeManifest(target);
  if (sourceManifest.digest !== cloneManifest.digest || sourceManifest.entries !== cloneManifest.entries) {
    throw new Error('Exact-worktree manifest mismatch after clone overlay.');
  }
  return { sourceManifest, cloneManifest };
}

export function createExactWorktreeManifest(repoRoot) {
  const root = fs.realpathSync(repoRoot);
  const records = [];
  for (const relativeBytes of gitPaths(root, ['ls-files', '--cached', '--others', '--exclude-standard'])) {
    const absolutePath = absoluteBytes(root, relativeBytes);
    let record;
    try {
      const stat = fs.lstatSync(absolutePath);
      const mode = (stat.mode & 0o777).toString(8);
      if (stat.isFile()) {
        record = [relativeBytes.toString('base64'), 'file', mode, crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')];
      } else if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(absolutePath, { encoding: 'buffer' });
        record = [relativeBytes.toString('base64'), 'symlink', mode, crypto.createHash('sha256').update(target).digest('hex')];
      } else {
        throw new Error('Unsupported file type in exact-worktree manifest.');
      }
    } catch (error) {
      if (error?.code === 'ENOENT') record = [relativeBytes.toString('base64'), 'missing', '0', '-'];
      else throw error;
    }
    records.push(record);
  }
  records.sort((left, right) => Buffer.compare(Buffer.from(left[0], 'base64'), Buffer.from(right[0], 'base64')));
  const serialized = Buffer.from(`${JSON.stringify(records)}\n`);
  return {
    entries: records.length,
    digest: crypto.createHash('sha256').update(serialized).digest('hex')
  };
}
