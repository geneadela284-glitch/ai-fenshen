import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_FILES = [
  'package.json',
  'server/betaServer.js',
  'apps/desktop/dist/index.html',
  'release-runtime.json'
];
const CANONICAL_STATE_FILE = 'AI_WORK_SECRETARY_PROJECT_STATE.md';
const RELEASE_RUNTIME_MANIFEST_SCHEMA = 1;

function normalizedRoot(releaseRoot) {
  if (typeof releaseRoot !== 'string' || !releaseRoot.trim()) {
    throw new Error('releaseRoot is required.');
  }
  const resolved = path.resolve(releaseRoot);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertReadableFile(root, relativePath, errors, allowedRoot = root) {
  const absolutePath = path.resolve(root, relativePath);
  if (!inside(allowedRoot, absolutePath)) {
    errors.push(`runtime path escapes Release: ${relativePath}`);
    return null;
  }
  if (!existsSync(absolutePath)) {
    errors.push(`missing runtime file: ${relativePath}`);
    return null;
  }
  let stats;
  try {
    stats = statSync(absolutePath);
    accessSync(absolutePath, constants.R_OK);
  } catch {
    errors.push(`runtime file is not readable: ${relativePath}`);
    return null;
  }
  if (!stats.isFile()) {
    errors.push(`runtime path is not a file: ${relativePath}`);
    return null;
  }
  if ((stats.mode & 0o444) === 0) {
    errors.push(`runtime file has no read permission: ${relativePath}`);
    return null;
  }
  return absolutePath;
}

function localAssetReferences(indexHtml) {
  const references = [];
  const patterns = [
    /<script\b[^>]*\bsrc=["']([^"']+)["']/gi,
    /<link\b[^>]*\bhref=["']([^"']+)["']/gi
  ];
  for (const pattern of patterns) {
    for (const match of indexHtml.matchAll(pattern)) {
      const reference = match[1].split(/[?#]/, 1)[0];
      if (!reference || /^(?:[a-z][a-z\d+.-]*:|\/\/|data:)/i.test(reference)) continue;
      if (/\.(?:js|css)$/i.test(reference)) references.push(reference);
    }
  }
  return [...new Set(references)];
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function workspaceBinDirectories(root) {
  const directories = [];
  const visited = new Set();

  function walk(directory) {
    const resolvedDirectory = path.resolve(directory);
    if (visited.has(resolvedDirectory)) return;
    visited.add(resolvedDirectory);

    let entries;
    try {
      entries = readdirSync(resolvedDirectory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const child = path.join(resolvedDirectory, entry.name);
      if (entry.name === 'node_modules') {
        const binDirectory = path.join(child, '.bin');
        try {
          if (lstatSync(binDirectory).isDirectory()) directories.push(binDirectory);
        } catch {
          // A workspace without a .bin directory is valid.
        }
        // Package internals are not workspace entrypoints. Their exposed
        // commands are represented by this .bin directory.
        continue;
      }
      walk(child);
    }
  }

  walk(root);
  return directories;
}

function resolveExecutableEntry(root, binDirectory, entryName) {
  const entryPath = path.join(binDirectory, entryName);
  let entryStats;
  try {
    entryStats = lstatSync(entryPath);
  } catch {
    throw new Error(`runtime executable is missing: ${path.relative(root, entryPath)}`);
  }
  let targetPath = entryPath;
  if (entryStats.isSymbolicLink()) {
    try {
      targetPath = realpathSync(entryPath);
    } catch {
      throw new Error(`runtime executable symlink is broken: ${path.relative(root, entryPath)}`);
    }
  }
  targetPath = path.resolve(targetPath);
  if (!inside(root, targetPath)) {
    throw new Error(`runtime executable escapes Release: ${path.relative(root, entryPath)}`);
  }
  let targetStats;
  try {
    targetStats = statSync(targetPath);
  } catch {
    throw new Error(`runtime executable target is missing: ${path.relative(root, entryPath)}`);
  }
  if (!targetStats.isFile()) {
    throw new Error(`runtime executable target is not a file: ${path.relative(root, entryPath)}`);
  }
  return { entryPath, entryStats, targetPath, targetStats };
}

function executableEntries(root) {
  const entries = [];
  for (const binDirectory of workspaceBinDirectories(root)) {
    for (const entryName of readdirSync(binDirectory)) {
      entries.push(resolveExecutableEntry(root, binDirectory, entryName));
    }
  }
  return entries;
}

/**
 * Package managers can preserve a non-executable mode from the dependency
 * source. Normalize every exposed workspace command, not a provider-specific
 * filename, before the copied Release is built.
 */
export function normalizeExecutableRuntimeEntries(releaseRoot) {
  const root = normalizedRoot(releaseRoot);
  for (const { entryPath, entryStats, targetPath, targetStats } of executableEntries(root)) {
    if ((targetStats.mode & 0o111) === 0) chmodSync(targetPath, targetStats.mode | 0o111);
    if (!entryStats.isSymbolicLink() && (entryStats.mode & 0o111) === 0) {
      chmodSync(entryPath, entryStats.mode | 0o111);
    }
  }
  return root;
}

function verifyExecutableRuntimeEntries(root, errors) {
  let entries;
  try {
    entries = executableEntries(root);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return;
  }
  for (const { entryPath, entryStats, targetPath, targetStats } of entries) {
    const relativeEntry = path.relative(root, entryPath);
    if ((targetStats.mode & 0o111) === 0 || (!entryStats.isSymbolicLink() && (entryStats.mode & 0o111) === 0)) {
      errors.push(`runtime executable lacks execute permission: ${relativeEntry}`);
      continue;
    }
    try {
      accessSync(targetPath, constants.X_OK);
    } catch {
      errors.push(`runtime executable is not executable: ${relativeEntry}`);
    }
  }
}

function verifyReleaseManifest(root, errors) {
  const manifestPath = path.join(root, 'release-runtime.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    errors.push('release-runtime.json is not valid JSON');
    return;
  }
  if (manifest?.schema_version !== RELEASE_RUNTIME_MANIFEST_SCHEMA || manifest.gitless_runtime !== true) {
    errors.push('release-runtime.json has an unsupported schema');
    return;
  }
  if (manifest.canonical_state_file !== CANONICAL_STATE_FILE) {
    errors.push(`release-runtime.json must reference ${CANONICAL_STATE_FILE}`);
    return;
  }
  const statePath = assertReadableFile(root, manifest.canonical_state_file, errors);
  if (!statePath) return;
  const stateDocument = readFileSync(statePath);
  const metadataMatch = stateDocument.toString('utf8').match(/<!-- AI_WORK_SECRETARY_PROJECT_STATE_METADATA_START -->\n```json\n([\s\S]*?)\n```\n<!-- AI_WORK_SECRETARY_PROJECT_STATE_METADATA_END -->/);
  let stateMetadata = null;
  try {
    stateMetadata = metadataMatch ? JSON.parse(metadataMatch[1]) : null;
  } catch {
    errors.push('canonical project-state metadata is not valid JSON');
  }
  if (!stateMetadata) errors.push('canonical project-state metadata is missing');
  if (!/^[0-9a-f]{64}$/.test(manifest.canonical_state_sha256 || '') ||
      manifest.canonical_state_sha256 !== createHash('sha256').update(stateDocument).digest('hex')) {
    errors.push('release-runtime.json canonical state digest mismatch');
  }
  const stateToken = `aiwc-project-state-document-v1-sha256:${createHash('sha256').update(stateDocument).digest('hex')}`;
  if (manifest.canonical_state_token !== stateToken) {
    errors.push('release-runtime.json canonical state token mismatch');
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.release_head || '')) {
    errors.push('release-runtime.json release_head is invalid');
  }
  if (!Number.isSafeInteger(manifest.checkpoint_generation) || manifest.checkpoint_generation < 0) {
    errors.push('release-runtime.json checkpoint_generation is invalid');
  } else if (stateMetadata && stateMetadata.checkpoint_generation !== manifest.checkpoint_generation) {
    errors.push('release-runtime.json checkpoint_generation does not match canonical state');
  }
}

export function verifyRuntimeAssets(releaseRoot) {
  const root = normalizedRoot(releaseRoot);
  const errors = [];
  const files = [];
  if (existsSync(path.join(root, '.git'))) {
    errors.push('Release must not depend on .git metadata');
  }
  for (const relativePath of REQUIRED_FILES) {
    const absolutePath = assertReadableFile(root, relativePath, errors);
    if (absolutePath) files.push({ path: relativePath, bytes: statSync(absolutePath).size, sha256: sha256(absolutePath) });
  }

  if (existsSync(path.join(root, 'release-runtime.json'))) {
    verifyReleaseManifest(root, errors);
  }

  verifyExecutableRuntimeEntries(root, errors);

  const distRoot = path.join(root, 'apps/desktop/dist');
  const assetsRoot = path.join(distRoot, 'assets');
  if (!existsSync(assetsRoot) || !statSync(assetsRoot).isDirectory()) {
    errors.push('missing runtime directory: apps/desktop/dist/assets');
  } else if (!readdirSync(assetsRoot).some((entry) => statSync(path.join(assetsRoot, entry)).isFile())) {
    errors.push('runtime directory is empty: apps/desktop/dist/assets');
  }

  const indexPath = path.join(distRoot, 'index.html');
  if (existsSync(indexPath) && statSync(indexPath).isFile()) {
    const references = localAssetReferences(readFileSync(indexPath, 'utf8'));
    if (references.length === 0) errors.push('index.html has no local JavaScript or CSS asset references');
    for (const reference of references) {
      const relativePath = reference.startsWith('/')
        ? path.posix.normalize(path.posix.join('apps/desktop/dist', reference.slice(1)))
        : path.posix.normalize(path.posix.join('apps/desktop/dist', reference));
      const absolutePath = assertReadableFile(root, relativePath, errors, distRoot);
      if (absolutePath) files.push({ path: relativePath, bytes: statSync(absolutePath).size, sha256: sha256(absolutePath) });
    }
  }

  return {
    ok: errors.length === 0,
    releaseRoot: root,
    files,
    errors
  };
}

function parseReleaseRoot(argv) {
  const index = argv.indexOf('--release-root');
  if (index === -1 || !argv[index + 1]) throw new Error('Usage: node verifyRuntimeAssets.mjs --release-root <path>');
  return argv[index + 1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const result = verifyRuntimeAssets(parseReleaseRoot(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
