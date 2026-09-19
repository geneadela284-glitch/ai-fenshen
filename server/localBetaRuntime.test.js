import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import viteConfig from '../apps/desktop/vite.config.js';
import { resolveBetaServerConfig } from './betaServerConfig.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('local beta backend and CLI resolve the same project auth database', () => {
  const config = resolveBetaServerConfig({ env: {}, projectRoot });

  assert.equal(config.authDb, path.join(projectRoot, 'data/auth/auth.sqlite'));
  assert.equal(config.conversationDb, path.join(projectRoot, 'data/conversations/conversations.sqlite'));
  assert.equal(config.financeDb, path.join(projectRoot, 'data/finance/finance.sqlite'));
  assert.equal(config.tasksDb, path.join(projectRoot, 'data/tasks/tasks.sqlite'));
  assert.equal(config.attachmentsDb, path.join(projectRoot, 'data/attachments/attachments.sqlite'));
  assert.equal(config.attachmentStorageRoot, path.join(projectRoot, 'data/attachments/storage'));
  assert.equal(config.attachmentImageUnderstandingEnabled, false);
  assert.equal(config.financeF201Enabled, false);
  assert.equal(config.providerHealthStore, path.join(projectRoot, 'data/ai/provider-health.json'));
  assert.equal(config.providerRegistry.enabled, false);
  assert.equal(config.providerRegistry.registryPath, path.join(projectRoot, 'data/provider-registry/registry.v1.json'));
  assert.equal(config.providerRegistry.modelCatalogPath, path.join(projectRoot, 'data/provider-registry/model-catalog.v1.json'));
  assert.equal(config.providerRegistry.vaultPath, path.join(projectRoot, 'data/secrets/provider-credentials.v1.enc'));
  assert.equal(config.providerRegistry.auditLogPath, path.join(projectRoot, 'data/logs/provider-security-audit.ndjson'));
  assert.equal(config.providerRegistry.kekCredentialPath, null);
  assert.notEqual(config.conversationDb, config.authDb);
  assert.equal(config.protectedMemoryDb, null);
  assert.equal(config.protectedMemoryScope, null);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 8080);
  assert.equal(config.secureCookie, false);
});

test('beta server resolves protected acceptance Memory only from server environment', () => {
  const config = resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      AI_SECRETARY_M9_2_MEMORY_DB: '/private/acceptance/memory.sqlite',
      AI_SECRETARY_M9_2_MEMORY_SCOPE: 'local-m9-2-acceptance'
    }
  });
  assert.equal(config.protectedMemoryDb, '/private/acceptance/memory.sqlite');
  assert.equal(config.protectedMemoryScope, 'local-m9-2-acceptance');
});

test('beta server resolves one scope from general real-data environment variables', () => {
  const config = resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      AI_SECRETARY_REAL_DATA_MEMORY_DB: '/opt/ai-fenshen-staging/shared/data/memory/memory.sqlite',
      AI_SECRETARY_REAL_DATA_SCOPE: 'vps-staging'
    }
  });
  assert.equal(config.protectedMemoryDb, '/opt/ai-fenshen-staging/shared/data/memory/memory.sqlite');
  assert.equal(config.protectedMemoryScope, 'vps-staging');
});

test('matching legacy and general protected-memory variables are accepted', () => {
  const config = resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      AI_SECRETARY_REAL_DATA_MEMORY_DB: '/private/acceptance/memory.sqlite',
      AI_SECRETARY_REAL_DATA_SCOPE: 'local-m9-2-acceptance',
      AI_SECRETARY_M9_2_MEMORY_DB: '/private/acceptance/memory.sqlite',
      AI_SECRETARY_M9_2_MEMORY_SCOPE: 'local-m9-2-acceptance'
    }
  });
  assert.equal(config.protectedMemoryDb, '/private/acceptance/memory.sqlite');
  assert.equal(config.protectedMemoryScope, 'local-m9-2-acceptance');
});

test('conflicting legacy and general protected-memory variables fail closed', () => {
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      AI_SECRETARY_REAL_DATA_MEMORY_DB: '/opt/ai-fenshen-staging/shared/data/memory/memory.sqlite',
      AI_SECRETARY_REAL_DATA_SCOPE: 'vps-staging',
      AI_SECRETARY_M9_2_MEMORY_DB: '/private/acceptance/memory.sqlite',
      AI_SECRETARY_M9_2_MEMORY_SCOPE: 'local-m9-2-acceptance'
    }
  }), /FAIL_CLOSED|conflict/i);
});

test('partial or relative protected-memory environment fails closed', () => {
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo', env: { AI_SECRETARY_REAL_DATA_SCOPE: 'vps-staging' }
  }), /FAIL_CLOSED|database|scope/i);
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      AI_SECRETARY_REAL_DATA_MEMORY_DB: 'relative/memory.sqlite',
      AI_SECRETARY_REAL_DATA_SCOPE: 'vps-staging'
    }
  }), /FAIL_CLOSED|absolute|path/i);
});

test('new and legacy protected-memory variable families cannot be cross-paired', () => {
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      AI_SECRETARY_REAL_DATA_MEMORY_DB: '/opt/ai-fenshen-staging/shared/data/memory/memory.sqlite',
      AI_SECRETARY_M9_2_MEMORY_SCOPE: 'vps-staging'
    }
  }), /FAIL_CLOSED|complete|together|pair/i);
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      AI_SECRETARY_M9_2_MEMORY_DB: '/private/acceptance/memory.sqlite',
      AI_SECRETARY_REAL_DATA_SCOPE: 'local-m9-2-acceptance'
    }
  }), /FAIL_CLOSED|complete|together|pair/i);
});

test('configured protected-memory variables reject empty values', () => {
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      AI_SECRETARY_REAL_DATA_MEMORY_DB: '',
      AI_SECRETARY_REAL_DATA_SCOPE: 'vps-staging'
    }
  }), /FAIL_CLOSED|path/i);
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      AI_SECRETARY_REAL_DATA_MEMORY_DB: '/opt/ai-fenshen-staging/shared/data/memory/memory.sqlite',
      AI_SECRETARY_REAL_DATA_SCOPE: ''
    }
  }), /FAIL_CLOSED|scope/i);
});

test('production beta backend keeps the container auth database default', () => {
  const config = resolveBetaServerConfig({ env: { NODE_ENV: 'production' }, projectRoot });

  assert.equal(config.authDb, '/data/auth/auth.sqlite');
  assert.equal(config.conversationDb, '/data/conversations/conversations.sqlite');
  assert.equal(config.financeDb, '/data/finance/finance.sqlite');
  assert.equal(config.attachmentsDb, '/data/attachments/attachments.sqlite');
  assert.equal(config.attachmentStorageRoot, '/data/attachments/storage');
  assert.equal(config.providerHealthStore, '/data/ai/provider-health.json');
  assert.equal(config.providerRegistry.enabled, false);
  assert.equal(config.providerRegistry.registryPath, '/opt/ai-fenshen/shared/provider-registry/registry.v1.json');
  assert.equal(config.providerRegistry.modelCatalogPath, '/opt/ai-fenshen/shared/provider-registry/model-catalog.v1.json');
  assert.equal(config.providerRegistry.vaultPath, '/opt/ai-fenshen/shared/secrets/provider-credentials.v1.enc');
  assert.equal(config.providerRegistry.auditLogPath, '/opt/ai-fenshen/shared/logs/provider-security-audit.ndjson');
  assert.equal(config.secureCookie, true);
});

test('Provider Registry feature gate requires normalized absolute storage and systemd KEK credential paths', () => {
  const config = resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      NODE_ENV: 'production',
      AI_SECRETARY_PROVIDER_REGISTRY_V1_ENABLED: 'true',
      AI_SECRETARY_PROVIDER_REGISTRY_PATH: '/opt/ai-fenshen/shared/provider-registry/registry.v1.json',
      AI_SECRETARY_MODEL_CATALOG_PATH: '/opt/ai-fenshen/shared/provider-registry/model-catalog.v1.json',
      AI_SECRETARY_PROVIDER_VAULT_PATH: '/opt/ai-fenshen/shared/secrets/provider-credentials.v1.enc',
      AI_SECRETARY_PROVIDER_AUDIT_LOG: '/opt/ai-fenshen/shared/logs/provider-security-audit.ndjson',
      AI_SECRETARY_PROVIDER_VAULT_KEK_CREDENTIAL: '/run/credentials/ai-fenshen.service/provider-vault-kek'
    }
  });
  assert.equal(config.providerRegistry.enabled, true);
  assert.equal(config.providerRegistry.kekCredentialPath, '/run/credentials/ai-fenshen.service/provider-vault-kek');

  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      NODE_ENV: 'production',
      AI_SECRETARY_PROVIDER_REGISTRY_V1_ENABLED: 'true',
      AI_SECRETARY_PROVIDER_REGISTRY_PATH: 'relative/registry.json',
      AI_SECRETARY_PROVIDER_VAULT_KEK_CREDENTIAL: '/run/credentials/ai-fenshen.service/provider-vault-kek'
    }
  }), /SCOPED_REAL_DATA_FAIL_CLOSED|absolute|normalized/);

  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      NODE_ENV: 'production',
      AI_SECRETARY_PROVIDER_REGISTRY_V1_ENABLED: 'true'
    }
  }), /SCOPED_REAL_DATA_FAIL_CLOSED|KEK|credential/i);
});

test('Provider Health Store accepts only an explicit normalized absolute path', () => {
  const config = resolveBetaServerConfig({
    projectRoot: '/repo',
    env: { AI_SECRETARY_PROVIDER_HEALTH_STORE: '/opt/ai-fenshen/shared/data/provider-health/provider-health.json' }
  });
  assert.equal(config.providerHealthStore, '/opt/ai-fenshen/shared/data/provider-health/provider-health.json');
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: { AI_SECRETARY_PROVIDER_HEALTH_STORE: 'relative/provider-health.json' }
  }), /PROVIDER_HEALTH|absolute|normalized|FAIL_CLOSED/i);
});

test('Finance database environment accepts only a normalized absolute path', () => {
  const config = resolveBetaServerConfig({
    projectRoot: '/repo', env: { AI_SECRETARY_FINANCE_DB: '/opt/ai-fenshen/shared/data/finance/finance.sqlite' }
  });
  assert.equal(config.financeDb, '/opt/ai-fenshen/shared/data/finance/finance.sqlite');
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo', env: { AI_SECRETARY_FINANCE_DB: 'relative/finance.sqlite' }
  }), /FINANCE|absolute|normalized|FAIL_CLOSED/i);
});

test('Tasks database environment accepts only a normalized absolute path', () => {
  const config = resolveBetaServerConfig({
    projectRoot: '/repo', env: { AI_SECRETARY_TASKS_DB: '/opt/ai-fenshen/shared/data/tasks/tasks.sqlite' }
  });
  assert.equal(config.tasksDb, '/opt/ai-fenshen/shared/data/tasks/tasks.sqlite');
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo', env: { AI_SECRETARY_TASKS_DB: 'relative/tasks.sqlite' }
  }), /TASKS|absolute|normalized|FAIL_CLOSED/i);
});

test('Attachment database and storage accept only normalized absolute paths', () => {
  const config = resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {
      AI_SECRETARY_ATTACHMENTS_DB: '/opt/ai-fenshen/shared/data/attachments/attachments.sqlite',
      AI_SECRETARY_ATTACHMENT_STORAGE_ROOT: '/opt/ai-fenshen/shared/data/attachments/storage'
    }
  });
  assert.equal(config.attachmentsDb, '/opt/ai-fenshen/shared/data/attachments/attachments.sqlite');
  assert.equal(config.attachmentStorageRoot, '/opt/ai-fenshen/shared/data/attachments/storage');
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: { AI_SECRETARY_ATTACHMENTS_DB: 'relative/attachments.sqlite' }
  }), /ATTACHMENTS|absolute|normalized|FAIL_CLOSED/i);
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: { AI_SECRETARY_ATTACHMENT_STORAGE_ROOT: 'relative/storage' }
  }), /ATTACHMENT_STORAGE|absolute|normalized|FAIL_CLOSED/i);
});

test('Attachment image understanding feature flag defaults off and accepts only exact booleans', () => {
  assert.equal(resolveBetaServerConfig({
    projectRoot: '/repo',
    env: { AI_SECRETARY_ATTACHMENT_IMAGE_UNDERSTANDING_ENABLED: 'true' }
  }).attachmentImageUnderstandingEnabled, true);
  assert.equal(resolveBetaServerConfig({
    projectRoot: '/repo',
    env: { AI_SECRETARY_ATTACHMENT_IMAGE_UNDERSTANDING_ENABLED: 'false' }
  }).attachmentImageUnderstandingEnabled, false);
  assert.throws(() => resolveBetaServerConfig({
    projectRoot: '/repo',
    env: { AI_SECRETARY_ATTACHMENT_IMAGE_UNDERSTANDING_ENABLED: '1' }
  }), /FAIL_CLOSED|true or false/);
});

test('Finance F2.0-1 feature flag defaults off and accepts only exact booleans', () => {
  assert.equal(resolveBetaServerConfig({
    projectRoot: '/repo',
    env: { AI_SECRETARY_FINANCE_F2_0_1_ENABLED: 'true' }
  }).financeF201Enabled, true);
  assert.equal(resolveBetaServerConfig({
    projectRoot: '/repo',
    env: { AI_SECRETARY_FINANCE_F2_0_1_ENABLED: 'false' }
  }).financeF201Enabled, false);
  for (const value of ['1', 'TRUE', ' false', '', true, false]) {
    assert.throws(() => resolveBetaServerConfig({
      projectRoot: '/repo',
      env: { AI_SECRETARY_FINANCE_F2_0_1_ENABLED: value }
    }), /AI_SECRETARY_FINANCE_F2_0_1_ENABLED|FAIL_CLOSED|true or false/);
  }
});

test('multimodal image token reservation is bounded, configurable and fail closed', () => {
  assert.equal(resolveBetaServerConfig({
    projectRoot: '/repo',
    env: {}
  }).imageInputTokenReservation, 16_384);
  assert.equal(resolveBetaServerConfig({
    projectRoot: '/repo',
    env: { AI_SECRETARY_IMAGE_INPUT_TOKEN_RESERVATION: '32768' }
  }).imageInputTokenReservation, 32_768);
  for (const value of ['0', '-1', 'not-a-number', '999999999']) {
    assert.throws(() => resolveBetaServerConfig({
      projectRoot: '/repo',
      env: { AI_SECRETARY_IMAGE_INPUT_TOKEN_RESERVATION: value }
    }), /IMAGE_INPUT_TOKEN_RESERVATION|FAIL_CLOSED/);
  }
});

test('Vite proxies local auth API requests to the beta backend', () => {
  assert.equal(viteConfig.server.proxy['/api'].target, 'http://127.0.0.1:8080');
  assert.equal(viteConfig.server.proxy['/api'].changeOrigin, true);
});

test('login password input does not restore stale saved credentials', () => {
  const source = readFileSync(path.join(projectRoot, 'apps/desktop/src/components/LoginPage.jsx'), 'utf8');
  assert.match(source, /type="password"[\s\S]*autoComplete="new-password"/);
  assert.doesNotMatch(source, /autoComplete="current-password"/);
});
