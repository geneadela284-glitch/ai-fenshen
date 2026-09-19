import { runPersistenceAdapterConformanceSuite } from './conformance.js';
import { createFakePersistenceAdapter } from './fakePersistenceAdapter.js';

runPersistenceAdapterConformanceSuite(() => createFakePersistenceAdapter());
