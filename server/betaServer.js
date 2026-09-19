import { createQwenLearningSpeech } from './learning/qwenSpeech.js';
import { createLearningRuntime } from './learning/runtime.js';
import { handleLearningApi } from './learning/httpApi.js';
import { healthPrivateAiService } from './health/aiPrivacy.js';
import { createHealthRuntime, createHealthLifecycleRuntime } from './health/runtime.js';
import { handleHealthApi } from './health/httpApi.js';
import { withHealthAssistant } from './health/conversation.js';
import { createDiaryRuntime, createDiaryLifecycleRuntime } from './diary/runtime.js';
import { handleDiaryApi } from './diary/httpApi.js';
import { withDiaryAssistant, diaryHomeTasks } from './diary/integration.js';
import { chmodSync, createReadStream, readFileSync, existsSync, lstatSync, mkdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BetaAuthService } from '../core/auth/betaAuthService.js';
import { authorizeRole } from '../core/auth/accessControl.js';
import { resolveBetaServerConfig } from './betaServerConfig.js';
import { createCoreAiService } from './coreAiService.js';
import { createRealUserMemoryRuntime } from '../memory/integration/index.js';
import { handleMemoryApi } from './memoryApi.js';
import { handleConversationApi } from './conversation/httpApi.js';
import { createConversationRuntime } from './conversation/runtime.js';
import { createProtectedMemoryRuntime } from './memory/protectedMemoryRuntime.js';
import { loadProtectedMemoryRuntimeConfig } from './memory/protectedMemoryConfig.js';
import { createGroundedMemoryResponder } from './memory/groundedMemoryResponder.js';
import { createSemanticMemoryPlanner } from './memory/semanticMemoryPlanner.js';
import { createFinanceRuntime } from './finance/runtime.js';
import { handleFinanceApi } from './finance/httpApi.js';
import { createTasksRuntime } from './tasks/runtime.js';
import { handleTasksApi } from './tasks/httpApi.js';
import { createAttachmentRuntime } from './attachments/runtime.js';
import { handleAttachmentsApi } from './attachments/httpApi.js';
import { createAssistantAgentOrchestrator } from './agent/assistantAgentOrchestrator.js';
import { createAssistantSemanticPlanner } from './agent/assistantSemanticPlanner.js';
import { createAssistantToolRegistry } from './tools/assistantToolRegistry.js';
import { createCalendarTool } from './tools/calendar/calendarTool.js';
import { createTasksTool } from './tools/tasks/tasksTool.js';
import { AccessControlStore } from './access/accessControlStore.js';
import { AccessControlService } from './access/accessControlService.js';
import { resolveTrustedClientIp } from './access/trustedClientIp.js';
import { PrivacyLifecycle } from './privacy/privacyLifecycle.js';
import { handlePrivacyApi, sendConsentRequired } from './privacy/httpApi.js';
import { createVoiceDictationRuntime } from './voiceDictation/runtime.js';
import { handleVoiceDictationApi } from './voiceDictation/httpApi.js';
import { createVoiceChatRuntime } from './voiceChat/runtime.js';
import { handleVoiceChatApi } from './voiceChat/httpApi.js';
import { createMeetingSpeechGateway } from '../core/meeting/stage3a/meetingSpeechGateway.js';
import { handleMeetingAnalysisApi } from './meeting/meetingAnalysisHttpApi.js';
import { handleMeetingTranscriptionApi } from './meeting/meetingTranscriptionHttpApi.js';
import {
  createLocalMeetingSpeechGateway,
  createProviderRegistryMeetingSpeechGateway
} from './meeting/meetingTranscriptionRuntime.js';
import { handleMeetingRecordingAttemptApi } from './meeting/meetingRecordingAttemptHttpApi.js';
import { MeetingRecordingAttemptStore } from './meeting/meetingRecordingAttemptStore.js';
import { createMeetingTranscriptionDiagnosticLogger } from './meeting/meetingTranscriptionDiagnostic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const defaultConfig = resolveBetaServerConfig({ projectRoot: rootDir });

const contentTypes = {
  '.html': 'text/html;charset=utf-8',
  '.js': 'text/javascript;charset=utf-8',
  '.css': 'text/css;charset=utf-8',
  '.json': 'application/json;charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json;charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(body));
}

function safeCandidateHeader(value, maximum = 160) {
  const normalized = String(value ?? '').trim();
  return /^[A-Za-z0-9._:/-]+$/.test(normalized) ? normalized.slice(0, maximum) : '';
}

export function candidateVersionHealthHeaders(candidateVersion = null) {
  if (!candidateVersion || typeof candidateVersion !== 'object') return {};
  const generation = Number(candidateVersion.checkpointGeneration);
  const branch = safeCandidateHeader(candidateVersion.branch);
  const stateCommit = safeCandidateHeader(candidateVersion.stateCommit, 64);
  const sourceHead = safeCandidateHeader(candidateVersion.sourceHead, 64);
  const buildMarker = safeCandidateHeader(candidateVersion.buildMarker, 96);
  if (!Number.isSafeInteger(generation) || generation < 0 || !branch || !stateCommit || !sourceHead || !buildMarker) return {};
  return {
    'X-Candidate-Checkpoint-Generation': String(generation),
    'X-Candidate-Branch': branch,
    'X-Candidate-State-Commit': stateCommit,
    'X-Candidate-Source-Head': sourceHead,
    'X-Candidate-Build-Marker': buildMarker
  };
}

function rejectUnavailableSession(res, session) {
  if (session?.code !== 'ACCESS_CONTROL_UNAVAILABLE') return false;
  sendJson(res, 503, {
    ok: false,
    code: 'ACCESS_CONTROL_UNAVAILABLE',
    message: '访问控制服务暂时不可用，请稍后再试。'
  });
  return true;
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 32 * 1024) throw new Error('Payload too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function safeStaticPath(urlPath, publicDir) {
  const pathname = decodeURIComponent(urlPath.split('?')[0]);
  const requested = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(publicDir, `.${requested}`);
  return resolved.startsWith(path.resolve(publicDir)) ? resolved : path.join(publicDir, 'index.html');
}

function serveStatic(req, res, publicDir) {
  const pathname = decodeURIComponent(String(req.url || '/').split('?')[0]);
  const requestedPath = safeStaticPath(req.url || '/', publicDir);
  const requestedExtension = path.extname(pathname);
  let filePath = requestedPath;
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    // Client-side routes may fall back to the shell; missing versioned assets
    // must remain a real 404 so stale/mixed builds cannot masquerade as HTML.
    if (requestedExtension) {
      res.writeHead(404, { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end('Not Found');
      return;
    }
    filePath = path.join(publicDir, 'index.html');
  }
  const ext = path.extname(filePath);
  const isHtmlShell = ext === '.html';
  const cacheControl = isHtmlShell
    ? 'no-store, no-cache, must-revalidate'
    : pathname.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';
  res.writeHead(200, {
    'Content-Type': contentTypes[ext] || 'application/octet-stream',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()'
  });
  createReadStream(filePath).pipe(res);
}

function disabledLegacyMemoryRuntime() {
  return {
    service: {},
    async initialize() { return { status: 'disabled', reasonCode: 'PROTECTED_ACCEPTANCE_MEMORY_ACTIVE', pathSummary: 'isolated acceptance memory' }; },
    async close() {}
  };
}

async function cleanupFailedServerInitialization(stack) {
  const cleanupCodes = [];
  for (const task of [...stack].reverse()) {
    try { await task.run(); } catch (error) {
      cleanupCodes.push(`${task.label}:${String(error?.code || error?.message || 'FAILED')}`);
    }
  }
  return cleanupCodes;
}

export async function createBetaServer({ config = defaultConfig, aiService: aiServiceOverride,
  memoryRuntime: memoryRuntimeOverride, conversationRuntime: conversationRuntimeOverride,
  protectedMemoryRuntime: protectedMemoryRuntimeOverride, financeRuntime: financeRuntimeOverride,
  tasksRuntime: tasksRuntimeOverride, attachmentRuntime: attachmentRuntimeOverride,
  accessControlStore: accessControlStoreOverride, accessControl: accessControlOverride,
  auth: authOverride, privacyLifecycle: privacyLifecycleOverride,
  voiceDictationRuntime: voiceDictationRuntimeOverride,
  meetingSpeechGateway: meetingSpeechGatewayOverride,
  meetingTranscriptionDiagnosticLogger = null,
  meetingDiagnosticScopeResolver = null,
  runtimeFactories = {} } = {}) {
  const initializationCleanup = [];
  const registeredResources = new WeakSet();
  const registerInitializationResource = (label, resource) => {
    if (!resource || (typeof resource !== 'object' && typeof resource !== 'function') ||
        typeof resource.close !== 'function' || registeredResources.has(resource)) return;
    registeredResources.add(resource);
    initializationCleanup.push({ label, run: () => resource.close() });
  };
  try {
  const { publicDir, authDb, cookieSecret, secureCookie } = config;
  for (const [label, resource] of [
    ['finance', financeRuntimeOverride],
    ['conversation', conversationRuntimeOverride],
    ['protected_memory', protectedMemoryRuntimeOverride],
    ['memory', memoryRuntimeOverride],
    ['tasks', tasksRuntimeOverride],
    ['attachments', attachmentRuntimeOverride],
    ['access', accessControlStoreOverride],
    ['auth', authOverride],
    ['privacy', privacyLifecycleOverride],
    ['voice_dictation', voiceDictationRuntimeOverride]
  ]) registerInitializationResource(label, resource);
  const invokeInternalFactory = (label, factory, input) => {
    try {
      return factory(input);
    } catch (error) {
      error.unprovenPartialInitialization = label;
      throw error;
    }
  };
  let financeRuntime = financeRuntimeOverride || null;
  if (financeRuntimeOverride === undefined && config.financeDb && config.financeF201Enabled === true) {
    financeRuntime = invokeInternalFactory('finance', runtimeFactories.finance || createFinanceRuntime, {
      databasePath: config.financeDb,
      timezone: config.financeTimezone || 'Asia/Shanghai',
      applyMigrations: false,
      f201Enabled: true
    });
    registerInitializationResource('finance', financeRuntime);
  }
  mkdirSync(path.dirname(authDb), { recursive: true });
  let accessControlStore = accessControlStoreOverride || null;
  if (!accessControlStore) {
    accessControlStore = new AccessControlStore({
      dbPath: config.accessControlDb || path.join(path.dirname(authDb), 'access-control.sqlite')
    });
    try {
      accessControlStore.initialize();
    } catch (error) {
      try { accessControlStore.close(); } catch (cleanupError) {
        error.cleanupCodes = [`access:${String(cleanupError?.code || cleanupError?.message || 'FAILED')}`];
      }
      throw error;
    }
    registerInitializationResource('access', accessControlStore);
  }
  const accessControl = accessControlOverride || new AccessControlService({
    store: accessControlStore,
    hmacSecret: cookieSecret,
    imageInputTokenReservation: config.imageInputTokenReservation
  });
  let auth = authOverride || null;
  if (!auth) {
    auth = new BetaAuthService({
      dbPath: authDb,
      cookieSecret,
      secureCookie,
      accessControl
    });
    try {
      await auth.initialize();
    } catch (error) {
      try { await auth.close(); } catch (cleanupError) {
        error.cleanupCodes = [
          ...(Array.isArray(error.cleanupCodes) ? error.cleanupCodes : []),
          `auth:${String(cleanupError?.code || cleanupError?.message || 'FAILED')}`
        ];
      }
      throw error;
    }
    registerInitializationResource('auth', auth);
  }
  for (const account of await auth.listAccounts()) {
    if (account.role === 'admin' && !accessControl.getAccountAccess(account.id)) {
      accessControl.bindAccountProfile({
        accountId: account.id,
        profileId: 'closed_beta_admin_v1',
        enabled: account.status === 'active'
      });
      accessControl.recordSecurityEvent({
        eventType: 'existing_admin_quota_bootstrap',
        accountId: account.id,
        outcome: 'applied',
        reasonCode: 'GENERATION_120_ACCESS_CONTROL_BOOTSTRAP'
      });
    }
  }
  const aiService = aiServiceOverride || createCoreAiService({
    configPath: config.aiConfig || path.join(path.dirname(authDb), 'ai-settings.json'),
    healthStorePath: config.providerHealthStore,
    providerRegistryConfig: config.providerRegistry,
    accessControl
  });
  if(config.learningEnabled===true && config.learningSpeechEnabled===true && aiService.router) aiService.router.speechRuntime=createQwenLearningSpeech({aiService});
  let protectedMemoryRuntime = protectedMemoryRuntimeOverride || null;
  if (protectedMemoryRuntimeOverride === undefined && config.protectedMemoryDb && config.protectedMemoryScope) {
    const protectedConfig = loadProtectedMemoryRuntimeConfig({
      repositoryRoot: rootDir,
      databasePath: config.protectedMemoryDb,
      scope: config.protectedMemoryScope
    });
    mkdirSync(path.dirname(protectedConfig.databasePath), { recursive: true });
    protectedMemoryRuntime = invokeInternalFactory(
      'protected_memory',
      runtimeFactories.protectedMemory || createProtectedMemoryRuntime,
      {
      ...protectedConfig,
      repositoryRoot: rootDir,
      semanticPlanner: createSemanticMemoryPlanner({ aiService }),
      groundedResponder: createGroundedMemoryResponder({ aiService })
      }
    );
    registerInitializationResource('protected_memory', protectedMemoryRuntime);
  }
  if (financeRuntimeOverride === undefined && config.financeDb && config.financeF201Enabled !== true) {
    mkdirSync(path.dirname(config.financeDb), { recursive: true });
    financeRuntime = invokeInternalFactory('finance', runtimeFactories.finance || createFinanceRuntime, {
      databasePath: config.financeDb,
      timezone: config.financeTimezone || 'Asia/Shanghai',
      applyMigrations: true,
      f201Enabled: false
    });
    registerInitializationResource('finance', financeRuntime);
  }
  let tasksRuntime = tasksRuntimeOverride || null;
  if (tasksRuntimeOverride === undefined && config.tasksDb) {
    mkdirSync(path.dirname(config.tasksDb), { recursive: true });
    tasksRuntime = invokeInternalFactory('tasks', runtimeFactories.tasks || createTasksRuntime, {
      databasePath: config.tasksDb,
      applyMigrations: true
    });
    registerInitializationResource('tasks', tasksRuntime);
  }
  let diaryRuntime = null;
  if (config.diaryEnabled === true) {
    if (!tasksRuntime?.database || !tasksRuntime?.service) throw new Error('DIARY_TASKS_REQUIRED');
    const encryptionKey = config.diaryEncryptionKey || (config.diaryKeyFile ? readFileSync(config.diaryKeyFile) : null);
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) throw new Error('DIARY_KEY_REQUIRED');
    diaryRuntime = createDiaryRuntime({ database: tasksRuntime.database, tasksService: tasksRuntime.service,
      encryptionKey, clock: tasksRuntime.clock, applyMigrations: true });
    registerInitializationResource('diary', diaryRuntime);
  }
  const diaryLifecycleRuntime = diaryRuntime || (tasksRuntime?.database ? createDiaryLifecycleRuntime({
    database: tasksRuntime.database, tasksService: tasksRuntime.service,
    encryptionKey: config.diaryEncryptionKey || (config.diaryKeyFile && existsSync(config.diaryKeyFile) ? readFileSync(config.diaryKeyFile) : null),
    clock: tasksRuntime.clock
  }) : null);
  registerInitializationResource('diary_lifecycle',diaryLifecycleRuntime);
  let healthRuntime = null;
  if (config.healthEnabled === true) {
    if (!tasksRuntime?.database || !tasksRuntime?.service) throw new Error('HEALTH_TASKS_REQUIRED');
    const encryptionKey = config.healthEncryptionKey || (config.healthKeyFile ? readFileSync(config.healthKeyFile) : null);
    healthRuntime = createHealthRuntime({database:tasksRuntime.database,tasksService:tasksRuntime.service,encryptionKey,clock:tasksRuntime.clock,applyMigrations:true});
    registerInitializationResource('health',healthRuntime);
  }
  const healthLifecycleRuntime = healthRuntime || (tasksRuntime?.database ? createHealthLifecycleRuntime({database:tasksRuntime.database,tasksService:tasksRuntime.service,encryptionKey:config.healthEncryptionKey || (config.healthKeyFile && existsSync(config.healthKeyFile) ? readFileSync(config.healthKeyFile) : null),clock:tasksRuntime.clock}) : null);
  registerInitializationResource('health_lifecycle',healthLifecycleRuntime);
  const assistantToolRegistry = createAssistantToolRegistry();
  assistantToolRegistry.register(createCalendarTool());
  if (tasksRuntime?.service) assistantToolRegistry.register(createTasksTool({ service: tasksRuntime.service }));
  const assistantSemanticPlanner = typeof aiService.run === 'function'
    ? createAssistantSemanticPlanner({
        aiService,
        toolDescriptors: assistantToolRegistry.descriptors()
      })
    : null;
  const conversationRuntime = conversationRuntimeOverride === undefined && config.conversationDb
    ? invokeInternalFactory('conversation', runtimeFactories.conversation || createConversationRuntime, {
      databasePath: config.conversationDb,
      aiService: healthPrivateAiService(aiService),
      applyMigrations: true,
      memoryPolicy: protectedMemoryRuntime ? 'protected_acceptance' : 'disabled',
      assistantAgent: withHealthAssistant(withDiaryAssistant(createAssistantAgentOrchestrator({
        financeService: financeRuntime?.service || null,
        memoryIntegration: protectedMemoryRuntime,
        semanticPlanner: assistantSemanticPlanner,
        toolRegistry: assistantToolRegistry,
        timezone: financeRuntime?.timezone || config.financeTimezone || 'Asia/Shanghai',
        clock: financeRuntime?.clock || (() => new Date())
      }), diaryRuntime, {getMessages: input => conversationRuntime.messages.listForConversationOwner(input.conversationId,input.ownerId)}), healthRuntime, {aiService,getMessages: input => conversationRuntime.messages.listForConversationOwner(input.conversationId,input.ownerId)})
    })
    : conversationRuntimeOverride || null;
  if (conversationRuntimeOverride === undefined && conversationRuntime) {
    registerInitializationResource('conversation', conversationRuntime);
  }
  const learningRuntime = conversationRuntime?.database ? createLearningRuntime({database:conversationRuntime.database,
    encryptionKey:config.learningEncryptionKey || (config.learningKeyFile && existsSync(config.learningKeyFile) ? readFileSync(config.learningKeyFile) : null),
    aiService,enabled:config.learningEnabled===true}) : null;
  registerInitializationResource('learning',learningRuntime);
  if(learningRuntime) conversationRuntime.service.isLearningConversation=(id,owner)=>learningRuntime.repository.isLearningConversation(id,owner);
  const memoryRuntime = memoryRuntimeOverride || (protectedMemoryRuntime
    ? disabledLegacyMemoryRuntime()
    : invokeInternalFactory(
        'memory',
        runtimeFactories.memory || createRealUserMemoryRuntime,
        { projectRoot: rootDir }
      ));
  let memoryStatus;
  registerInitializationResource('memory', memoryRuntime);
  try {
    memoryStatus = await memoryRuntime.initialize();
  } catch (error) {
    memoryStatus = { status: 'unavailable', reasonCode: error?.code || 'MEMORY_INITIALIZATION_FAILED', pathSummary: 'data/memory/memory.sqlite' };
  }
  let attachmentRuntime = attachmentRuntimeOverride || null;
  if (attachmentRuntimeOverride === undefined && config.attachmentsDb && config.attachmentStorageRoot) {
    mkdirSync(path.dirname(config.attachmentsDb), { recursive: true, mode: 0o700 });
    attachmentRuntime = invokeInternalFactory('attachments', runtimeFactories.attachments || createAttachmentRuntime, {
      databasePath: config.attachmentsDb,
      storageRoot: config.attachmentStorageRoot,
      accessControl,
      conversationRuntime,
      aiService,
      limits: config.attachmentLimits,
      cleanupIntervalMs: config.attachmentCleanupIntervalMs,
      clock: config.attachmentClock,
      logger: config.attachmentLogger
    });
    registerInitializationResource('attachments', attachmentRuntime);
  }
  conversationRuntime?.service?.setAttachmentProcessor?.(
    attachmentRuntime?.processingService || null
  );
  const privacyRoot = path.join(path.dirname(authDb), 'privacy');
  const privacyExportDir = config.privacyExportDir || path.join(privacyRoot, 'exports');
  if (typeof config.privacyStorageGuard === 'function') {
    config.privacyStorageGuard('beta_server_startup');
    const exportStats = lstatSync(privacyExportDir);
    if (!exportStats.isDirectory() || exportStats.isSymbolicLink()) {
      throw Object.assign(new Error('Privacy export path must be a reserved real directory.'), {
        code: 'PRIVACY_STORAGE_UNSAFE'
      });
    }
  } else {
    mkdirSync(privacyExportDir, { recursive: true, mode: 0o700 });
  }
  if (!lstatSync(privacyExportDir).isDirectory() || lstatSync(privacyExportDir).isSymbolicLink()) {
    throw Object.assign(new Error('Privacy export path must be a directory.'), {
      code: 'PRIVACY_EXPORT_DIR_INVALID'
    });
  }
  if (typeof config.privacyStorageGuard !== 'function') chmodSync(privacyExportDir, 0o700);
  const privacyLifecycleInput = {
    dbPath: config.privacyDb || path.join(privacyRoot, 'privacy.sqlite'),
    exportDir: privacyExportDir,
    policy: config.privacyNotice,
    secret: cookieSecret,
    auth,
    accessControl,
    conversationRuntime,
    protectedMemoryRuntime,
    financeRuntime,
    tasksRuntime,
    diaryRuntime: diaryLifecycleRuntime,
    healthRuntime: healthLifecycleRuntime,
    learningRuntime,
    attachmentRuntime,
    exportStorageGuard: config.privacyStorageGuard,
    exportTtlMs: config.privacyExportTtlMs,
    deletionTtlMs: config.privacyDeletionTtlMs
  };
  const privacyLifecycle = privacyLifecycleOverride || invokeInternalFactory(
    'privacy',
    runtimeFactories.privacy || ((input) => new PrivacyLifecycle(input)),
    privacyLifecycleInput
  );
  registerInitializationResource('privacy', privacyLifecycle);
  const privacyRequired = config.privacyRequired === true;
  const featureFlags = Object.freeze({
    ...(config.voiceChatEnabled === true ? { voiceChatEnabled: true } : {}),
    financeF201Enabled: config.financeF201Enabled === true,
    ...(diaryRuntime ? { diaryEnabled: true } : {}),
    ...(healthRuntime ? { healthEnabled: true } : {})
  });
  let voiceDictationRuntime = voiceDictationRuntimeOverride || null;
  const voiceChatRuntime = invokeInternalFactory('voice_chat', runtimeFactories.voiceChat || createVoiceChatRuntime, {
    enabled: config.voiceChatEnabled === true, conversationRuntime, aiService, accessControl,
    coreOptions: config.voiceCoreOptions,
    financeRuntime, protectedMemoryRuntime, diaryRuntime, healthRuntime,
    semanticPlanner: assistantSemanticPlanner, toolRegistry: assistantToolRegistry
  });
  registerInitializationResource('voice_chat', voiceChatRuntime);
  // Construct outside the request handler so the closure retains only the
  // original cookie string and owner, never the request/response or body.
  function voiceAuthorizationValidator(cookie, ownerId) {
    return async () => {
      const current = await auth.getCurrentUserFromCookie(cookie);
      if (!current.user || !current.subject) {
        throw Object.assign(new Error(current.code || 'UNAUTHENTICATED'), { code: current.code || 'UNAUTHENTICATED' });
      }
      if (current.user.id !== ownerId || current.subject.accountId !== ownerId) {
        throw Object.assign(new Error('VOICE_ACCOUNT_MISMATCH'), { code: 'VOICE_ACCOUNT_MISMATCH' });
      }
      if (privacyRequired) privacyLifecycle.requireCurrentConsent(ownerId);
      return current.subject;
    };
  }
  if (!voiceDictationRuntime) {
    voiceDictationRuntime = invokeInternalFactory(
      'voice_dictation',
      runtimeFactories.voiceDictation || createVoiceDictationRuntime,
      {}
    );
    registerInitializationResource('voice_dictation', voiceDictationRuntime);
  }
  const effectiveMeetingTranscriptionDiagnosticLogger = meetingTranscriptionDiagnosticLogger
    || (config.meetingTranscriptionDiagnosticLog
      ? createMeetingTranscriptionDiagnosticLogger({
        filePath: config.meetingTranscriptionDiagnosticLog,
        scopeFilePath: config.meetingInputDiagnosticScopeFile || ''
      })
      : null);
  registerInitializationResource('meeting_transcription_diagnostics', effectiveMeetingTranscriptionDiagnosticLogger);
  const meetingSpeechGateway = meetingSpeechGatewayOverride || (
    config.meetingTranscriptionProviderRegistry === true
      ? createProviderRegistryMeetingSpeechGateway({
        credentialResolver: aiService?.credentialResolver,
        providerOptions: { diagnosticLogger: effectiveMeetingTranscriptionDiagnosticLogger }
      })
      : config.meetingTranscriptionLocalProvider === true
      ? createLocalMeetingSpeechGateway({
        credentialsFilePath: config.meetingTranscriptionCredentialsFile,
        providerOptions: { diagnosticLogger: effectiveMeetingTranscriptionDiagnosticLogger }
      })
      : createMeetingSpeechGateway()
  );
  let meetingRecordingAttemptStore = null;
  if (config.recordingAttemptDb) {
    meetingRecordingAttemptStore = new MeetingRecordingAttemptStore({ dbPath: config.recordingAttemptDb });
    meetingRecordingAttemptStore.initialize();
    registerInitializationResource('meeting_recording_attempts', meetingRecordingAttemptStore);
  }
  const effectiveMeetingDiagnosticScopeResolver = meetingDiagnosticScopeResolver || (
    meetingRecordingAttemptStore
      ? ({ ownerId, recordingAttemptId, meetingId, sourceId }) => {
        const expectedScope = String(config.meetingRecordingScope || 'meeting-space').trim();
        const attempt = recordingAttemptId
          ? meetingRecordingAttemptStore.findByAttempt({ authenticatedUserId: ownerId, recordingAttemptId })
          : meetingRecordingAttemptStore.findBySource({ authenticatedUserId: ownerId, meetingId, sourceId });
        if (!attempt || String(attempt.scope || '').trim() !== expectedScope) return null;
        if (meetingId && String(attempt.meetingId || '').trim() !== String(meetingId).trim()) return null;
        if (sourceId && String(attempt.sourceId || '').trim() !== String(sourceId).trim()) return null;
        return Object.freeze({
          ownerId: attempt.ownerId,
          meetingId: attempt.meetingId,
          sourceId: attempt.sourceId,
          scope: attempt.scope
        });
      }
      : null
  );

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/healthz') {
        res.writeHead(200, {
          'Content-Type': 'text/plain;charset=utf-8',
          'Cache-Control': 'no-store',
          ...candidateVersionHealthHeaders(config.candidateVersion)
        });
        res.end('ok\n');
        return;
      }

      if (url.pathname === '/api/auth/me' && req.method === 'GET') {
        const result = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, result)) return;
        sendJson(res, result.user ? 200 : 401, result.user
          ? { ok: true, user: result.user, featureFlags }
          : { ok: false, user: null });
        return;
      }

      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await readJson(req);
        const result = await auth.login({
          username: body.username,
          password: body.password,
          ip: resolveTrustedClientIp(req, config.trustedProxyIps || []),
          userAgent: req.headers['user-agent'] || ''
        });
        if (!result.ok) {
          const status = result.code === 'RATE_LIMITED'
            ? 429
            : result.code === 'ACCESS_CONTROL_UNAVAILABLE'
              ? 503
              : 401;
          sendJson(res, status, {
            ok: false,
            message: status === 401 ? '用户名或密码错误。' : '登录失败，请稍后再试。'
          });
          return;
        }
        sendJson(res, 200, { ok: true, user: result.user, featureFlags }, { 'Set-Cookie': result.setCookie });
        return;
      }

      if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
        if (voiceChatRuntime.enabled) {
          const voiceSession = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
          if (voiceSession.user) voiceChatRuntime.endForOwner(voiceSession.user.id);
        }
        const setCookie = await auth.logoutFromCookie(req.headers.cookie || '');
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': setCookie });
        return;
      }

      if (url.pathname === '/api/voice/dictation') {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
          sendConsentRequired(res, sendJson);
          return;
        }
        await handleVoiceDictationApi({
          req,
          res,
          url,
          session,
          runtime: voiceDictationRuntime,
          sendJson
        });
        return;
      }

      if (url.pathname.startsWith('/api/voice/chat')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
          voiceChatRuntime.endForOwner?.(session.user.id);
          sendConsentRequired(res, sendJson); return;
        }
        await handleVoiceChatApi({ req, res, url, session, runtime: voiceChatRuntime, sendJson, readJson,
          ...(config.voiceCoreOptions?.continuousLifecycle === true ? {
            validateAuthorization: voiceAuthorizationValidator(req.headers.cookie || '', session.user?.id)
          } : {})
        });
        return;
      }

      if (url.pathname === '/api/meeting/analysis') {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
          sendConsentRequired(res, sendJson);
          return;
        }
        await handleMeetingAnalysisApi({
          req,
          res,
          url,
          session,
          aiService,
          accessControl,
          readJson,
          sendJson
        });
        return;
      }

      if (url.pathname.startsWith('/api/meeting/transcription/')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
          sendConsentRequired(res, sendJson);
          return;
        }
        await handleMeetingTranscriptionApi({
          req,
          res,
          url,
          session,
          speechGateway: meetingSpeechGateway,
          sendJson,
          diagnosticLogger: effectiveMeetingTranscriptionDiagnosticLogger,
          recordingAttemptResolver: meetingRecordingAttemptStore
            ? ({ ownerId, recordingAttemptId, meetingId, sourceId }) => recordingAttemptId
              ? meetingRecordingAttemptStore.findByAttempt({
                authenticatedUserId: ownerId,
                recordingAttemptId
              })
              : meetingRecordingAttemptStore.findBySource({
                authenticatedUserId: ownerId,
                meetingId,
                sourceId
              })
            : null,
          resolveDiagnosticScope: effectiveMeetingDiagnosticScopeResolver
        });
        return;
      }

      if (url.pathname === '/api/meeting/recording-attempt' || url.pathname === '/api/meeting/recording-attempt/bind') {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (!meetingRecordingAttemptStore) {
          sendJson(res, 503, { ok: false, code: 'RECORDING_ATTEMPT_STORE_UNAVAILABLE', message: '录音能力预检暂时不可用。' });
          return;
        }
        await handleMeetingRecordingAttemptApi({
          req,
          res,
          url,
          session,
          store: meetingRecordingAttemptStore,
          sendJson,
          expectedGeneration: config.meetingGeneration,
          expectedImplementationCommit: config.meetingImplementationCommit,
          expectedClientBuildId: config.meetingClientBuildId,
          expectedAssetVersionId: config.meetingAssetVersionId,
          recordingScope: config.meetingRecordingScope
        });
        return;
      }

      if (url.pathname.startsWith('/api/privacy/')) {
        if (url.pathname === '/api/privacy/exports' || url.pathname.startsWith('/api/privacy/exports/')) {
          try {
            config.privacyStorageGuard?.();
          } catch {
            sendJson(res, 503, {
              ok: false,
              code: 'PRIVACY_STORAGE_UNSAFE',
              message: '隐私导出存储不可用。'
            });
            return;
          }
        }
        const session = url.pathname === '/api/privacy/notice'
          ? { user: null, subject: null }
          : await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (url.pathname === '/api/privacy/deletion-requests/confirm' && session.user) voiceChatRuntime.endForOwner?.(session.user.id);
        await handlePrivacyApi({
          req, res, url, session, lifecycle: privacyLifecycle, readJson, sendJson
        });
        return;
      }

      if (url.pathname.startsWith('/api/attachments')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
          sendConsentRequired(res, sendJson);
          return;
        }
        await handleAttachmentsApi({
          req,
          res,
          url,
          user: session.user,
          subject: session.subject,
          accessControl,
          runtime: attachmentRuntime,
          enabled: config.attachmentImageUnderstandingEnabled === true,
          sendJson
        });
        return;
      }

      if (url.pathname.startsWith('/api/memory/')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
          sendConsentRequired(res, sendJson);
          return;
        }
        await handleMemoryApi({ req, res, url, user: session.user, service: memoryRuntime.service, readJson, sendJson });
        return;
      }

      if (url.pathname.startsWith('/api/finance/')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
          sendConsentRequired(res, sendJson);
          return;
        }
        const handled = await handleFinanceApi({
          req, res, url, user: session.user, runtime: financeRuntime,
          privacyLifecycle, readJson, sendJson
        });
        if (handled) return;
      }

      if (url.pathname === '/api/learning' || url.pathname.startsWith('/api/learning/')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res,session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {sendConsentRequired(res,sendJson);return;}
        if(await handleLearningApi({req,res,url,user:session.user,subject:session.subject,runtime:learningRuntime,accessControl,readJson,sendJson}))return;
      }

      if (url.pathname === '/api/health' || url.pathname.startsWith('/api/health/')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res,session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) { sendConsentRequired(res,sendJson); return; }
        if (await handleHealthApi({req,res,url,user:session.user,subject:session.subject,runtime:healthRuntime,lifecycleRuntime:healthLifecycleRuntime,aiService,accessControl,sendJson})) return;
      }

      if (url.pathname === '/api/diary' || url.pathname.startsWith('/api/diary/')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
          sendConsentRequired(res, sendJson); return;
        }
        if (await handleDiaryApi({req,res,url,user:session.user,runtime:diaryRuntime,readJson,sendJson})) return;
      }

      if (url.pathname.startsWith('/api/tasks')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
          sendConsentRequired(res, sendJson);
          return;
        }
        const diaryTaskMutation = url.pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(?:complete|restore))?$/);
        if (healthLifecycleRuntime && session.user && diaryTaskMutation && ['POST','PATCH','DELETE'].includes(req.method)) {
          const healthId = healthLifecycleRuntime.service.healthIdForTask(session.user.id,decodeURIComponent(diaryTaskMutation[1]));
          if (healthId) { sendJson(res,409,{ok:false,code:'HEALTH_REMINDER_USE_HEALTH',message:'请打开健康记录管理这条提醒。',healthId}); return; }
        }
        if (diaryLifecycleRuntime && session.user && diaryTaskMutation && ['POST','PATCH','DELETE'].includes(req.method)) {
          const diaryId = diaryLifecycleRuntime.service.diaryIdForTask(session.user.id,decodeURIComponent(diaryTaskMutation[1]));
          if (diaryId) { sendJson(res,409,{ok:false,code:'DIARY_REMINDER_USE_DIARY',message:'请打开对应日记管理这条提醒。',diaryId}); return; }
        }
        if ((diaryRuntime || healthRuntime) && session.user && url.pathname === '/api/tasks/today-tomorrow' && req.method === 'GET') {
          const timezone = url.searchParams.get('timezone');
          try {
            const base = tasksRuntime.service.todayTomorrow(session.user.id, {timezone});
            const payload = diaryHomeTasks(base, [...(diaryRuntime?.service.reminders(session.user.id, {timezone})||[]),...(healthRuntime?.service.reminders(session.user.id, {timezone})||[])]);
            sendJson(res,200,{ok:true,...payload});
          } catch { sendJson(res,503,{ok:false,message:'事项暂时无法读取，请稍后重试。'}); }
          return;
        }
        const handled = await handleTasksApi({
          req, res, url, user: session.user, runtime: tasksRuntime, readJson, sendJson
        });
        if (handled) return;
      }

      if (url.pathname === '/api/user/export-scope' && req.method === 'GET') {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (!session.user) {
          sendJson(res, 401, { ok: false, message: '请先登录。' });
          return;
        }
        sendJson(res, 200, { ok: true, userId: session.user.id });
        return;
      }

      if (url.pathname === '/api/ai/status' && req.method === 'GET') {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (!session.user) {
          sendJson(res, 401, { ok: false, message: '请先登录。' });
          return;
        }
        sendJson(res, 200, { ok: true, ...aiService.getStatus() });
        return;
      }

      if (url.pathname.startsWith('/api/ai/chat/') || url.pathname === '/api/ai/conversations' || url.pathname.startsWith('/api/ai/conversations/')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        if (privacyRequired && session.user && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
          sendConsentRequired(res, sendJson);
          return;
        }
        const handled = await handleConversationApi({
          req,
          res,
          url,
          user: session.user,
          subject: session.subject,
          accessControl,
          runtime: conversationRuntime,
          attachmentRuntime,
          readJson,
          sendJson
        });
        if (handled) return;
      }

      if (url.pathname === '/api/ai/chat' && req.method === 'POST') {
        sendJson(res, 410, {
          ok: false,
          code: 'LEGACY_CHAT_ENDPOINT_RETIRED',
          message: '该接口已停用，请使用正式聊天入口。'
        });
        return;
      }

      if (url.pathname.startsWith('/api/admin/')) {
        const session = await auth.getCurrentUserFromCookie(req.headers.cookie || '');
        if (rejectUnavailableSession(res, session)) return;
        const access = authorizeRole(session.user, 'admin');
        if (!access.allowed) {
          sendJson(res, access.status, { ok: false, message: access.status === 401 ? '请先登录。' : '无权限。' });
          return;
        }
        if (url.pathname === '/api/admin/users' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, users: await auth.listAccounts() });
          return;
        }
        if (url.pathname === '/api/admin/system-status' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, status: 'available' });
          return;
        }
        if (url.pathname === '/api/admin/access/profiles' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, profiles: accessControl.listQuotaProfiles() });
          return;
        }
        const accessProfileMatch = url.pathname.match(/^\/api\/admin\/access\/profiles\/([^/]+)$/);
        if (accessProfileMatch && req.method === 'PUT') {
          try {
            const profile = accessControl.putCustomQuotaProfile({
              ...await readJson(req),
              id: decodeURIComponent(accessProfileMatch[1])
            });
            accessControl.recordSecurityEvent({
              eventType: 'quota_profile_updated',
              subject: session.user.id,
              outcome: 'applied',
              reasonCode: profile.id
            });
            sendJson(res, 200, { ok: true, profile });
          } catch (error) {
            sendJson(res, 400, { ok: false, code: error?.code || 'QUOTA_PROFILE_INVALID', message: '限额配置无效。' });
          }
          return;
        }
        const accessAccountMatch = url.pathname.match(/^\/api\/admin\/access\/accounts\/([^/]+)$/);
        if (accessAccountMatch && req.method === 'PUT') {
          const accountId = decodeURIComponent(accessAccountMatch[1]);
          const account = (await auth.listAccounts()).find((item) => item.id === accountId);
          if (!account) {
            sendJson(res, 404, { ok: false, message: '账号不存在。' });
            return;
          }
          try {
            const body = await readJson(req);
            const enabled = body.enabled === true;
            const accountAccess = accessControl.bindAccountProfile({
              accountId,
              profileId: body.profileId,
              enabled
            });
            if (!enabled) {
              accessControl.revokeAllSessions({
                accountId,
                reasonCode: 'ADMIN_ACCOUNT_ACCESS_DISABLED',
                enabled: false
              });
            }
            accessControl.recordSecurityEvent({
              eventType: 'account_quota_binding_updated',
              accountId,
              subject: session.user.id,
              outcome: 'applied',
              reasonCode: String(body.profileId || '')
            });
            sendJson(res, 200, {
              ok: true,
              accountAccess: accessControl.getAccountAccess(accountId)
            });
          } catch (error) {
            sendJson(res, 400, { ok: false, code: error?.code || 'ACCOUNT_ACCESS_BINDING_INVALID', message: '账号限额配置无效。' });
          }
          return;
        }
        const revokeSessionsMatch = url.pathname.match(
          /^\/api\/admin\/access\/accounts\/([^/]+)\/sessions\/revoke$/
        );
        if (revokeSessionsMatch && req.method === 'POST') {
          const accountId = decodeURIComponent(revokeSessionsMatch[1]);
          const revoked = await auth.revokeAllSessionsForAccount(accountId);
          if (!revoked) {
            sendJson(res, 404, { ok: false, message: '账号不存在。' });
            return;
          }
          accessControl.recordSecurityEvent({
            eventType: 'admin_emergency_session_revoke',
            accountId,
            subject: session.user.id,
            outcome: 'applied',
            reasonCode: 'ADMIN_EMERGENCY_REVOKE'
          });
          sendJson(res, 200, { ok: true, revoked: true });
          return;
        }
        if (url.pathname === '/api/admin/ai/settings' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, settings: aiService.getAdminSettings() });
          return;
        }
        if (url.pathname === '/api/admin/ai/settings/import' && req.method === 'POST') {
          sendJson(res, 200, { ok: true, settings: aiService.importAdminSettings(await readJson(req)) });
          return;
        }
        const providerMatch = url.pathname.match(/^\/api\/admin\/ai\/providers\/([^/]+)(\/test)?$/);
        if (providerMatch && req.method === 'PUT' && !providerMatch[2]) {
          sendJson(res, 200, { ok: true, config: aiService.saveProvider(decodeURIComponent(providerMatch[1]), await readJson(req)) });
          return;
        }
        if (providerMatch && req.method === 'POST' && providerMatch[2]) {
          if (privacyRequired && !privacyLifecycle.hasCurrentConsent(session.user.id)) {
            sendConsentRequired(res, sendJson);
            return;
          }
          let requestLease = null;
          try {
            const requestId = `req_admin_provider_test_${randomUUID()}`;
            requestLease = accessControl.beginRequest({
              subject: session.subject,
              requestId
            });
            const result = await aiService.testProvider(
              decodeURIComponent(providerMatch[1]),
              await readJson(req),
              { subject: session.subject, requestLease }
            );
            sendJson(res, 200, { ok: true, result });
          } catch (error) {
            const status = Number(error?.status || (error?.code === 'ACCESS_CONTROL_UNAVAILABLE' ? 503 : 429));
            sendJson(res, status, {
              ok: false,
              code: error?.code || 'ACCESS_CONTROL_UNAVAILABLE',
              message: error?.publicMessage || 'Provider连接测试暂时不可用。'
            });
          } finally {
            if (requestLease) {
              try { accessControl.releaseRequest(requestLease); } catch { /* The response is already stable. */ }
            }
          }
          return;
        }
        if (url.pathname === '/api/admin/ai/router' && req.method === 'PUT') {
          sendJson(res, 200, { ok: true, router: aiService.saveRouter(await readJson(req)) });
          return;
        }
        if (url.pathname === '/api/admin/ai/traces' && req.method === 'GET') {
          sendJson(res, 200, { ok: true, traces: aiService.listTraces(url.searchParams.get('limit')) });
          return;
        }
        sendJson(res, 404, { ok: false, message: 'Not found' });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        sendJson(res, 404, { ok: false, message: 'Not found' });
        return;
      }

      serveStatic(req, res, publicDir);
    } catch {
      sendJson(res, 500, { ok: false, message: '服务暂时不可用。' });
    }
  });

  server.once('close', () => {
    const finishClose = () => {
    void voiceDictationRuntime.close?.();
    void memoryRuntime.close();
    learningRuntime?.close?.();
    conversationRuntime?.close?.();
    protectedMemoryRuntime?.close?.();
    financeRuntime?.close?.();
    diaryLifecycleRuntime?.close?.();
    healthLifecycleRuntime?.close?.();
    tasksRuntime?.close?.();
    attachmentRuntime?.close?.();
    meetingRecordingAttemptStore?.close?.();
    privacyLifecycle.close();
    accessControlStore.close();
    };
    if (voiceChatRuntime.enabled) void voiceChatRuntime.close().then(finishClose, finishClose);
    else { voiceChatRuntime.close(); finishClose(); }
  });

  return {
    server,
    auth,
    accessControl,
    accessControlStore,
    memoryRuntime,
    memoryStatus,
    conversationRuntime,
    voiceChatRuntime,
    protectedMemoryRuntime,
    financeRuntime,
    tasksRuntime,
    diaryRuntime,
    healthRuntime,
    learningRuntime,
    attachmentRuntime,
    privacyLifecycle,
    meetingSpeechGateway,
    meetingRecordingAttemptStore
  };
  } catch (error) {
    const unprovenLabel = String(error?.unprovenPartialInitialization || '');
    const cleanupCodes = [
      ...(Array.isArray(error?.cleanupCodes) ? error.cleanupCodes : []),
      ...(unprovenLabel ? [`${unprovenLabel}:UNPROVEN_PARTIAL_INITIALIZATION`] : []),
      ...await cleanupFailedServerInitialization(initializationCleanup)
    ];
    throw Object.assign(error, {
      cleanupCompleted: cleanupCodes.length === 0 && !unprovenLabel,
      cleanupCodes,
      ...(unprovenLabel ? {
        requiresProcessExit: true,
        requiresIsolationRootDestruction: true
      } : {})
    });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { server, memoryStatus } = await createBetaServer();
  server.listen(defaultConfig.port, defaultConfig.host, () => {
    console.log(`AI Secretary beta server listening on ${defaultConfig.host}:${defaultConfig.port}`);
    console.log(`Memory runtime: ${memoryStatus.status} (${memoryStatus.pathSummary})`);
  });
}
