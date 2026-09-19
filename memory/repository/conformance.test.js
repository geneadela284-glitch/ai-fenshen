import { runMemoryRepositoryConformanceSuite } from './conformance.js';
import { createInMemoryMemoryRepository } from './index.js';

runMemoryRepositoryConformanceSuite((options) => createInMemoryMemoryRepository(options));
