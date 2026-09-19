export const REQUIRED_PROVIDER_ADAPTER_METHODS = Object.freeze([
  'validateConfig',
  'healthCheck',
  'listModels',
  'supportsCapability',
  'invoke',
  'normalizeResponse',
  'normalizeError',
  'normalizeUsage',
  'estimateCost'
]);

export const OPTIONAL_PROVIDER_ADAPTER_METHODS = Object.freeze([
  'invokeVision',
  'invokeStructured'
]);

export const PROVIDER_ADAPTER_CONTRACT_V1 = Object.freeze({
  version: 'v1',
  requiredMethods: REQUIRED_PROVIDER_ADAPTER_METHODS,
  optionalMethods: OPTIONAL_PROVIDER_ADAPTER_METHODS,
  secretPolicy: 'server-side-only',
  methodContract: Object.freeze({
    validateConfig: 'config -> ValidationResult',
    healthCheck: '(config, context) -> Promise<ProviderHealthResult>',
    listModels: 'config -> Promise<ProviderModel[]>',
    supportsCapability: '(model, capability) -> CapabilitySupport',
    invoke: '(request, context) -> Promise<ProviderInvokeResult>',
    invokeVision: '(request, context) -> Promise<ProviderInvokeResult>',
    invokeStructured: '(request, schema, context) -> Promise<ProviderInvokeResult>',
    normalizeResponse: '(rawResponse, context) -> AIResponse fields',
    normalizeError: '(error, context) -> GatewayError',
    normalizeUsage: 'rawUsage -> NormalizedUsage | null',
    estimateCost: '(usage, model, pricing) -> EstimatedCost | null'
  })
});
