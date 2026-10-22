import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assembleRelease } from './assembleRelease.mjs';
import { normalizeExecutableRuntimeEntries, verifyRuntimeAssets } from './verifyRuntimeAssets.mjs';

const repoRoot = path.resolve(new URL('../..', import.meta.url).pathname);

test('Release normalizes executable entrypoints across every workspace .bin directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-runtime-permissions-'));
  try {
    for (const relativeRoot of ['node_modules', 'apps/desktop/node_modules']) {
      const packageRoot = path.join(root, relativeRoot, '.pnpm', 'fixture@1.0.0', 'node_modules', 'fixture');
      const binRoot = path.join(root, relativeRoot, '.bin');
      fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true });
      fs.mkdirSync(binRoot, { recursive: true });
      const target = path.join(packageRoot, 'bin', 'run.js');
      fs.writeFileSync(target, '#!/usr/bin/env node\n');
      fs.chmodSync(target, 0o444);
      fs.symlinkSync(path.relative(binRoot, target), path.join(binRoot, 'fixture-run'));
    }

    normalizeExecutableRuntimeEntries(root);

    for (const relativeRoot of ['node_modules', 'apps/desktop/node_modules']) {
      const target = path.join(root, relativeRoot, '.pnpm', 'fixture@1.0.0', 'node_modules', 'fixture', 'bin', 'run.js');
      assert.notEqual(fs.statSync(target).mode & 0o111, 0);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime gate rejects a non-executable workspace .bin target', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-runtime-permissions-gate-'));
  try {
    fs.mkdirSync(path.join(root, 'apps/desktop/dist/assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules/.bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules/.pnpm/fixture@1.0.0/node_modules/fixture/bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'server/betaServer.js'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'apps/desktop/dist/index.html'), '<script src="/assets/app.js"></script>\n');
    fs.writeFileSync(path.join(root, 'apps/desktop/dist/assets/app.js'), 'console.log("ok");\n');
    const target = path.join(root, 'node_modules/.pnpm/fixture@1.0.0/node_modules/fixture/bin/run.js');
    fs.writeFileSync(target, '#!/usr/bin/env node\n');
    fs.chmodSync(target, 0o444);
    fs.symlinkSync(path.relative(path.join(root, 'node_modules/.bin'), target), path.join(root, 'node_modules/.bin/run-fixture'));
    const result = verifyRuntimeAssets(root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /runtime executable lacks execute permission/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function cloneSourceSnapshot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-runtime-red-'));
  const source = path.join(root, 'source');
  execFileSync('git', ['clone', '--no-local', '--branch', 'codex/reconstruct-m9-real-user-integration', '--single-branch', repoRoot, source], {
    stdio: 'ignore'
  });
  return { root, source };
}

test('final Release assembly includes the Vite runtime web assets and runs independently', async () => {
  const { root, source } = cloneSourceSnapshot();
  const candidate = path.join(root, 'candidate');
  try {
    const result = assembleRelease({
      source,
      destination: candidate,
      dependenciesSource: repoRoot,
      branch: 'codex/reconstruct-m9-real-user-integration'
    });
    assert.equal(result.runtime.ok, true);
    assert.equal(fs.existsSync(path.join(candidate, '.git/objects/info/alternates')), false);
    fs.rmSync(source, { recursive: true, force: true });

    const { createBetaServer } = await import(`${pathToFileURL(path.join(candidate, 'server/betaServer.js')).href}`);
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-runtime-server-'));
    const instance = await createBetaServer({
      config: {
        publicDir: path.join(candidate, 'apps/desktop/dist'),
        authDb: path.join(runtimeRoot, 'auth.sqlite'),
        cookieSecret: 'release-runtime-contract-secret',
        secureCookie: false,
        host: '127.0.0.1',
        port: 0
      },
      aiService: { getStatus: () => ({ available: false }), run: async () => ({ ok: false, code: 'NOT_USED' }), async stream() { throw new Error('not used'); } },
      memoryRuntime: { service: {}, async initialize() { return { status: 'disabled' }; }, async close() {} },
      conversationRuntime: null,
      financeRuntime: null,
      tasksRuntime: null,
      attachmentRuntime: null
    });
    await new Promise((resolve) => instance.server.listen(0, '127.0.0.1', resolve));
    const address = instance.server.address();
    assert.equal(typeof address?.port, 'number');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const health = await fetch(`${baseUrl}/healthz`);
      assert.equal(health.status, 200);
      const indexResponse = await fetch(`${baseUrl}/`);
      assert.equal(indexResponse.status, 200);
      const indexHtml = await indexResponse.text();
      for (const asset of result.runtime.files.filter((item) => /\.(?:js|css)$/.test(item.path))) {
        const assetResponse = await fetch(`${baseUrl}/${asset.path.replace(/^apps\/desktop\/dist\//, '')}`);
        assert.equal(assetResponse.status, 200, asset.path);
      }
      assert.match(indexHtml, /<script[^>]+src=/i);
      assert.match(indexHtml, /<link[^>]+stylesheet/i);
    } finally {
      if (instance.server.listening) await new Promise((resolve) => instance.server.close(resolve));
      instance.auth.close();
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('final Release canonical runtime validation works after Git metadata is removed', async () => {
  const { root, source } = cloneSourceSnapshot();
  const candidate = path.join(root, 'candidate');
  try {
    assembleRelease({
      source,
      destination: candidate,
      dependenciesSource: repoRoot,
      branch: 'codex/reconstruct-m9-real-user-integration'
    });
    assert.equal(fs.existsSync(path.join(candidate, '.git')), false);
    const stateDocument = fs.readFileSync(path.join(candidate, 'AI_WORK_SECRETARY_PROJECT_STATE.md'), 'utf8');
    const metadata = JSON.parse(stateDocument.match(/METADATA_START[\s\S]*?```json\n([\s\S]*?)\n```/)[1]);
    const authorization = metadata.real_data_authorizations?.['local-m9-2-acceptance'];
    assert.ok(authorization?.database_path);
    const { loadProtectedMemoryRuntimeConfig } = await import(
      `${pathToFileURL(path.join(candidate, 'server/memory/protectedMemoryConfig.js')).href}?gitless=${Date.now()}`
    );
    const result = loadProtectedMemoryRuntimeConfig({
      repositoryRoot: candidate,
      databasePath: authorization.database_path,
      scope: 'local-m9-2-acceptance'
    });
    assert.equal(result.scope, 'local-m9-2-acceptance');
    assert.equal(result.memoryPolicy, 'protected_acceptance');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime gate rejects a Release with a missing referenced asset', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-runtime-gate-'));
  try {
    fs.mkdirSync(path.join(root, 'apps/desktop/dist/assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'server'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'server/betaServer.js'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'apps/desktop/dist/index.html'), '<script src="/assets/missing.js"></script><link rel="stylesheet" href="/assets/missing.css">\n');
    const result = verifyRuntimeAssets(root);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /missing runtime file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
