import assert from 'node:assert/strict';
import test from 'node:test';

import * as integration from './index.js';

test('M9 exports only the real-user integration building blocks', () => {
  for (const name of [
    'AuthenticatedMemoryContextFactory',
    'MemoryFeatureFlags',
    'MemoryIntegrationAudit',
    'MemoryRealUserService',
    'createRealUserMemoryRuntime',
    'resolveRealUserMemoryPaths'
  ]) assert.equal(typeof integration[name], name.startsWith('create') || name.startsWith('resolve') ? 'function' : 'function');
});
