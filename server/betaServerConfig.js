import path from 'node:path';
import os from 'node:os';
import { resolveBetaAuthDbPath } from '../core/auth/betaAuthConfig.js';
import { resolveAccessControlConfig } from './access/accessControlConfig.js';

function failClosed(message) {
  throw new Error(`SCOPED_REAL_DATA_FAIL_CLOSED: ${message}`);
}

function configured(env, name) {
  return Object.hasOwn(env, name);
}

function normalizedDatabasePath(env, name) {
  if (!configured(env, name)) return null;
  const value = env[name];
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) || path.normalize(value) !== value) {
    failClosed(`${name} must be a normalized absolute path.`);
  }
  return value;
}

function configuredScope(env, name) {
  if (!configured(env, name)) return null;
  const value = env[name];
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    failClosed(`${name} must be a non-empty exact scope.`);
  }
  return value;
}

function enabledFlag(env, name) {
  if (!configured(env, name)) return false;
  if (!['true', 'false'].includes(env[name])) failClosed(`${name} must be exactly true or false.`);
  return env[name] === 'true';
}

function boundedInteger(env, name, {
  fallback,
  minimum,
  maximum
}) {
  if (!configured(env, name)) return fallback;
  if (!/^\d+$/.test(String(env[name] || ''))) {
    failClosed(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    failClosed(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function configuredAbsolutePath(env, name, fallback = null) {
  if (!configured(env, name)) return fallback;
  return normalizedDatabasePath(env, name);
}

function protectedMemoryEnvironment(env) {
  const newDatabaseConfigured = configured(env, 'AI_SECRETARY_REAL_DATA_MEMORY_DB');
  const newScopeConfigured = configured(env, 'AI_SECRETARY_REAL_DATA_SCOPE');
  const legacyDatabaseConfigured = configured(env, 'AI_SECRETARY_M9_2_MEMORY_DB');
  const legacyScopeConfigured = configured(env, 'AI_SECRETARY_M9_2_MEMORY_SCOPE');
  if (newDatabaseConfigured !== newScopeConfigured) {
    failClosed('general protected-memory database and scope must be configured as a complete pair.');
  }
  if (legacyDatabaseConfigured !== legacyScopeConfigured) {
    failClosed('legacy protected-memory database and scope must be configured as a complete pair.');
  }
  const databasePath = normalizedDatabasePath(env, 'AI_SECRETARY_REAL_DATA_MEMORY_DB');
  const legacyDatabasePath = normalizedDatabasePath(env, 'AI_SECRETARY_M9_2_MEMORY_DB');
  const scope = configuredScope(env, 'AI_SECRETARY_REAL_DATA_SCOPE');
  const legacyScope = configuredScope(env, 'AI_SECRETARY_M9_2_MEMORY_SCOPE');
  if (databasePath && legacyDatabasePath && databasePath !== legacyDatabasePath) {
    failClosed('new and legacy protected-memory database variables conflict.');
  }
  if (scope && legacyScope && scope !== legacyScope) {
    failClosed('new and legacy protected-memory scope variables conflict.');
  }
  const selectedDatabasePath = databasePath || legacyDatabasePath;
  const selectedScope = scope || legacyScope;
  if (Boolean(selectedDatabasePath) !== Boolean(selectedScope)) {
    failClosed('protected-memory database and scope must be configured together.');
  }
  return Object.freeze({ databasePath: selectedDatabasePath, scope: selectedScope });
}

export function resolveBetaServerConfig({ env = process.env, projectRoot = process.cwd() } = {}) {
  const production = env.NODE_ENV === 'production';
  const accessControl = resolveAccessControlConfig({ env, projectRoot });
  const protectedMemory = protectedMemoryEnvironment(env);
  const authDb = resolveBetaAuthDbPath({ env, projectRoot });
  const conversationDb = env.AI_SECRETARY_CONVERSATION_DB
    ? path.resolve(env.AI_SECRETARY_CONVERSATION_DB)
    : env.AI_SECRETARY_DATA_DIR
      ? path.resolve(env.AI_SECRETARY_DATA_DIR, 'conversations/conversations.sqlite')
      : production
        ? '/data/conversations/conversations.sqlite'
        : path.resolve(projectRoot, 'data/conversations/conversations.sqlite');
  const configuredFinanceDb = normalizedDatabasePath(env, 'AI_SECRETARY_FINANCE_DB');
  const financeF201Enabled = enabledFlag(env, 'AI_SECRETARY_FINANCE_F2_0_1_ENABLED');
  const configuredProviderHealthStore = normalizedDatabasePath(env, 'AI_SECRETARY_PROVIDER_HEALTH_STORE');
  const providerRegistryEnabled = enabledFlag(env, 'AI_SECRETARY_PROVIDER_REGISTRY_V1_ENABLED');
  const providerRegistryLegacyMigrationEnabled = !configured(
    env,
    'AI_SECRETARY_PROVIDER_REGISTRY_LEGACY_MIGRATION_ENABLED'
  ) || enabledFlag(env, 'AI_SECRETARY_PROVIDER_REGISTRY_LEGACY_MIGRATION_ENABLED');
  const meetingTranscriptionLocalProvider = enabledFlag(env, 'AI_SECRETARY_MEETING_TRANSCRIPTION_LOCAL_PROVIDER');
  const meetingTranscriptionProviderRegistry = enabledFlag(
    env,
    'AI_SECRETARY_MEETING_TRANSCRIPTION_PROVIDER_REGISTRY_ENABLED'
  );
  const configuredRecordingAttemptDb = normalizedDatabasePath(env, 'AI_SECRETARY_MEETING_RECORDING_ATTEMPT_DB');
  const configuredMeetingTranscriptionDiagnosticLog = configuredAbsolutePath(
    env,
    'AI_SECRETARY_MEETING_TRANSCRIPTION_DIAGNOSTIC_LOG'
  );
  const meetingInputDiagnosticScopeFile = configuredAbsolutePath(env, 'AI_SECRETARY_MEETING_INPUT_DIAGNOSTIC_SCOPE_FILE');
  if (meetingInputDiagnosticScopeFile && !configuredMeetingTranscriptionDiagnosticLog) {
    failClosed('scoped Meeting input diagnostics require an explicit diagnostic log.');
  }
  if (production && meetingTranscriptionLocalProvider) failClosed('local Meeting transcription Provider is forbidden in production.');
  if (meetingTranscriptionProviderRegistry && !providerRegistryEnabled) {
    failClosed('formal Meeting transcription Provider Registry requires AI_SECRETARY_PROVIDER_REGISTRY_V1_ENABLED=true.');
  }
  if (meetingTranscriptionProviderRegistry && meetingTranscriptionLocalProvider) {
    failClosed('formal Meeting transcription Provider Registry and local Meeting transcription Provider are mutually exclusive.');
  }
  const providerRegistryRoot = production
    ? '/opt/ai-fenshen/shared/provider-registry'
    : path.join(projectRoot, 'data', 'provider-registry');
  const providerRegistry = {
    enabled: providerRegistryEnabled,
    legacyMigrationEnabled: providerRegistryLegacyMigrationEnabled,
    registryPath: configuredAbsolutePath(
      env,
      'AI_SECRETARY_PROVIDER_REGISTRY_PATH',
      path.join(providerRegistryRoot, 'registry.v1.json')
    ),
    modelCatalogPath: configuredAbsolutePath(
      env,
      'AI_SECRETARY_MODEL_CATALOG_PATH',
      path.join(providerRegistryRoot, 'model-catalog.v1.json')
    ),
    vaultPath: configuredAbsolutePath(
      env,
      'AI_SECRETARY_PROVIDER_VAULT_PATH',
      production
        ? '/opt/ai-fenshen/shared/secrets/provider-credentials.v1.enc'
        : path.join(projectRoot, 'data', 'secrets', 'provider-credentials.v1.enc')
    ),
    auditLogPath: configuredAbsolutePath(
      env,
      'AI_SECRETARY_PROVIDER_AUDIT_LOG',
      production
        ? '/opt/ai-fenshen/shared/logs/provider-security-audit.ndjson'
        : path.join(projectRoot, 'data', 'logs', 'provider-security-audit.ndjson')
    ),
    kekCredentialPath: configuredAbsolutePath(
      env,
      'AI_SECRETARY_PROVIDER_VAULT_KEK_CREDENTIAL',
      env.CREDENTIALS_DIRECTORY
        ? path.join(env.CREDENTIALS_DIRECTORY, 'provider-vault-kek')
        : null
    )
  };
  if (providerRegistryEnabled && !providerRegistry.kekCredentialPath) {
    failClosed('AI_SECRETARY_PROVIDER_VAULT_KEK_CREDENTIAL is required when Provider Registry is enabled.');
  }
  const financeDb = configuredFinanceDb
    ? configuredFinanceDb
    : env.AI_SECRETARY_DATA_DIR
      ? path.resolve(env.AI_SECRETARY_DATA_DIR, 'finance/finance.sqlite')
      : production
        ? '/data/finance/finance.sqlite'
        : path.resolve(projectRoot, 'data/finance/finance.sqlite');
  const configuredTasksDb = normalizedDatabasePath(env, 'AI_SECRETARY_TASKS_DB');
  const tasksDb = configuredTasksDb
    ? configuredTasksDb
    : env.AI_SECRETARY_DATA_DIR
      ? path.resolve(env.AI_SECRETARY_DATA_DIR, 'tasks/tasks.sqlite')
      : production
        ? '/data/tasks/tasks.sqlite'
        : path.resolve(projectRoot, 'data/tasks/tasks.sqlite');
  const configuredAttachmentsDb = normalizedDatabasePath(env, 'AI_SECRETARY_ATTACHMENTS_DB');
  const attachmentImageUnderstandingEnabled = enabledFlag(
    env,
    'AI_SECRETARY_ATTACHMENT_IMAGE_UNDERSTANDING_ENABLED'
  );
  const imageInputTokenReservation = boundedInteger(
    env,
    'AI_SECRETARY_IMAGE_INPUT_TOKEN_RESERVATION',
    { fallback: 16_384, minimum: 1_024, maximum: 262_144 }
  );
  const attachmentsDb = configuredAttachmentsDb
    ? configuredAttachmentsDb
    : env.AI_SECRETARY_DATA_DIR
      ? path.resolve(env.AI_SECRETARY_DATA_DIR, 'attachments/attachments.sqlite')
      : production
        ? '/data/attachments/attachments.sqlite'
        : path.resolve(projectRoot, 'data/attachments/attachments.sqlite');
  const configuredAttachmentStorageRoot = normalizedDatabasePath(
    env,
    'AI_SECRETARY_ATTACHMENT_STORAGE_ROOT'
  );
  const attachmentStorageRoot = configuredAttachmentStorageRoot
    ? configuredAttachmentStorageRoot
    : env.AI_SECRETARY_DATA_DIR
      ? path.resolve(env.AI_SECRETARY_DATA_DIR, 'attachments/storage')
      : production
        ? '/data/attachments/storage'
        : path.resolve(projectRoot, 'data/attachments/storage');
  const privacyDb = env.AI_SECRETARY_PRIVACY_DB
    ? path.resolve(env.AI_SECRETARY_PRIVACY_DB)
    : env.AI_SECRETARY_DATA_DIR
      ? path.resolve(env.AI_SECRETARY_DATA_DIR, 'privacy/privacy.sqlite')
      : production
        ? '/data/privacy/privacy.sqlite'
        : path.resolve(projectRoot, 'data/privacy/privacy.sqlite');
  const privacyExportDir = env.AI_SECRETARY_PRIVACY_EXPORT_DIR
    ? path.resolve(env.AI_SECRETARY_PRIVACY_EXPORT_DIR)
    : env.AI_SECRETARY_DATA_DIR
      ? path.resolve(env.AI_SECRETARY_DATA_DIR, 'privacy/exports')
      : production
        ? '/data/privacy/exports'
        : path.resolve(projectRoot, 'data/privacy/exports');
  return {
    publicDir: env.AI_SECRETARY_PUBLIC_DIR || path.join(projectRoot, 'apps/desktop/dist'),
    port: Number(env.AI_SECRETARY_PORT || 8080),
    host: env.AI_SECRETARY_HOST || '0.0.0.0',
    authDb,
    accessControlDb: accessControl.dbPath,
    trustedProxyIps: accessControl.trustedProxyIps,
    conversationDb,
    financeDb,
    financeF201Enabled,
    tasksDb,
    learningRealtimeEnabled: enabledFlag(env, 'AI_FENSHEN_LEARNING_REALTIME_ENABLED'),
    learningSpeechEnabled: enabledFlag(env, 'AI_FENSHEN_LEARNING_SPEECH_ENABLED'),
    learningEnabled: enabledFlag(env, 'AI_FENSHEN_LEARNING_ENABLED'),
    voiceChatEnabled: enabledFlag(env, 'AI_FENSHEN_VOICE_CHAT_ENABLED'),
    voiceCoreOptions: {
      lowLatency: enabledFlag(env, 'AI_FENSHEN_VOICE_LOW_LATENCY'),
      ordinaryChat: enabledFlag(env, 'AI_FENSHEN_VOICE_ORDINARY_CHAT'),
      conservativeInterruption: enabledFlag(env, 'AI_FENSHEN_VOICE_CONSERVATIVE_INTERRUPTION')
    },
    learningKeyFile: configuredAbsolutePath(env, 'AI_FENSHEN_LEARNING_KEY_FILE'),
    healthEnabled: enabledFlag(env, 'AI_FENSHEN_HEALTH_ENABLED'),
    healthKeyFile: configuredAbsolutePath(env, 'AI_FENSHEN_HEALTH_KEY_FILE'),
    diaryEnabled: enabledFlag(env, 'AI_FENSHEN_DIARY_ENABLED'),
    diaryKeyFile: configuredAbsolutePath(env, 'AI_FENSHEN_DIARY_KEY_FILE'),
    attachmentsDb,
    attachmentStorageRoot,
    attachmentImageUnderstandingEnabled,
    imageInputTokenReservation,
    financeTimezone: env.AI_SECRETARY_FINANCE_TIMEZONE || 'Asia/Shanghai',
    aiConfig: env.AI_SECRETARY_AI_CONFIG || path.join(projectRoot, 'data', 'ai', 'settings.json'),
    providerHealthStore: configuredProviderHealthStore || (
      production
        ? '/data/ai/provider-health.json'
        : path.join(projectRoot, 'data', 'ai', 'provider-health.json')
    ),
    providerRegistry,
    meetingTranscriptionLocalProvider,
    meetingTranscriptionProviderRegistry,
    meetingTranscriptionCredentialsFile: configuredAbsolutePath(
      env,
      'AI_SECRETARY_MEETING_ASR_CREDENTIALS_FILE',
      production ? null : path.join(os.homedir(), 'Library/Application Support/AI-Fenshen/secrets/xfyun-meeting-asr.env')
    ),
    recordingAttemptDb: configuredRecordingAttemptDb,
    meetingTranscriptionDiagnosticLog: configuredMeetingTranscriptionDiagnosticLog,
    meetingInputDiagnosticScopeFile,
    meetingRecordingScope: env.AI_SECRETARY_MEETING_RECORDING_SCOPE || 'meeting-space',
    meetingGeneration: env.AI_SECRETARY_MEETING_GENERATION || '',
    meetingImplementationCommit: env.AI_SECRETARY_MEETING_IMPLEMENTATION_COMMIT || '',
    meetingClientBuildId: env.AI_SECRETARY_MEETING_CLIENT_BUILD_ID || '',
    meetingAssetVersionId: env.AI_SECRETARY_MEETING_ASSET_VERSION_ID || '',
    protectedMemoryDb: protectedMemory.databasePath,
    protectedMemoryScope: protectedMemory.scope,
    privacyDb,
    privacyExportDir,
    privacyRequired: true,
    cookieSecret: env.AI_SECRETARY_COOKIE_SECRET || '',
    secureCookie: env.AI_SECRETARY_SECURE_COOKIE
      ? env.AI_SECRETARY_SECURE_COOKIE !== 'false'
      : production
  };
}
