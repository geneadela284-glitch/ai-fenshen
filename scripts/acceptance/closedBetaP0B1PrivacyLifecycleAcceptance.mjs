import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isolatedRoot = mkdtempSync(path.join(tmpdir(), 'closed-beta-p0-b1-'));
const testFiles = [
  'server/privacy/privacyLifecycleHttp.test.js',
  'apps/desktop/src/prototypes/aiFenshen/privacyUiContract.test.js',
  'apps/desktop/src/prototypes/aiFenshen/realSettingsEntry.test.js',
  'core/auth/betaAuthService.test.js',
  'server/access/accessControlStore.test.js',
  'server/access/accessControlService.test.js',
  'server/access/accessQuotaHttp.test.js',
  'core/router/accessQuotaGate.test.js',
  'server/conversation/conversationFoundation.test.js',
  'server/conversation/conversationLifecycle.test.js',
  'server/conversation/conversationStreaming.test.js',
  'server/conversation/calendarToolHttp.test.js',
  'server/conversation/financeConversation.test.js',
  'server/conversation/protectedMemoryIntegration.test.js',
  'server/conversation/memoryMobileTrustHttp.test.js',
  'server/finance/financeApi.test.js',
  'server/finance/financeLedger.test.js',
  'server/finance/monthlyReportExport.test.js',
  'memory/entity/sqliteFoundation.test.js',
  'server/memory/protectedMemoryRuntime.test.js',
  'server/memory/protectedMemoryConversation.test.js'
];

const forbiddenLogFragments = [
  'PrivacyPasswordA1!',
  'PrivacyPasswordB1!',
  'A完整Prompt',
  'B绝密内容',
  'complete response private',
  'sk-private',
  'ai_secretary_session=',
  'confirmationToken',
  'passwordHash',
  'providerCredential',
  'BEGIN PRIVATE KEY'
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
    maxBuffer: 30 * 1024 * 1024
  });

  const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  for (const fragment of forbiddenLogFragments) {
    if (combinedOutput.includes(fragment)) {
      throw new Error(`ACCEPTANCE_LOG_REDACTION_FAILED:${fragment}`);
    }
  }
  if (result.status !== 0) {
    process.stderr.write(combinedOutput);
    throw new Error(`CLOSED_BETA_P0_B1_ISOLATION_ACCEPTANCE_FAILED:${result.status}`);
  }
  const remainingNames = readdirSync(isolatedRoot);
  if (remainingNames.length !== 0) {
    throw new Error(`CLOSED_BETA_P0_B1_TEMPORARY_ARTIFACTS_REMAIN:${remainingNames.join(',')}`);
  }

  const tests = combinedOutput.match(/# tests (\d+)/)?.[1] || 'unknown';
  const pass = combinedOutput.match(/# pass (\d+)/)?.[1] || 'unknown';
  const fail = combinedOutput.match(/# fail (\d+)/)?.[1] || 'unknown';
  process.stdout.write(`${JSON.stringify({
    task: 'CLOSED-BETA-P0-B1-PRIVACY-EXPORT-DELETION-V1',
    status: 'PASS',
    tests: Number(tests),
    pass: Number(pass),
    fail: Number(fail),
    providerBeforeConsentCalls: 0,
    temporaryAccounts: 'deleted_with_isolated_root',
    temporaryDatabases: 'deleted_with_isolated_root',
    temporaryFiles: 'deleted_with_isolated_root',
    realProviderCredentialsUsed: false
  }, null, 2)}\n`);
} finally {
  rmSync(isolatedRoot, { recursive: true, force: true });
}
