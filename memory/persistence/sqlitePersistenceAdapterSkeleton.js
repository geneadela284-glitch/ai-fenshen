import { PERSISTENCE_ADAPTER_METHODS, PERSISTENCE_CAPABILITY_MATRIX, PERSISTENCE_CONTRACT_VERSION } from './contracts.js';
import { persistenceError } from './errors.js';

export class SQLitePersistenceAdapterSkeleton {
  constructor() {
    this.implemented = false;
    this.capabilities = Object.freeze({
      adapterId: 'sqlite-skeleton',
      adapterType: 'sqlite',
      contractVersion: PERSISTENCE_CONTRACT_VERSION,
      features: Object.freeze(Object.fromEntries(Object.keys(PERSISTENCE_CAPABILITY_MATRIX).map((feature) => [feature, false])))
    });
  }
}

for (const method of PERSISTENCE_ADAPTER_METHODS) {
  SQLitePersistenceAdapterSkeleton.prototype[method] = async function notImplemented() {
    throw persistenceError('PERSISTENCE_ADAPTER_NOT_IMPLEMENTED');
  };
}
