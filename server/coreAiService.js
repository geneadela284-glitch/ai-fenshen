import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ProviderManager } from '../core/providers/providerManager.js';
import { ProviderHealthRepository } from '../core/repositories/providerHealthRepository.js';
import { SettingsRepository } from '../core/repositories/settingsRepository.js';
import { AIRouter } from '../core/router/AIRouter.js';
import { CAPABILITIES } from '../core/router/CapabilityMap.js';
import { InvocationTraceRepository } from '../core/router/InvocationTraceRepository.js';
import { ModelRegistry } from '../core/router/ModelRegistry.js';
import { modelSupportsCapability } from '../core/router/ModelCapabilities.js';
import { createRouterExecutionContext } from '../core/router/RouterExecutionContext.js';
import { createAIRequestRuntimeContext } from '../core/aiGateway/runtime/runtimeContext.js';
import { applyResponsePolicy } from '../core/router/ResponsePolicy.js';
import { SettingsManager } from '../core/settings/settingsManager.js';
import { createMemoryStorage } from '../core/storage/memoryStorage.js';
import { CredentialResolver } from './providers/credentialResolver.js';
import {
  loadVaultKekCredential,
  ProviderCredentialVault
} from './providers/providerCredentialVault.js';
import { migrateLegacyProviderCredentials } from './providers/providerRegistryMigration.js';
import { ProviderRegistryStore } from './providers/providerRegistryStore.js';
import { ProviderSecurityAudit } from './providers/providerSecurity.js';

const SAFE_FAILURE = 'AI 服务暂时不可用，请稍后重试。';

function routeSummary(result = {}) {
  if (!result.executionId && !result.idempotencyKey && !Array.isArray(result.routeTrace)) return null;
  return {
    requestId: result.requestId,
    executionId: result.executionId,
    idempotencyKey: result.idempotencyKey,
    selectedProvider: result.selectedProvider,
    selectedModel: result.selectedModel,
    routeTrace: result.routeTrace
  };
}

export function createFileJsonStorage(filePath) {
  function readAll() {
    if (!existsSync(filePath)) return {};
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) || {};
    } catch {
      return {};
    }
  }

  function writeAll(value) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  }

  return {
    get(key) {
      return readAll()[key] ?? null;
    },
    set(key, value) {
      writeAll({ ...readAll(), [key]: value });
      return value;
    },
    remove(key) {
      const next = readAll();
      delete next[key];
      writeAll(next);
      return true;
    }
  };
}

export class CoreAiService {
  constructor({
    settings,
    providers,
    traces,
    registry = new ModelRegistry(),
    router,
    accessControl,
    providerRegistryStore = null,
    credentialResolver = null
  } = {}) {
    this.providers = providers || new ProviderManager();
    this.settings = settings;
    this.traces = traces || new InvocationTraceRepository({ storage: createMemoryStorage() });
    this.registry = registry;
    this.providerRegistryStore = providerRegistryStore;
    this.credentialResolver = credentialResolver;
    this.meetingRecoveryChecks = new Map();
    this.router = router || new AIRouter({
      providers: this.providers,
      settings: this.settings,
      registry: this.registry,
      traces: this.traces,
      accessControl,
      maxAttempts: 2
    });
  }

  getStatus() {
    const settings = this.settings.load();
    return { available: this.registry.listCandidates(settings, CAPABILITIES.CHAT).length > 0 };
  }

  async run(task = {}, invocation = {}) {
    const { mockOnly: _mockOnly, ...metadata } = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
    if (invocation.requestLease?.requestId) metadata.requestId = invocation.requestLease.requestId;
    const requestedTimeout = Number(task.options?.timeoutMs || 30000);
    const meetingAnalysis = invocation.meetingAnalysis === true && task.capability === 'MEETING_SUMMARY';
    const timeoutMs = Math.max(1000, Math.min(meetingAnalysis ? 90000 : 30000, Number.isFinite(requestedTimeout) ? requestedTimeout : 30000));
    const started = Date.now();
    const meetingDeadlineAt = started + timeoutMs;
    let recoveryError = null;
    if (meetingAnalysis) {
      try { recoveryError = await this.recoverMeetingProvider(invocation, meetingDeadlineAt); }
      catch (error) { recoveryError = error; }
    }
    const result = recoveryError ? { error: recoveryError, latency: Date.now() - started } : await this.router.run({
      input: String(task.input || ''),
      messages: Array.isArray(task.messages) ? task.messages : undefined,
      capability: task.capability,
      metadata,
      options: { timeoutMs },
      method: 'generate'
    }, meetingAnalysis ? { ...invocation, meetingAnalysisDeadlineAt: meetingDeadlineAt } : invocation);
    if (result.error) {
      const route = routeSummary(result);
      return {
        ok: false,
        content: '',
        message: SAFE_FAILURE,
        code: result.error.code || 'PROVIDER_ERROR',
        latency: result.latency || 0,
        usage: null,
        ...(route ? { route } : {})
      };
    }
    const route = routeSummary(result);
    return {
      ok: true,
      content: applyResponsePolicy(result.content || ''),
      latency: result.latency || 0,
      usage: result.usage || null,
      ...(route ? { route } : {})
    };
  }

  async recoverMeetingProvider(invocation, deadlineAt) {
    const settings = this.settings.load();
    // Do not change routing or probe when an existing healthy route is usable.
    if (this.registry.listCandidates(settings, 'MEETING_SUMMARY').length) return null;
    const route = this.registry.resolveRoute(settings, 'MEETING_SUMMARY');
    // A disabled default route can legitimately use a configured fallback.
    // Verify one enabled, capable existing provider; normal AIRouter selection
    // still decides the analysis route after verification. No configuration is
    // rewritten and no unhealthy flag is bypassed for an analysis request.
    const provider = this.registry.listProviders(settings)
      .sort((a, b) => Number(b.id === route.providerId) - Number(a.id === route.providerId) || Number(a.priority || 999) - Number(b.priority || 999))
      .find(candidate => {
        const recoveringNetworkFailure = this.meetingRecoveryChecks.has(candidate.id) &&
          ['NETWORK_ERROR', 'PROVIDER_UNAVAILABLE'].includes(candidate.lastErrorCode);
        return candidate.enabled && (candidate.apiKey || candidate.apiKeyConfigured) && candidate.healthy === false &&
          (candidate.lastErrorCode === 'TIMEOUT' || recoveringNetworkFailure) &&
          modelSupportsCapability(candidate.id, candidate.defaultModel || candidate.model, 'MEETING_SUMMARY', candidate);
      });
    if (!provider) return null;
    const providerId = provider.id;
    const now = Date.now();
    const previous = this.meetingRecoveryChecks.get(providerId);
    if (previous && (previous.pending || now - previous.startedAt < 60000)) return { code: 'TIMEOUT' };
    const remaining = deadlineAt - now;
    if (remaining < 1000) return { code: 'TIMEOUT' };
    const check = { startedAt: now, pending: true };
    this.meetingRecoveryChecks.set(providerId, check);
    try {
      // Reuse guarded verification and health persistence. No transcript is
      // sent in this check, and success cannot be fabricated by a health flag.
      const result = await this.testProvider(providerId, { timeout: Math.min(8000, remaining) }, invocation);
      return result?.ok ? null : { code: result?.code || 'AI_ANALYSIS_UNAVAILABLE' };
    } finally { check.pending = false; }
  }

  async runExactCapability({
    providerId,
    modelId,
    capability,
    messages,
    requestId,
    executionId,
    attemptId,
    attemptType = 'attachment_processing',
    timeoutMs = 30_000
  } = {}, invocation = {}) {
    const settings = this.settings.load();
    const candidates = this.registry.listPolicyCandidates(settings, {
      allowFallback: false,
      candidates: [{ providerId, modelId }]
    }, capability);
    const candidate = candidates[0];
    if (!candidate || candidate.providerId !== providerId || candidate.modelId !== modelId) {
      return {
        ok: false,
        content: '',
        code: 'NO_USABLE_RUNTIME_CONNECTION',
        latency: 0,
        usage: null
      };
    }
    const started = Date.now();
    const runtimeContext = createAIRequestRuntimeContext({
      messages,
      capability,
      metadata: {
        requestId,
        userId: invocation.subject?.accountId || ''
      }
    }, { capability });
    const execution = createRouterExecutionContext({
      requestId: requestId || invocation.requestLease?.requestId,
      executionId,
      ownerId: invocation.subject?.accountId,
      domain: `exact:${capability}:${providerId}:${modelId}`
    });
    const attempt = {
      ...execution.attempt(1, candidate, attemptType),
      ...(attemptId ? { attemptId } : {})
    };
    try {
      const result = await this.router.invokeProviderAttempt({
        method: 'chat',
        candidate,
        request: {
          messages: Array.isArray(messages) ? messages : [],
          options: {
            model: modelId,
            defaultModel: modelId,
            timeoutMs: Math.max(1_000, Math.min(30_000, Number(timeoutMs) || 30_000)),
            temperature: 0
          }
        },
        runtimeContext,
        settings,
        attempt,
        invocation
      });
      if (result?.model && result.model !== modelId) {
        const mismatch = new Error('PROVIDER_MODEL_MISMATCH');
        mismatch.code = 'PROVIDER_MODEL_MISMATCH';
        throw mismatch;
      }
      const latency = Date.now() - started;
      this.router.recordTrace({
        requestId: execution.requestId,
        task: { capability, metadata: { domain: 'attachment_processing' } },
        capability,
        candidate,
        routeReason: 'exact_attachment_model_no_fallback',
        fallbackFrom: '',
        fallbackTo: '',
        startedAt: new Date(Date.now() - latency).toISOString(),
        durationMs: latency,
        success: true,
        tokenUsage: result?.usage || null
      });
      return {
        ok: true,
        content: String(result?.content || ''),
        latency,
        usage: result?.usage || null,
        route: {
          requestId: execution.requestId,
          executionId: execution.executionId,
          attemptId: attempt.attemptId,
          selectedProvider: candidate.providerId,
          selectedModel: candidate.modelId,
          fallbackUsed: false
        }
      };
    } catch (error) {
      const latency = Date.now() - started;
      const code = String(error?.code || 'PROVIDER_ERROR');
      this.router.recordTrace({
        requestId: execution.requestId,
        task: { capability, metadata: { domain: 'attachment_processing' } },
        capability,
        candidate,
        routeReason: 'exact_attachment_model_failed',
        fallbackFrom: '',
        fallbackTo: '',
        startedAt: new Date(Date.now() - latency).toISOString(),
        durationMs: latency,
        success: false,
        errorCode: code
      });
      return { ok: false, content: '', code, latency, usage: error?.usage || null };
    }
  }

  async stream(task = {}, options = {}, invocation = {}) {
    const { mockOnly: _mockOnly, ...incomingMetadata } = task.metadata && typeof task.metadata === 'object' ? task.metadata : {};
    if (invocation.requestLease?.requestId) incomingMetadata.requestId = invocation.requestLease.requestId;
    const requestedTimeout = Number(task.options?.timeoutMs || 30000);
    const result = await this.router.stream({
      input: String(task.input || ''),
      messages: Array.isArray(task.messages) ? task.messages : undefined,
      capability: task.capability,
      metadata: { ...incomingMetadata, memoryPolicy: 'disabled' },
      options: { timeoutMs: Math.max(1000, Math.min(30000, requestedTimeout)) },
      method: 'chat'
    }, options, invocation);
    if (result.error) {
      return { ok: false, content: result.content || '', message: SAFE_FAILURE, code: result.error.code || 'PROVIDER_ERROR', latency: result.latency || 0 };
    }
    const route = routeSummary(result);
    return {
      ok: true,
      content: result.content || '',
      latency: result.latency || 0,
      usage: result.usage || null,
      ...(route ? { route } : {})
    };
  }

  async repairSchema({
    route = {},
    domain = '',
    rawContent = '',
    schemaContract = '',
    errors = [],
    options = {},
    businessExecutionStarted = false,
    businessWriteStarted = false
  } = {}, invocation = {}) {
    const result = await this.router.repairSchema({
      route,
      domain,
      rawContent,
      schemaContract,
      errors,
      timeoutMs: options.timeoutMs,
      businessExecutionStarted,
      businessWriteStarted
    }, invocation);
    const summarizedRoute = routeSummary(result);
    if (result.error) {
      return {
        ok: false,
        content: '',
        message: SAFE_FAILURE,
        code: result.error.code || 'SCHEMA_REPAIR_FAILED',
        latency: result.latency || 0,
        usage: null,
        ...(summarizedRoute ? { route: summarizedRoute } : {})
      };
    }
    return {
      ok: true,
      content: result.content || '',
      latency: result.latency || 0,
      usage: result.usage || null,
      ...(summarizedRoute ? { route: summarizedRoute } : {})
    };
  }

  markBusinessExecution(route = {}, outcome = {}) {
    return this.router.markBusinessExecution?.(route, outcome) || 0;
  }

  getAdminSettings() {
    const settings = this.settings.load();
    return {
      provider: settings.provider,
      providers: this.settings.listProviderConfigsForAdmin(),
      router: settings.router || { routes: {} }
    };
  }

  saveProvider(providerId, config = {}) {
    return this.settings.saveProviderConfigFromAdmin(providerId, config);
  }

  testProvider(providerId, config = {}, invocation = {}) {
    const settings = this.settings.load();
    const provider = {
      ...(settings.providers?.[providerId] || {}),
      ...(config || {})
    };
    const modelId = String(
      provider.defaultModel ||
      provider.model ||
      provider.modelOptions?.[0]?.value ||
      'connection-test'
    );
    const purpose = invocation.meetingAnalysis === true ? 'meeting_health_recovery' : 'admin_provider_test';
    const execution = createRouterExecutionContext({
      requestId: invocation.requestLease?.requestId,
      executionId: `${purpose}_${invocation.requestLease?.requestId || ''}`,
      ownerId: invocation.subject?.accountId,
      domain: purpose
    });
    const candidate = {
      providerId: String(providerId || ''),
      modelId,
      provider
    };
    return this.router.invokeGuardedOperation({
      candidate,
      request: invocation.meetingAnalysis === true ? {
        messages: [{ role: 'user', content: '请回复：连接成功' }],
        options: { maxTokens: Math.min(Number(provider.maxTokens || 64), 64) }
      } : {
        input: 'provider connection test',
        options: { maxTokens: 1 }
      },
      attempt: execution.attempt(1, candidate, purpose),
      invocation,
      pricing: provider.pricing || null,
      operation: async (guardedRequest) => {
        if (invocation.meetingAnalysis !== true) return this.settings.testProviderFromAdmin(providerId, config);
        const result = await this.settings.testProviderFromAdmin(providerId, {
          ...config,
          maxTokens: guardedRequest.options.maxTokens
        });
        const usage = result.result?.usage || null;
        if (!result.ok) throw Object.assign(new Error('meeting connection check failed'), {
          code: result.code || 'PROVIDER_UNAVAILABLE', status: result.httpStatus || undefined, usage
        });
        return { ...result, usage };
      }
    });
  }

  saveRouter(router = {}) {
    return this.settings.saveRouterConfig(router);
  }

  importAdminSettings(snapshot = {}) {
    const current = this.settings.load();
    const alreadyConfigured = Object.values(current.providers || {}).some((provider) => provider.apiKey);
    if (!alreadyConfigured) {
      Object.entries(snapshot.providers || {}).forEach(([providerId, config]) => {
        if (config && typeof config === 'object') this.settings.saveProviderConfigFromAdmin(providerId, config);
      });
      if (snapshot.provider) this.settings.save({ provider: snapshot.provider });
      if (snapshot.router) this.settings.saveRouterConfig(snapshot.router);
    }
    return this.getAdminSettings();
  }

  listTraces(limit = 20) {
    return this.traces.listRecent(Math.min(50, Math.max(1, Number(limit || 20))));
  }
}

export function createCoreAiService({
  configPath,
  healthStorePath = path.join(path.dirname(configPath), 'provider-health.json'),
  storage,
  healthStorage,
  adapterResolver,
  accessControl,
  providerRegistryConfig = { enabled: false }
} = {}) {
  const providers = new ProviderManager();
  const repository = new SettingsRepository({ storage: storage || createFileJsonStorage(configPath) });
  const healthRepository = new ProviderHealthRepository({
    storage: healthStorage || createFileJsonStorage(healthStorePath)
  });
  let providerRegistryStore = null;
  let credentialResolver = null;
  let credentialBackend = 'legacy_settings_v1';
  if (providerRegistryConfig?.enabled === true) {
    providerRegistryStore = new ProviderRegistryStore({
      registryPath: providerRegistryConfig.registryPath,
      modelCatalogPath: providerRegistryConfig.modelCatalogPath
    });
    providerRegistryStore.initialize();
    const vault = new ProviderCredentialVault({
      vaultPath: providerRegistryConfig.vaultPath,
      keyRing: loadVaultKekCredential(providerRegistryConfig.kekCredentialPath)
    });
    vault.initialize();
    const audit = new ProviderSecurityAudit({
      auditLogPath: providerRegistryConfig.auditLogPath
    });
    if (providerRegistryConfig.legacyMigrationEnabled !== false) {
      migrateLegacyProviderCredentials({
        legacySettings: repository.read() || {},
        registryStore: providerRegistryStore,
        vault,
        audit
      });
    }
    credentialResolver = new CredentialResolver({
      registryStore: providerRegistryStore,
      vault,
      audit
    });
    credentialBackend = 'vault_v1';
    providers.configure({
      credentialMode: credentialBackend,
      credentialResolver
    });
  }
  const settings = new SettingsManager({
    repository,
    healthRepository,
    providers,
    adapterResolver,
    credentialBackend,
    credentialResolver
  });
  return new CoreAiService({
    settings,
    providers,
    providerRegistryStore,
    credentialResolver,
    accessControl,
    registry: new ModelRegistry({ providerRegistryStore, providers })
  });
}
