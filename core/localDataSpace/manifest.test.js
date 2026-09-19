import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createTestKeyProvider } from './testKeyProvider.js';
import {
  DATA_SPACE_DIRECTORIES,
  createManifest,
  ensureDataSpaceLayout,
  resolveOwnerSpacePath,
  validateManifest
} from './manifest.js';
import {
  createSignedTestOwnerContext,
  ownerHash,
  verifyOwnerContext
} from './ownerContext.js';

const SECRET = 'meeting-phase0-test-secret-which-is-at-least-32-bytes';

function trustedOwner(ownerId) {
  return verifyOwnerContext(
    createSignedTestOwnerContext({ ownerId, secret: SECRET }),
    { secret: SECRET }
  );
}

test('manifest and owner layout contain only hashed identity and authenticated metadata', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'meeting-phase0-manifest-'));
  const ownerContext = trustedOwner('owner-a');
  const provider = createTestKeyProvider();
  try {
    const spaceId = 'space-owner-a';
    const dataKey = await provider.createDataKey({ ownerId: ownerContext.ownerId, spaceId });
    const spacePath = ensureDataSpaceLayout(root, ownerContext);
    const manifest = createManifest({ ownerContext, spaceId, dataKey });
    const validation = validateManifest(manifest, { ownerId: ownerContext.ownerId, dataKey });

    assert.equal(validation.valid, true);
    assert.equal(spacePath, resolveOwnerSpacePath(root, ownerContext));
    assert.equal(manifest.ownerHash, ownerHash('owner-a'));
    assert.equal(Object.hasOwn(manifest, 'ownerId'), false);
    assert.equal(Object.hasOwn(manifest, 'dataKey'), false);
    assert.deepEqual(manifest.directories, DATA_SPACE_DIRECTORIES);
    assert.match(readFileSync(path.join(spacePath, 'manifest.json'), 'utf8'), /initializing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('untrusted or forged owner contexts cannot resolve a data space', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'meeting-phase0-owner-'));
  try {
    assert.throws(() => resolveOwnerSpacePath(root, { ownerId: 'owner-a' }), /OWNER_CONTEXT_UNTRUSTED/);
    const forged = { ...createSignedTestOwnerContext({ ownerId: 'owner-a', secret: SECRET }), ownerId: 'owner-b' };
    assert.throws(() => resolveOwnerSpacePath(root, forged), /OWNER_CONTEXT_UNTRUSTED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
