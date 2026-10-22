import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeExecutableRuntimeEntries, verifyRuntimeAssets } from './verifyRuntimeAssets.mjs';

function argument(argv, name, { required = true, fallback = null } = {}) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) {
    if (required) throw new Error(`${name} is required.`);
    return fallback;
  }
  return argv[index + 1];
}

function copyRuntimeDependencies(sourceRoot, destinationRoot) {
  for (const relativePath of ['node_modules', 'apps/desktop/node_modules']) {
    const sourcePath = path.join(sourceRoot, relativePath);
    if (!existsSync(sourcePath)) throw new Error(`missing dependency tree: ${sourcePath}`);
    const destinationPath = path.join(destinationRoot, relativePath);
    mkdirSync(path.dirname(destinationPath), { recursive: true });
    execFileSync('cp', ['-a', sourcePath, destinationPath], { stdio: 'inherit' });
  }
}

function writeReleaseRuntimeManifest(destinationRoot, releaseHead) {
  const statePath = path.join(destinationRoot, 'AI_WORK_SECRETARY_PROJECT_STATE.md');
  const stateDocument = readFileSync(statePath, 'utf8');
  const stateDigest = createHash('sha256').update(stateDocument).digest('hex');
  const metadataMatch = stateDocument.match(/<!-- AI_WORK_SECRETARY_PROJECT_STATE_METADATA_START -->\n```json\n([\s\S]*?)\n```\n<!-- AI_WORK_SECRETARY_PROJECT_STATE_METADATA_END -->/);
  if (!metadataMatch) throw new Error('canonical project-state metadata is missing from Release.');
  const state = JSON.parse(metadataMatch[1]);
  writeFileSync(path.join(destinationRoot, 'release-runtime.json'), `${JSON.stringify({
    schema_version: 1,
    gitless_runtime: true,
    release_head: releaseHead,
    checkpoint_generation: state.checkpoint_generation,
    canonical_state_file: 'AI_WORK_SECRETARY_PROJECT_STATE.md',
    canonical_state_sha256: stateDigest,
    canonical_state_token: `aiwc-project-state-document-v1-sha256:${stateDigest}`
  }, null, 2)}\n`, { mode: 0o444 });
}

export function assembleRelease({ source, destination, branch, dependenciesSource = source, manifest = null }) {
  const sourceRoot = path.resolve(source);
  const destinationRoot = path.resolve(destination);
  if (existsSync(destinationRoot)) throw new Error(`destination already exists: ${destinationRoot}`);
  mkdirSync(path.dirname(destinationRoot), { recursive: true });
  try {
    execFileSync('git', [
      'clone', '--no-local', '--branch', branch, '--single-branch', sourceRoot, destinationRoot
    ], { stdio: 'inherit' });
    copyRuntimeDependencies(path.resolve(dependenciesSource), destinationRoot);
    normalizeExecutableRuntimeEntries(destinationRoot);
    // Use the repository's workspace build script directly. Running `pnpm build`
    // inside a copied workspace can rewrite node_modules when its install state
    // still points at the source checkout; the Release must be built from the
    // copied dependency tree, without an implicit network install.
    execFileSync('npm', ['run', 'build', '-w', 'apps/desktop'], {
      cwd: destinationRoot,
      stdio: 'inherit',
      env: { ...process.env, CI: '1' }
    });
    const status = execFileSync('git', ['-C', destinationRoot, 'status', '--short'], { encoding: 'utf8' });
    if (status.trim()) throw new Error(`Release worktree is not clean: ${status.trim()}`);
    const head = execFileSync('git', ['-C', destinationRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeReleaseRuntimeManifest(destinationRoot, head);
    rmSync(path.join(destinationRoot, '.git'), { recursive: true, force: true });
    const runtime = verifyRuntimeAssets(destinationRoot);
    if (!runtime.ok) throw new Error(`Release runtime asset gate failed: ${runtime.errors.join(' ')}`);
    const result = {
      releaseRoot: destinationRoot,
      head,
      runtime
    };
    if (manifest) writeFileSync(path.resolve(manifest), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  } catch (error) {
    rmSync(destinationRoot, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const argv = process.argv.slice(2);
  const result = assembleRelease({
    source: argument(argv, '--source'),
    destination: argument(argv, '--destination'),
    branch: argument(argv, '--branch'),
    dependenciesSource: argument(argv, '--dependencies-source', { required: false, fallback: argument(argv, '--source') }),
    manifest: argument(argv, '--manifest', { required: false })
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
