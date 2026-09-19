import { registerEntityFoundationConformance } from './entityFoundationConformance.js';
import { createInMemoryEntityFoundation } from './inMemoryFoundation.js';

registerEntityFoundationConformance('InMemory foundation shared conformance', async () => ({
  foundation: createInMemoryEntityFoundation()
}));
