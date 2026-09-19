export const GATEWAY_RUNTIME_FEATURE_FLAG = 'gateway.runtime.enabled';

export function isGatewayRuntimeEnabled(settings = {}) {
  if (settings[GATEWAY_RUNTIME_FEATURE_FLAG] === true) return true;
  return settings.gateway?.runtime?.enabled === true;
}
