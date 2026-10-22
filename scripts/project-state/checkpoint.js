#!/usr/bin/env node

import path from 'node:path';

import {
  CANONICAL_STATE_FILE,
  PROJECT_STATE_ERROR,
  findRepositoryRoot,
  recoverProjectStateCheckpoint,
  validateProjectState
} from './projectState.js';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

try {
  const repoRoot = findRepositoryRoot();
  const statePath = path.join(repoRoot, argument('state-file') || CANONICAL_STATE_FILE);
  if (process.argv.includes('--recover')) {
    const recovery = recoverProjectStateCheckpoint({ repoRoot, statePath });
    const restored = validateProjectState({ repoRoot, statePath });
    if (!restored.ok) throw new Error(`${PROJECT_STATE_ERROR}: ${restored.errors.join(' ')}`);
    console.log('PROJECT_STATE_CHECKPOINT_RECOVERED');
    console.log(`Recovery outcome: ${recovery.outcome}`);
    console.log(`Checkpoint generation: ${restored.state.checkpoint_generation}`);
    console.log(`State token: ${restored.stateToken}`);
    process.exit(0);
  }
  throw new Error(
    'Direct checkpoint updates are disabled. Run project:verify with --checkpoint so the in-process receipt cannot be forged or replayed.'
  );
} catch (error) {
  console.error(PROJECT_STATE_ERROR);
  console.error(`- ${error.message}`);
  process.exitCode = 1;
}
