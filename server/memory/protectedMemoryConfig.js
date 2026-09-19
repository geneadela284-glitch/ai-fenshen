import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  assertScopedRealDataDatabaseLocation,
  selectScopedRealDataAuthorization
} from '../../core/safety/scopedRealDataAuthorization.js';
import {
  CANONICAL_STATE_FILE,
  computeProjectStateToken,
  validateProjectState
} from '../../scripts/project-state/projectState.js';

const RELEASE_RUNTIME_MANIFEST = 'release-runtime.json';
const RELEASE_RUNTIME_MANIFEST_SCHEMA = 1;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function loadGitlessReleaseState(repositoryRoot) {
  const manifestPath = path.join(repositoryRoot, RELEASE_RUNTIME_MANIFEST);
  const statePath = path.join(repositoryRoot, CANONICAL_STATE_FILE);
  let manifest;
  let stateDocument;
  try {
    if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
      throw new Error(`missing ${RELEASE_RUNTIME_MANIFEST}`);
    }
    accessSync(manifestPath, constants.R_OK);
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!existsSync(statePath) || !statSync(statePath).isFile()) {
      throw new Error(`missing ${CANONICAL_STATE_FILE}`);
    }
    accessSync(statePath, constants.R_OK);
    stateDocument = readFileSync(statePath);
  } catch (error) {
    throw new Error(`SCOPED_REAL_DATA_FAIL_CLOSED: invalid Release runtime contract: ${error.message}`);
  }

  if (manifest?.schema_version !== RELEASE_RUNTIME_MANIFEST_SCHEMA || manifest.gitless_runtime !== true) {
    throw new Error('SCOPED_REAL_DATA_FAIL_CLOSED: invalid Release runtime manifest schema.');
  }
  if (manifest.canonical_state_file !== CANONICAL_STATE_FILE ||
      !/^[0-9a-f]{64}$/.test(manifest.canonical_state_sha256 || '') ||
      manifest.canonical_state_sha256 !== sha256(stateDocument) ||
      !/^aiwc-project-state-document-v1-sha256:[0-9a-f]{64}$/.test(manifest.canonical_state_token || '') ||
      manifest.canonical_state_token !== computeProjectStateToken(stateDocument) ||
      !/^[0-9a-f]{40}$/i.test(manifest.release_head || '') ||
      !Number.isSafeInteger(manifest.checkpoint_generation) || manifest.checkpoint_generation < 0) {
    throw new Error('SCOPED_REAL_DATA_FAIL_CLOSED: Release runtime manifest does not match canonical state.');
  }

  const validation = validateProjectState({
    repoRoot: repositoryRoot,
    statePath,
    allowWorkingTreeDrift: true,
    verifyGitState: false
  });
  if (!validation.ok) {
    throw new Error(`SCOPED_REAL_DATA_FAIL_CLOSED: canonical Release state is invalid: ${validation.errors.join(' ')}`);
  }
  if (validation.state.checkpoint_generation !== manifest.checkpoint_generation) {
    throw new Error('SCOPED_REAL_DATA_FAIL_CLOSED: Release checkpoint generation does not match its runtime manifest.');
  }
  return validation.state;
}

export function resolveProtectedMemoryRuntimeConfig({ canonicalState, databasePath, scope }) {
  const actionIds = [
    canonicalState?.current_engineering_action?.id,
    canonicalState?.next_product_action_after_stabilization?.id
  ].filter(Boolean);
  const selection = { requestedScope: scope, canonicalActionIds: actionIds };
  if (Object.hasOwn(canonicalState || {}, 'real_data_authorization')) {
    selection.authorization = canonicalState.real_data_authorization;
  }
  if (Object.hasOwn(canonicalState || {}, 'real_data_authorizations')) {
    selection.authorizations = canonicalState.real_data_authorizations;
  }
  const authorization = selectScopedRealDataAuthorization(selection);
  const actionId = actionIds.find((id) => authorization?.active_action_ids?.includes(id));
  if (!actionId) throw new Error('SCOPED_REAL_DATA_FAIL_CLOSED: authorization is inactive for the current canonical action.');
  const capability = assertScopedRealDataDatabaseLocation({
    authorization,
    scope,
    databasePath,
    ownerSource: 'authenticated_session',
    actionId
  });
  return Object.freeze({
    databasePath: capability.databasePath,
    scope: authorization.scope,
    actionId,
    authorization,
    memoryPolicy: 'protected_acceptance'
  });
}

export function loadProtectedMemoryRuntimeConfig({ repositoryRoot, databasePath, scope }) {
  const manifestPath = path.join(repositoryRoot, RELEASE_RUNTIME_MANIFEST);
  const canonicalState = existsSync(manifestPath)
    ? loadGitlessReleaseState(repositoryRoot)
    : (() => {
      const validation = validateProjectState({ repoRoot: repositoryRoot, allowWorkingTreeDrift: true });
      if (!validation.ok) {
        throw new Error(`SCOPED_REAL_DATA_FAIL_CLOSED: canonical project state is not restored: ${validation.errors.join(' ')}`);
      }
      return validation.state;
    })();
  return resolveProtectedMemoryRuntimeConfig({
    canonicalState,
    databasePath,
    scope
  });
}
