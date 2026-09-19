import { getProviderAdapter } from '../../providers/providerAdapters.js';
import { providerRegistry } from '../../providers/providerRegistry.js';
import { createAIRequest } from '../protocol/aiRequest.js';
import { createGatewayError } from '../protocol/errorCodes.js';
import { validateAIRequest, validateAIResponse, validateProviderAdapter } from '../protocol/validators.js';
import { responsePolicyRuntime } from './responsePolicyRuntime.js';

export class GatewayRuntime {
  constructor({
    adapterResolver = getProviderAdapter,
    registry = providerRegistry,
    responsePolicy = responsePolicyRuntime
  } = {}) {
    this.adapterResolver = adapterResolver;
    this.registry = registry;
    this.responsePolicy = responsePolicy;
  }

  async invoke({ providerId, request = {}, runtimeContext, providerConfig = {} } = {}) {
    const aiRequest = createAIRequest({
      requestId: runtimeContext.requestId,
      userId: runtimeContext.userId,
      workspaceId: runtimeContext.workspaceId,
      conversationId: runtimeContext.conversationId || null,
      input: request.input || request.prompt || '',
      attachments: runtimeContext.attachments,
      intent: request.metadata?.intent || null,
      capability: runtimeContext.capability,
      context: {
        currentDate: runtimeContext.currentDate,
        deterministicResult: runtimeContext.deterministicResult
      },
      locale: runtimeContext.locale,
      timezone: runtimeContext.timezone,
      privacyLevel: request.privacyLevel || 'private',
      maxLatencyMs: request.options?.timeoutMs || providerConfig.timeout || 30000,
      maxCost: request.maxCost ?? null,
      preferredPolicy: request.preferredPolicy || 'balanced',
      metadata: { legacySource: true },
      createdAt: request.createdAt
    });
    const requestValidation = validateAIRequest(aiRequest);
    if (!requestValidation.valid) {
      throw createGatewayError({ code: 'INVALID_REQUEST', details: { issues: requestValidation.errors.map(({ path, code }) => ({ path, code })) } });
    }

    const definition = this.registry.get(providerId);
    const adapter = this.adapterResolver(definition, {});
    const adapterValidation = validateProviderAdapter(adapter);
    if (!adapterValidation.valid) {
      throw createGatewayError({
        code: 'CAPABILITY_NOT_SUPPORTED',
        providerId,
        details: {
          missingMethods: adapterValidation.errors.map((error) => error.path)
        }
      });
    }
    const adapterContext = {
      ...runtimeContext,
      providerConfig,
      legacyRequest: request,
      modelId: providerConfig.defaultModel || request.options?.model || null
    };
    let raw;
    try {
      if (['vision', 'ocr'].includes(aiRequest.capability)) raw = await adapter.invokeVision(aiRequest, adapterContext);
      else if (aiRequest.capability === 'structured_extraction' || request.metadata?.outputSchema) {
        raw = await adapter.invokeStructured(aiRequest, request.metadata?.outputSchema || {}, adapterContext);
      } else raw = await adapter.invoke(aiRequest, adapterContext);
    } catch (error) {
      throw adapter.normalizeError(error, adapterContext);
    }

    const normalized = adapter.normalizeResponse(raw, {
      requestId: runtimeContext.requestId,
      capability: runtimeContext.capability,
      deterministicResult: runtimeContext.deterministicResult,
      providerId,
      modelId: raw?.model || adapterContext.modelId,
      durationMs: raw?.durationMs || 0
    });
    const policyResponse = this.responsePolicy.apply(normalized, {
      programResult: request.metadata?.programResult || ''
    });
    const responseValidation = validateAIResponse(policyResponse);
    if (!responseValidation.valid) {
      throw createGatewayError({ code: 'INVALID_RESPONSE', providerId, modelId: raw?.model || null });
    }
    return {
      ...raw,
      content: policyResponse.content,
      structuredOutput: policyResponse.structuredOutput,
      gatewayResponse: policyResponse
    };
  }
}

export const gatewayRuntime = new GatewayRuntime();
export default gatewayRuntime;
