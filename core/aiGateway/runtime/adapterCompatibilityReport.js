import {
  OPTIONAL_PROVIDER_ADAPTER_METHODS,
  REQUIRED_PROVIDER_ADAPTER_METHODS
} from '../protocol/providerAdapterContract.js';
import { validateProviderAdapter } from '../protocol/validators.js';

function methodCoverage(adapter, methods) {
  const implemented = methods.filter((method) => typeof adapter?.[method] === 'function').length;
  return Math.round((implemented / methods.length) * 100);
}

export function createAdapterCompatibilityReport(adapters = {}) {
  return Object.fromEntries(Object.entries(adapters).map(([providerId, adapter]) => {
    const contract = validateProviderAdapter(adapter);
    return [providerId, {
      contract: contract.valid ? 100 : methodCoverage(adapter, REQUIRED_PROVIDER_ADAPTER_METHODS),
      vision: typeof adapter?.invokeVision === 'function' ? 100 : 0,
      tool: typeof adapter?.supportsCapability === 'function' ? 100 : 0,
      structured: typeof adapter?.invokeStructured === 'function' ? 100 : methodCoverage(adapter, OPTIONAL_PROVIDER_ADAPTER_METHODS),
      health: typeof adapter?.healthCheck === 'function' ? 'PASS' : 'FAIL'
    }];
  }));
}
