import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  CANONICAL_STATE_FILE,
  collectWorkingTreeSnapshot,
  parseProjectStateDocument,
  renderProjectStateDocument,
  validateProjectState
} from './projectState.js';

function git(repoRoot, args, options = {}) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: options.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function currentBranch(repoRoot) {
  return String(git(repoRoot, ['branch', '--show-current'])).trim();
}

function resolveBranchHead(repoRoot, branch) {
  try {
    return String(git(repoRoot, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim();
  } catch {
    throw new Error(`Target branch does not exist: ${branch}.`);
  }
}

function assertBranchName(repoRoot, branch) {
  if (!String(branch || '').trim()) throw new Error('--to target branch is required.');
  try {
    git(repoRoot, ['check-ref-format', '--branch', branch]);
  } catch {
    throw new Error(`Target branch name is invalid: ${branch}.`);
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeSynced(filePath, bytes, mode) {
  const descriptor = fs.openSync(filePath, 'wx', mode);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function atomicInstallWithRollback(statePath, original, candidate, faultInjector = () => {}) {
  const directory = path.dirname(statePath);
  const originalMode = fs.statSync(statePath).mode & 0o777;
  const nonce = crypto.randomBytes(8).toString('hex');
  const temporary = `${statePath}.branch-transition-${process.pid}-${nonce}.tmp`;
  const rollback = `${statePath}.branch-transition-${process.pid}-${nonce}.rollback`;
  let installed = false;
  try {
    writeSynced(temporary, candidate, originalMode);
    faultInjector('before-install');
    fs.renameSync(temporary, statePath);
    installed = true;
    fsyncDirectory(directory);
    faultInjector('after-install');
  } catch (error) {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    if (installed) {
      writeSynced(rollback, original, originalMode);
      fs.renameSync(rollback, statePath);
      fsyncDirectory(directory);
    } else if (fs.existsSync(rollback)) {
      fs.unlinkSync(rollback);
    }
    throw error;
  }
}

function cleanValidation(repoRoot, statePath) {
  const restored = validateProjectState({ repoRoot, statePath });
  if (!restored.ok) {
    if (restored.errors.some((error) => error.includes('working_tree'))) {
      throw new Error(`Working tree must be completely clean. ${restored.errors.join(' ')}`);
    }
    throw new Error(`Canonical project state is not restored: ${restored.errors.join(' ')}`);
  }
  const status = git(repoRoot, ['status', '--porcelain=v1', '-z'], { encoding: null });
  if (status.length !== 0) throw new Error('Working tree must be completely clean, including staged and untracked files.');
  return restored;
}

export function transitionVerifiedBranch({
  repoRoot,
  targetBranch,
  dryRun = false,
  now = new Date(),
  faultInjector = () => {}
} = {}) {
  if (!repoRoot) throw new Error('Repository root is required.');
  assertBranchName(repoRoot, targetBranch);
  const statePath = path.join(repoRoot, CANONICAL_STATE_FILE);
  const restored = cleanValidation(repoRoot, statePath);
  const branch = currentBranch(repoRoot);
  if (!branch) throw new Error('Detached HEAD is not supported.');
  if (branch !== restored.state.verified_branch) throw new Error('Current branch must equal the canonical verified branch.');
  if (branch === targetBranch) throw new Error('Target branch must be different from the current branch.');

  const head = String(git(repoRoot, ['rev-parse', 'HEAD'])).trim();
  const targetHead = resolveBranchHead(repoRoot, targetBranch);
  if (targetHead !== head) throw new Error('Target branch must point to the same HEAD as the current branch.');

  const snapshot = collectWorkingTreeSnapshot(repoRoot, [CANONICAL_STATE_FILE]);
  if (snapshot.state !== 'clean' || snapshot.entries.length !== 0) {
    throw new Error('Working-tree fingerprint must be clean before branch transition.');
  }
  const currentAction = JSON.stringify(restored.state.current_engineering_action);
  const nextAction = JSON.stringify(restored.state.next_product_action_after_stabilization);
  const state = {
    ...structuredClone(restored.state),
    checkpoint_generation: restored.state.checkpoint_generation + 1,
    verified_at: now.toISOString(),
    verified_branch: targetBranch,
    verified_base_commit: head,
    working_tree: {
      ...structuredClone(restored.state.working_tree),
      state: snapshot.state,
      entries: snapshot.entries,
      fingerprint: snapshot.fingerprint,
      excluded_paths: [CANONICAL_STATE_FILE]
    },
    updated_by: `project:transition-branch ${branch} -> ${targetBranch}`
  };
  if (JSON.stringify(state.current_engineering_action) !== currentAction) throw new Error('Current action changed during transition.');
  if (JSON.stringify(state.next_product_action_after_stabilization) !== nextAction) throw new Error('Next action changed during transition.');

  const document = renderProjectStateDocument(state);
  const reparsed = parseProjectStateDocument(document);
  if (JSON.stringify(reparsed) !== JSON.stringify(state)) throw new Error('Transition candidate failed deterministic round-trip validation.');
  if (!dryRun) {
    const original = fs.readFileSync(statePath);
    atomicInstallWithRollback(statePath, original, Buffer.from(document), faultInjector);
  }
  return {
    ok: true,
    dryRun: Boolean(dryRun),
    fromBranch: branch,
    targetBranch,
    head,
    generationBefore: restored.state.checkpoint_generation,
    generationAfter: state.checkpoint_generation,
    fingerprint: state.working_tree.fingerprint,
    state,
    nextCommand: `git switch ${targetBranch}`
  };
}
