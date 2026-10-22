import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHECKPOINT_RECOVERY_REQUIRED,
  getCheckpointTransactionPaths,
  inspectCheckpointTransaction,
  recoverCheckpointTransaction,
  runCheckpointTransaction
} from './checkpointTransaction.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'checkpointTransactionChild.js');

function git(repoRoot, ...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function fixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-transaction-test-'));
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'fixture@example.invalid');
  git(repoRoot, 'config', 'user.name', 'Checkpoint Fixture');
  const statePath = path.join(repoRoot, 'state.json');
  fs.writeFileSync(statePath, '{\n  "generation": 0,\n  "value": "original"\n}\n');
  git(repoRoot, 'add', 'state.json');
  git(repoRoot, 'commit', '-m', 'fixture');
  return { repoRoot, statePath, original: fs.readFileSync(statePath) };
}

function token(content) {
  return `fixture-sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function parse(content) {
  return JSON.parse(Buffer.from(content).toString('utf8'));
}

function options(f, overrides = {}) {
  return {
    repoRoot: f.repoRoot,
    statePath: f.statePath,
    expectedStateToken: token(f.original),
    expectedGeneration: 0,
    tokenForBytes: token,
    generationForBytes: (bytes) => parse(bytes).generation,
    createCandidate: () => Buffer.from('{"generation":1,"value":"candidate"}\n'),
    validateCandidate: (candidatePath) => parse(fs.readFileSync(candidatePath)),
    validateInstalled: () => parse(fs.readFileSync(f.statePath)),
    validateRestored: () => assert.deepEqual(fs.readFileSync(f.statePath), f.original),
    ...overrides
  };
}

function recover(f, overrides = {}) {
  return recoverCheckpointTransaction({
    repoRoot: f.repoRoot,
    statePath: f.statePath,
    validateCanonical: () => parse(fs.readFileSync(f.statePath)),
    ...overrides
  });
}

function childArgs(f, value, behavior = 'none', phase = 'none', delay = 0) {
  return [CHILD, f.repoRoot, f.statePath, token(f.original), '0', value, behavior, phase, String(delay)];
}

function runChild(f, value, behavior, phase) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, childArgs(f, value, behavior, phase), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('successful transaction durably installs candidate and removes all artifacts', () => {
  const f = fixture();
  const result = runCheckpointTransaction(options(f));
  assert.deepEqual(result, { generation: 1, value: 'candidate' });
  assert.deepEqual(parse(fs.readFileSync(f.statePath)), result);
  assert.deepEqual(inspectCheckpointTransaction(f.repoRoot).artifacts, []);
});

test('successful transaction preserves the canonical regular-file mode', () => {
  const f = fixture();
  fs.chmodSync(f.statePath, 0o640);
  runCheckpointTransaction(options(f));
  assert.equal(fs.statSync(f.statePath).mode & 0o777, 0o640);
});

test('checkpoint rejects a canonical symlink without replacing either path', () => {
  const f = fixture();
  const targetPath = path.join(f.repoRoot, 'target.json');
  fs.renameSync(f.statePath, targetPath);
  fs.symlinkSync('target.json', f.statePath);
  const targetBefore = fs.readFileSync(targetPath);
  assert.throws(() => runCheckpointTransaction(options(f)), /regular file|symbolic link|symlink/i);
  assert.equal(fs.lstatSync(f.statePath).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(targetPath), targetBefore);
});

test('checkpoint rejects a state path outside the repository', () => {
  const f = fixture();
  const outside = path.join(os.tmpdir(), `outside-state-${crypto.randomUUID()}.json`);
  fs.writeFileSync(outside, f.original);
  assert.throws(() => runCheckpointTransaction(options({ ...f, statePath: outside })), /repository/i);
  assert.deepEqual(fs.readFileSync(outside), f.original);
});

for (const phase of [
  'after-original-backup-durable',
  'after-candidate-durable',
  'after-candidate-validation',
  'after-journal-durable',
  'after-canonical-rename',
  'before-canonical-directory-fsync',
  'after-canonical-directory-fsync',
  'after-installed-journal-durable',
  'after-installed-validation',
  'after-verified-journal-durable'
]) {
  test(`caught failure at ${phase} restores exact original bytes and cleans artifacts`, () => {
    const f = fixture();
    assert.throws(() => runCheckpointTransaction(options(f, {
      faultInjector: (actual) => {
        if (actual === phase) throw new Error(`fault at ${phase}`);
      }
    })), /rollback completed|fault/);
    assert.deepEqual(fs.readFileSync(f.statePath), f.original);
    assert.deepEqual(inspectCheckpointTransaction(f.repoRoot).artifacts, []);
  });
}

test('rollback uncertainty remains recovery-required and preserves durable recovery artifacts', () => {
  const f = fixture();
  assert.throws(() => runCheckpointTransaction(options(f, {
    faultInjector: (phase) => {
      if (phase === 'after-canonical-rename' || phase === 'after-rollback-directory-fsync') {
        throw new Error(`fault at ${phase}`);
      }
    }
  })), new RegExp(CHECKPOINT_RECOVERY_REQUIRED));
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, true);
  const outcome = recover(f);
  assert.equal(outcome.outcome, 'ORIGINAL_RESTORED');
  assert.deepEqual(fs.readFileSync(f.statePath), f.original);
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, false);
});

test('failure after durable commit decision is recovery-required and recovery finalizes the candidate', () => {
  const f = fixture();
  assert.throws(() => runCheckpointTransaction(options(f, {
    faultInjector: (phase) => {
      if (phase === 'after-commit-decision-durable') throw new Error('cleanup crash');
    }
  })), new RegExp(CHECKPOINT_RECOVERY_REQUIRED));
  assert.deepEqual(parse(fs.readFileSync(f.statePath)), { generation: 1, value: 'candidate' });
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, true);
  assert.equal(recover(f).outcome, 'ORPHANS_CLEANED');
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, false);
});

for (const [phase, expectedOutcome, expectedValue] of [
  ['after-original-backup-durable', 'ORPHANS_CLEANED', 'original'],
  ['after-candidate-durable', 'ORPHANS_CLEANED', 'original'],
  ['after-journal-durable', 'ORIGINAL_RESTORED', 'original'],
  ['after-canonical-rename', 'ORIGINAL_RESTORED', 'original'],
  ['after-canonical-directory-fsync', 'ORIGINAL_RESTORED', 'original'],
  ['after-installed-journal-durable', 'ORIGINAL_RESTORED', 'original'],
  ['after-installed-validation', 'ORIGINAL_RESTORED', 'original'],
  ['after-verified-journal-durable', 'VERIFIED_COMMIT_FINALIZED', 'crash-candidate'],
  ['after-commit-decision-durable', 'ORPHANS_CLEANED', 'crash-candidate']
]) {
  test(`process crash at ${phase} is fail-closed and explicitly recoverable`, async () => {
    const f = fixture();
    const crashed = await runChild(f, 'crash-candidate', 'crash', phase);
    assert.equal(crashed.code, 86);
    assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, true);
    const recovery = recover(f);
    assert.equal(recovery.outcome, expectedOutcome);
    assert.equal(parse(fs.readFileSync(f.statePath)).value, expectedValue);
    assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, false);
  });
}

test('explicit recovery is idempotent after a completed recovery', async () => {
  const f = fixture();
  const crashed = await runChild(f, 'candidate', 'crash', 'after-canonical-rename');
  assert.equal(crashed.code, 86);
  assert.equal(recover(f).outcome, 'ORIGINAL_RESTORED');
  assert.equal(recover(f).outcome, 'NO_RECOVERY_NEEDED');
});

test('explicit recovery refuses a fresh ownerless lock acquisition window', () => {
  const f = fixture();
  const paths = getCheckpointTransactionPaths(f.repoRoot);
  fs.mkdirSync(paths.lock, { recursive: true });
  assert.throws(() => recover(f), /LOCKED|lock/i);
  assert.equal(fs.existsSync(paths.lock), true);
});

test('explicit recovery can remove an old ownerless stale lock', () => {
  const f = fixture();
  const paths = getCheckpointTransactionPaths(f.repoRoot);
  fs.mkdirSync(paths.lock, { recursive: true });
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(paths.lock, old, old);
  assert.equal(recover(f).outcome, 'NO_RECOVERY_NEEDED');
  assert.equal(fs.existsSync(paths.lock), false);
});

test('explicit recovery refuses a lock owned by a live local process', () => {
  const f = fixture();
  const paths = getCheckpointTransactionPaths(f.repoRoot);
  fs.mkdirSync(paths.lock, { recursive: true });
  fs.writeFileSync(paths.owner, `${JSON.stringify({ pid: process.pid, hostname: os.hostname() })}\n`);
  assert.throws(() => recover(f), /LOCKED|still active/i);
  assert.equal(fs.existsSync(paths.lock), true);
});

test('damaged journal fails closed without changing canonical bytes', () => {
  const f = fixture();
  const paths = getCheckpointTransactionPaths(f.repoRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.journal, '{broken');
  assert.throws(() => recover(f), new RegExp(CHECKPOINT_RECOVERY_REQUIRED));
  assert.deepEqual(fs.readFileSync(f.statePath), f.original);
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, true);
});

test('explicit recovery durably cleans a known orphan journal temporary file', () => {
  const f = fixture();
  const paths = getCheckpointTransactionPaths(f.repoRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  const temporary = path.join(paths.root, '.transaction.json.fixture.00000000-0000-4000-8000-000000000000.tmp');
  fs.writeFileSync(temporary, 'partial');
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, true);
  assert.equal(recover(f).outcome, 'ORPHANS_CLEANED');
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, false);
});

test('unexpected transaction-root entries block resume and recovery', () => {
  const f = fixture();
  const paths = getCheckpointTransactionPaths(f.repoRoot);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(path.join(paths.root, 'unexpected-entry'), 'do not delete');
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, true);
  assert.throws(() => recover(f), new RegExp(CHECKPOINT_RECOVERY_REQUIRED));
  assert.equal(fs.readFileSync(path.join(paths.root, 'unexpected-entry'), 'utf8'), 'do not delete');
});

test('journal transaction ID is strictly validated before recovery path construction', async () => {
  const f = fixture();
  const crashed = await runChild(f, 'candidate', 'crash', 'after-canonical-rename');
  assert.equal(crashed.code, 86);
  const paths = getCheckpointTransactionPaths(f.repoRoot);
  const journal = JSON.parse(fs.readFileSync(paths.journal, 'utf8'));
  journal.transaction_id = '../../escape';
  fs.writeFileSync(paths.journal, `${JSON.stringify(journal)}\n`);
  assert.throws(() => recover(f), new RegExp(CHECKPOINT_RECOVERY_REQUIRED));
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, true);
});

test('missing durable original backup fails closed without accepting candidate', async () => {
  const f = fixture();
  const crashed = await runChild(f, 'candidate', 'crash', 'after-canonical-rename');
  assert.equal(crashed.code, 86);
  const paths = getCheckpointTransactionPaths(f.repoRoot);
  fs.unlinkSync(paths.original);
  assert.throws(() => recover(f), new RegExp(CHECKPOINT_RECOVERY_REQUIRED));
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, true);
});

test('crash rollback restores the original file mode as well as bytes', async () => {
  const f = fixture();
  fs.chmodSync(f.statePath, 0o640);
  f.original = fs.readFileSync(f.statePath);
  const crashed = await runChild(f, 'candidate', 'crash', 'after-canonical-rename');
  assert.equal(crashed.code, 86);
  assert.equal(recover(f).outcome, 'ORIGINAL_RESTORED');
  assert.deepEqual(fs.readFileSync(f.statePath), f.original);
  assert.equal(fs.statSync(f.statePath).mode & 0o777, 0o640);
});

test('two concurrent writers using the same CAS token cannot both succeed', async () => {
  const f = fixture();
  const first = runChild(f, 'first', 'delay', 'after-journal-durable');
  const lockPath = getCheckpointTransactionPaths(f.repoRoot).lock;
  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(lockPath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(lockPath), true, 'first writer did not acquire the lock');
  const second = runChild(f, 'second', 'none', 'none');
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.code === 0).length, 1, JSON.stringify(results));
  assert.equal(parse(fs.readFileSync(f.statePath)).generation, 1);
  assert.equal(inspectCheckpointTransaction(f.repoRoot).pending, false);
});

test('a second sequential writer with stale CAS cannot overwrite generation one', () => {
  const f = fixture();
  runCheckpointTransaction(options(f));
  const committed = fs.readFileSync(f.statePath);
  assert.throws(() => runCheckpointTransaction(options(f)), /stale state token|stale generation/i);
  assert.deepEqual(fs.readFileSync(f.statePath), committed);
});
