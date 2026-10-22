import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'closed-beta-p0-a-'));
const testFiles = [
  'server/access/accessControlStore.test.js',
  'server/access/accessControlService.test.js',
  'server/access/trustedClientIp.test.js',
  'server/access/existingAdminBootstrap.test.js',
  'server/access/accessQuotaHttp.test.js',
  'core/auth/betaAuthService.test.js',
  'server/authLoginFlow.test.js',
  'server/adminAccess.test.js',
  'core/router/accessQuotaGate.test.js',
  'core/router/routerCoreM12B2.test.js',
  'server/conversation/conversationStreaming.test.js',
  'server/conversation/conversationLifecycle.test.js',
  'server/conversation/memoryMobileTrustHttp.test.js',
  'server/conversation/calendarToolHttp.test.js',
  'server/finance/financeApi.test.js',
  'server/memoryApiIntegration.test.js',
  'server/memory/protectedMemoryConversation.test.js',
  'server/memoryReloginPersistence.test.js',
  'server/agent/unifiedSemanticBlackboxHttp.test.js'
];

const forbiddenLogFragments = [
  'PasswordPrivate1!',
  'sk-private',
  'ai_secretary_session=private',
  'complete prompt private',
  'complete response private'
];

let result;
try {
  result = spawnSync(process.execPath, [
    '--test',
    '--test-concurrency=1',
    ...testFiles
  ], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TMPDIR: isolatedRoot
    },
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });

  const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  for (const fragment of forbiddenLogFragments) {
    if (combinedOutput.includes(fragment)) {
      throw new Error(`ACCEPTANCE_LOG_REDACTION_FAILED:${fragment}`);
    }
  }
  if (result.status !== 0) {
    process.stderr.write(combinedOutput);
    throw new Error(`CLOSED_BETA_P0_A_ISOLATION_ACCEPTANCE_FAILED:${result.status}`);
  }

  const tests = combinedOutput.match(/# tests (\d+)/)?.[1] || 'unknown';
  const pass = combinedOutput.match(/# pass (\d+)/)?.[1] || 'unknown';
  const fail = combinedOutput.match(/# fail (\d+)/)?.[1] || 'unknown';
  process.stdout.write(`${JSON.stringify({
    task: 'CLOSED-BETA-P0-A-ACCESS-QUOTA-HARDENING-V1',
    status: 'PASS',
    tests: Number(tests),
    pass: Number(pass),
    fail: Number(fail),
    isolatedRoot: path.basename(isolatedRoot),
    temporaryAccounts: 'deleted_with_isolated_root',
    temporaryDatabases: 'deleted_with_isolated_root',
    providerCredentialsUsed: false
  }, null, 2)}\n`);
} finally {
  rmSync(isolatedRoot, { recursive: true, force: true });
}
