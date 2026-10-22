import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { collectWorkingTreeSnapshot } from './projectState.js';

const THIS_FILE = fileURLToPath(import.meta.url);

function git(repoRoot, ...args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function createRepository(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'working-tree-fingerprint-test-'));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  git(repoRoot, 'init', '-b', 'main');
  git(repoRoot, 'config', 'user.email', 'fixture@example.invalid');
  git(repoRoot, 'config', 'user.name', 'Working Tree Fixture');
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n');
  git(repoRoot, 'add', '.');
  git(repoRoot, 'commit', '-m', 'fixture baseline');
  return repoRoot;
}

function write(repoRoot, relativePath, content) {
  const absolutePath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);
  return absolutePath;
}

function valueOf(snapshot) {
  return typeof snapshot.fingerprint === 'string' ? snapshot.fingerprint : snapshot.fingerprint.value;
}

function assertUntrackedContentChangeDetected(t, relativePath) {
  const repoRoot = createRepository(t);
  write(repoRoot, relativePath, 'first\n');
  const before = valueOf(collectWorkingTreeSnapshot(repoRoot));
  write(repoRoot, relativePath, 'second\n');
  const after = valueOf(collectWorkingTreeSnapshot(repoRoot));
  assert.notEqual(after, before, `content drift was not detected for ${JSON.stringify(relativePath)}`);
}

if (process.env.FINGERPRINT_HELPER_REPO) {
  process.stdout.write(`${valueOf(collectWorkingTreeSnapshot(process.env.FINGERPRINT_HELPER_REPO))}\n`);
} else {
  test('fingerprint declares the complete v2 serialization algorithm ID', (t) => {
    const snapshot = collectWorkingTreeSnapshot(createRepository(t));
    assert.deepEqual(
      { version: snapshot.fingerprint.version, algorithm: snapshot.fingerprint.algorithm },
      { version: 2, algorithm: 'aiwc-working-tree-fingerprint-v2-sha256' }
    );
    assert.match(snapshot.fingerprint.value, /^[0-9a-f]{64}$/);
  });

  test('untracked filename containing spaces is hashed by actual path bytes', (t) => {
    assertUntrackedContentChangeDetected(t, 'file with spaces.txt');
  });

  test('untracked Chinese filename is hashed by actual path bytes', (t) => {
    assertUntrackedContentChangeDetected(t, '中文文件.txt');
  });

  test('untracked Unicode filename is hashed by actual path bytes', (t) => {
    assertUntrackedContentChangeDetected(t, 'résumé-🧠.txt');
  });

  test('untracked filename containing a newline is NUL-safe and counted once', (t) => {
    const repoRoot = createRepository(t);
    const relativePath = 'line\nbreak.txt';
    write(repoRoot, relativePath, 'first\n');
    const before = collectWorkingTreeSnapshot(repoRoot);
    write(repoRoot, relativePath, 'second\n');
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.equal(before.entries.length, 1);
    assert.equal(after.entries.length, 1);
    assert.notEqual(valueOf(after), valueOf(before));
  });

  test('untracked regular-file executable bit changes the fingerprint', (t) => {
    const repoRoot = createRepository(t);
    const absolutePath = write(repoRoot, 'executable-tool', '#!/bin/sh\nexit 0\n');
    fs.chmodSync(absolutePath, 0o644);
    const before = valueOf(collectWorkingTreeSnapshot(repoRoot));
    fs.chmodSync(absolutePath, 0o755);
    const after = valueOf(collectWorkingTreeSnapshot(repoRoot));
    assert.notEqual(after, before);
  });

  test('only the exact canonical path is excluded and a similar name is detected', (t) => {
    const repoRoot = createRepository(t);
    write(repoRoot, 'AI_WORK_SECRETARY_PROJECT_STATE.md', 'canonical first\n');
    write(repoRoot, 'AI_WORK_SECRETARY_PROJECT_STATE.md.backup', 'backup first\n');
    const before = collectWorkingTreeSnapshot(repoRoot);
    write(repoRoot, 'AI_WORK_SECRETARY_PROJECT_STATE.md', 'canonical second\n');
    const canonicalOnly = collectWorkingTreeSnapshot(repoRoot);
    assert.equal(valueOf(canonicalOnly), valueOf(before));
    write(repoRoot, 'AI_WORK_SECRETARY_PROJECT_STATE.md.backup', 'backup second\n');
    const similarName = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(similarName), valueOf(canonicalOnly));
    assert.equal(similarName.entries.length, 1);
  });

  test('locale changes cannot change path ordering or fingerprint', (t) => {
    const repoRoot = createRepository(t);
    write(repoRoot, 'z.txt', 'z\n');
    write(repoRoot, 'ä.txt', 'a umlaut\n');
    const run = (locale) => spawnSync(process.execPath, [THIS_FILE], {
      encoding: 'utf8',
      env: { ...process.env, LANG: locale, LC_ALL: locale, FINGERPRINT_HELPER_REPO: repoRoot }
    });
    const english = run('en_US.UTF-8');
    const swedish = run('sv_SE.UTF-8');
    assert.equal(english.status, 0, english.stderr);
    assert.equal(swedish.status, 0, swedish.stderr);
    assert.equal(english.stdout.trim(), swedish.stdout.trim());
  });

  test('production path ordering uses raw bytes instead of localeCompare', () => {
    const projectStateSource = fs.readFileSync(path.join(path.dirname(THIS_FILE), 'projectState.js'), 'utf8');
    const modulePath = path.join(path.dirname(THIS_FILE), 'workingTreeFingerprint.js');
    const fingerprintSource = fs.existsSync(modulePath) ? fs.readFileSync(modulePath, 'utf8') : '';
    assert.doesNotMatch(`${projectStateSource}\n${fingerprintSource}`, /\.localeCompare\s*\(/);
  });

  test('production Git path parsing stays Buffer-based, NUL-delimited, and shell-free', () => {
    const source = fs.readFileSync(path.join(path.dirname(THIS_FILE), 'workingTreeFingerprint.js'), 'utf8');
    assert.match(source, /encoding:\s*'buffer'/);
    assert.match(source, /'--stage',\s*'-z'/);
    assert.match(source, /'--exclude-standard',\s*'-z'/);
    assert.doesNotMatch(source, /shell:\s*true|\.split\(\s*['"`]\\r?\\n|execSync\s*\(/);
  });

  test('ignored files do not affect entries or fingerprint', (t) => {
    const repoRoot = createRepository(t);
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'ignored/\n');
    git(repoRoot, 'add', '.gitignore');
    git(repoRoot, 'commit', '-m', 'ignore fixture');
    write(repoRoot, 'ignored/cache.bin', Buffer.from([0, 1, 2, 3]));
    const before = collectWorkingTreeSnapshot(repoRoot);
    write(repoRoot, 'ignored/cache.bin', Buffer.from([4, 5, 6, 7]));
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.equal(before.entries.length, 0);
    assert.equal(after.entries.length, 0);
    assert.equal(valueOf(after), valueOf(before));
  });

  test('repeated snapshots and a fresh clone produce the same clean fingerprint', (t) => {
    const repoRoot = createRepository(t);
    const cloneRoot = `${repoRoot}-clone`;
    t.after(() => fs.rmSync(cloneRoot, { recursive: true, force: true }));
    const first = collectWorkingTreeSnapshot(repoRoot);
    const second = collectWorkingTreeSnapshot(repoRoot);
    execFileSync('git', ['clone', '--quiet', repoRoot, cloneRoot], { stdio: 'pipe' });
    const cloned = collectWorkingTreeSnapshot(cloneRoot);
    assert.deepEqual(second, first);
    assert.deepEqual(cloned, first);
  });

  test('unstaged tracked content drift changes the fingerprint and has one entry', (t) => {
    const repoRoot = createRepository(t);
    const before = collectWorkingTreeSnapshot(repoRoot);
    write(repoRoot, 'README.md', '# unstaged drift\n');
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(after), valueOf(before));
    assert.deepEqual(after.entries, [{
      kind: 'tracked',
      path_encoding: 'base64',
      path: Buffer.from('README.md').toString('base64')
    }]);
  });

  test('staged tracked content drift changes the fingerprint and has one entry', (t) => {
    const repoRoot = createRepository(t);
    const before = collectWorkingTreeSnapshot(repoRoot);
    write(repoRoot, 'README.md', '# staged drift\n');
    git(repoRoot, 'add', 'README.md');
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(after), valueOf(before));
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].kind, 'tracked');
  });

  test('staged added file changes the fingerprint and is one tracked entry', (t) => {
    const repoRoot = createRepository(t);
    const before = collectWorkingTreeSnapshot(repoRoot);
    write(repoRoot, 'staged addition.txt', 'added\n');
    git(repoRoot, 'add', 'staged addition.txt');
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(after), valueOf(before));
    assert.deepEqual(after.entries.map((entry) => [
      entry.kind,
      Buffer.from(entry.path, 'base64').toString()
    ]), [['tracked', 'staged addition.txt']]);
  });

  test('unstaged content after staging changes the fingerprint without changing entries', (t) => {
    const repoRoot = createRepository(t);
    write(repoRoot, 'README.md', '# staged value\n');
    git(repoRoot, 'add', 'README.md');
    const staged = collectWorkingTreeSnapshot(repoRoot);
    write(repoRoot, 'README.md', '# worktree value\n');
    const unstagedAfterStage = collectWorkingTreeSnapshot(repoRoot);
    assert.deepEqual(unstagedAfterStage.entries, staged.entries);
    assert.notEqual(valueOf(unstagedAfterStage), valueOf(staged));
  });

  test('unstaged tracked deletion changes the fingerprint and records the deleted path', (t) => {
    const repoRoot = createRepository(t);
    const before = collectWorkingTreeSnapshot(repoRoot);
    fs.unlinkSync(path.join(repoRoot, 'README.md'));
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(after), valueOf(before));
    assert.equal(after.entries.length, 1);
    assert.equal(Buffer.from(after.entries[0].path, 'base64').toString(), 'README.md');
  });

  test('staged tracked deletion changes the fingerprint and records the deleted path', (t) => {
    const repoRoot = createRepository(t);
    const before = collectWorkingTreeSnapshot(repoRoot);
    fs.unlinkSync(path.join(repoRoot, 'README.md'));
    git(repoRoot, 'add', '-A');
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(after), valueOf(before));
    assert.equal(after.entries.length, 1);
    assert.equal(Buffer.from(after.entries[0].path, 'base64').toString(), 'README.md');
  });

  test('unstaged rename is represented deterministically as delete plus untracked add', (t) => {
    const repoRoot = createRepository(t);
    fs.renameSync(path.join(repoRoot, 'README.md'), path.join(repoRoot, 'renamed file.md'));
    const snapshot = collectWorkingTreeSnapshot(repoRoot);
    assert.deepEqual(snapshot.entries.map((entry) => [
      entry.kind,
      Buffer.from(entry.path, 'base64').toString()
    ]), [
      ['tracked', 'README.md'],
      ['untracked', 'renamed file.md']
    ]);
  });

  test('staged rename is represented deterministically as two tracked paths', (t) => {
    const repoRoot = createRepository(t);
    fs.renameSync(path.join(repoRoot, 'README.md'), path.join(repoRoot, 'renamed file.md'));
    git(repoRoot, 'add', '-A');
    const snapshot = collectWorkingTreeSnapshot(repoRoot);
    assert.deepEqual(snapshot.entries.map((entry) => [
      entry.kind,
      Buffer.from(entry.path, 'base64').toString()
    ]), [
      ['tracked', 'README.md'],
      ['tracked', 'renamed file.md']
    ]);
  });

  test('tracked executable-bit drift changes fingerprint and entry count', (t) => {
    const repoRoot = createRepository(t);
    const readme = path.join(repoRoot, 'README.md');
    fs.chmodSync(readme, 0o644);
    const before = collectWorkingTreeSnapshot(repoRoot);
    fs.chmodSync(readme, 0o755);
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(after), valueOf(before));
    assert.equal(after.state, 'dirty');
    assert.equal(after.entries.length, 1);
  });

  test('tracked executable-bit drift remains visible when core.filemode is false', (t) => {
    const repoRoot = createRepository(t);
    const readme = path.join(repoRoot, 'README.md');
    fs.chmodSync(readme, 0o644);
    git(repoRoot, 'config', 'core.filemode', 'false');
    const before = collectWorkingTreeSnapshot(repoRoot);
    fs.chmodSync(readme, 0o755);
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(after), valueOf(before));
    assert.equal(after.state, 'dirty');
    assert.equal(after.entries.length, 1);
  });

  test('untracked binary content drift changes the fingerprint', (t) => {
    const repoRoot = createRepository(t);
    write(repoRoot, 'binary.dat', Buffer.from([0, 255, 0, 1]));
    const before = collectWorkingTreeSnapshot(repoRoot);
    write(repoRoot, 'binary.dat', Buffer.from([0, 255, 0, 2]));
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(after), valueOf(before));
  });

  test('removing an untracked file returns to the prior clean fingerprint', (t) => {
    const repoRoot = createRepository(t);
    const clean = collectWorkingTreeSnapshot(repoRoot);
    const temporary = write(repoRoot, 'temporary.bin', Buffer.from([1, 2, 3]));
    const dirty = collectWorkingTreeSnapshot(repoRoot);
    fs.unlinkSync(temporary);
    const restored = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(dirty), valueOf(clean));
    assert.deepEqual(restored, clean);
  });

  test('entry ordering is raw-byte deterministic', (t) => {
    const repoRoot = createRepository(t);
    for (const relativePath of ['z.txt', 'ä.txt', '中.txt', 'line\nbreak']) {
      write(repoRoot, relativePath, relativePath);
    }
    const entries = collectWorkingTreeSnapshot(repoRoot).entries;
    const pathBytes = entries.map((entry) => Buffer.from(entry.path, 'base64'));
    const expected = [...pathBytes].sort(Buffer.compare);
    assert.deepEqual(pathBytes, expected);
  });

  test('tracked binary content drift changes the fingerprint', (t) => {
    const repoRoot = createRepository(t);
    write(repoRoot, 'tracked.dat', Buffer.from([0, 255, 0, 1]));
    git(repoRoot, 'add', 'tracked.dat');
    git(repoRoot, 'commit', '-m', 'add binary');
    const before = collectWorkingTreeSnapshot(repoRoot);
    write(repoRoot, 'tracked.dat', Buffer.from([0, 255, 0, 2]));
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(after), valueOf(before));
    assert.equal(after.entries.length, 1);
  });

  test('untracked symlink target bytes change the fingerprint without following the target', (t) => {
    const repoRoot = createRepository(t);
    const outside = `${repoRoot}-outside-secret`;
    t.after(() => fs.rmSync(outside, { force: true }));
    fs.writeFileSync(outside, 'secret first\n');
    fs.symlinkSync(outside, path.join(repoRoot, 'external-link'));
    const before = collectWorkingTreeSnapshot(repoRoot);
    fs.writeFileSync(outside, 'secret second\n');
    const targetContentChanged = collectWorkingTreeSnapshot(repoRoot);
    assert.equal(valueOf(targetContentChanged), valueOf(before));
    fs.unlinkSync(path.join(repoRoot, 'external-link'));
    fs.symlinkSync(`${outside}-different`, path.join(repoRoot, 'external-link'));
    const linkChanged = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(linkChanged), valueOf(targetContentChanged));
  });

  test('tracked symlink target drift changes the fingerprint', (t) => {
    const repoRoot = createRepository(t);
    fs.symlinkSync('first-target', path.join(repoRoot, 'tracked-link'));
    git(repoRoot, 'add', 'tracked-link');
    git(repoRoot, 'commit', '-m', 'add symlink');
    const before = collectWorkingTreeSnapshot(repoRoot);
    fs.unlinkSync(path.join(repoRoot, 'tracked-link'));
    fs.symlinkSync('second-target', path.join(repoRoot, 'tracked-link'));
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(after), valueOf(before));
    assert.equal(after.entries.length, 1);
  });

  test('regular-file to symlink transition changes the fingerprint', (t) => {
    const repoRoot = createRepository(t);
    write(repoRoot, 'shape', 'same bytes\n');
    const regular = collectWorkingTreeSnapshot(repoRoot);
    fs.unlinkSync(path.join(repoRoot, 'shape'));
    fs.symlinkSync('same bytes\n', path.join(repoRoot, 'shape'));
    const symlink = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(symlink), valueOf(regular));
    assert.equal(symlink.entries.length, 1);
  });

  test('raw non-UTF-8 untracked path bytes are preserved as canonical base64', { skip: process.platform === 'win32' }, (t) => {
    const repoRoot = createRepository(t);
    const relativePath = Buffer.from([0x72, 0x61, 0x77, 0x2d, 0xff, 0x2e, 0x62, 0x69, 0x6e]);
    const absolutePath = Buffer.concat([Buffer.from(`${repoRoot}${path.sep}`), relativePath]);
    try {
      fs.writeFileSync(absolutePath, Buffer.from([1, 2, 3]));
    } catch (error) {
      if (error?.code === 'EILSEQ') return t.skip('filesystem rejects non-UTF-8 path bytes');
      throw error;
    }
    const before = collectWorkingTreeSnapshot(repoRoot);
    fs.writeFileSync(absolutePath, Buffer.from([1, 2, 4]));
    const after = collectWorkingTreeSnapshot(repoRoot);
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0].path, relativePath.toString('base64'));
    assert.notEqual(valueOf(after), valueOf(before));
  });

  test('tracked newline path remains one exact entry after staging', (t) => {
    const repoRoot = createRepository(t);
    const relativePath = 'tracked\nnewline.txt';
    write(repoRoot, relativePath, 'first\n');
    git(repoRoot, 'add', '-A');
    git(repoRoot, 'commit', '-m', 'add newline path');
    write(repoRoot, relativePath, 'second\n');
    git(repoRoot, 'add', '-A');
    const snapshot = collectWorkingTreeSnapshot(repoRoot);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].path, Buffer.from(relativePath).toString('base64'));
  });

  test('tracked canonical exclusion is exact while a tracked similar name remains visible', (t) => {
    const repoRoot = createRepository(t);
    write(repoRoot, 'AI_WORK_SECRETARY_PROJECT_STATE.md', 'canonical baseline\n');
    write(repoRoot, 'AI_WORK_SECRETARY_PROJECT_STATE.md.copy', 'copy baseline\n');
    git(repoRoot, 'add', '-A');
    git(repoRoot, 'commit', '-m', 'add state paths');
    const before = collectWorkingTreeSnapshot(repoRoot);
    write(repoRoot, 'AI_WORK_SECRETARY_PROJECT_STATE.md', 'canonical changed\n');
    const canonicalOnly = collectWorkingTreeSnapshot(repoRoot);
    assert.equal(valueOf(canonicalOnly), valueOf(before));
    assert.equal(canonicalOnly.entries.length, 0);
    write(repoRoot, 'AI_WORK_SECRETARY_PROJECT_STATE.md.copy', 'copy changed\n');
    const similar = collectWorkingTreeSnapshot(repoRoot);
    assert.notEqual(valueOf(similar), valueOf(canonicalOnly));
    assert.equal(similar.entries.length, 1);
  });

  test('unsupported untracked FIFO fails closed', { skip: process.platform === 'win32' }, (t) => {
    const repoRoot = createRepository(t);
    const fifo = path.join(repoRoot, 'named-pipe');
    const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
    if (created.status !== 0) return t.skip(`mkfifo unavailable: ${created.stderr}`);
    const listed = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: repoRoot,
      encoding: 'buffer'
    });
    assert.equal(listed.status, 0, listed.stderr.toString('utf8'));
    if (!listed.stdout.includes(Buffer.from('named-pipe'))) {
      return t.skip('Git does not enumerate untracked FIFOs on this platform');
    }
    assert.throws(
      () => collectWorkingTreeSnapshot(repoRoot),
      /Unsupported working-tree file type; fingerprint aborted/
    );
  });

  test('unreadable untracked file fails closed when the platform enforces mode bits', (t) => {
    const repoRoot = createRepository(t);
    const unreadable = write(repoRoot, 'unreadable-secret.txt', 'DO_NOT_PRINT_THIS_SECRET\n');
    fs.chmodSync(unreadable, 0o000);
    try {
      try {
        fs.readFileSync(unreadable);
        return t.skip('current execution identity can read mode-000 files');
      } catch {
        assert.throws(
          () => collectWorkingTreeSnapshot(repoRoot),
          (error) => /could not be hashed/.test(error.message) && !/DO_NOT_PRINT_THIS_SECRET/.test(error.message)
        );
      }
    } finally {
      fs.chmodSync(unreadable, 0o600);
    }
  });

  test('Git failure aborts without leaking file content', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'working-tree-fingerprint-not-git-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    write(directory, 'secret.txt', 'DO_NOT_PRINT_THIS_SECRET\n');
    assert.throws(
      () => collectWorkingTreeSnapshot(directory),
      (error) => /Git command failed/.test(error.message) && !/DO_NOT_PRINT_THIS_SECRET/.test(error.message)
    );
  });

  test('gitlink is rejected fail closed instead of silently skipped', (t) => {
    const repoRoot = createRepository(t);
    const nested = path.join(repoRoot, 'nested-repository');
    fs.mkdirSync(nested);
    git(nested, 'init', '-b', 'main');
    git(nested, 'config', 'user.email', 'fixture@example.invalid');
    git(nested, 'config', 'user.name', 'Nested Fixture');
    write(nested, 'nested.txt', 'nested\n');
    git(nested, 'add', '.');
    git(nested, 'commit', '-m', 'nested baseline');
    const nestedHead = git(nested, 'rev-parse', 'HEAD');
    git(repoRoot, 'update-index', '--add', '--cacheinfo', `160000,${nestedHead},nested-repository`);
    git(repoRoot, 'commit', '-m', 'add gitlink');
    assert.throws(
      () => collectWorkingTreeSnapshot(repoRoot),
      /Unsupported working-tree file type; fingerprint aborted/
    );
  });
}
