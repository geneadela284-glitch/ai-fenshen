#!/usr/bin/env node

import { transitionVerifiedBranch } from './branchTransition.js';
import { findRepositoryRoot } from './projectState.js';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}
try {
  const result = transitionVerifiedBranch({
    repoRoot: findRepositoryRoot(),
    targetBranch: argument('to'),
    dryRun: process.argv.includes('--dry-run')
  });
  console.log(result.dryRun ? 'PROJECT_STATE_BRANCH_TRANSITION_DRY_RUN' : 'PROJECT_STATE_BRANCH_TRANSITION_WRITTEN');
  console.log(`Generation: ${result.generationBefore} -> ${result.generationAfter}`);
  console.log(`Verified branch: ${result.fromBranch} -> ${result.targetBranch}`);
  console.log(`HEAD: ${result.head}`);
  console.log(`Fingerprint: ${result.fingerprint.algorithm}:${result.fingerprint.value}`);
  console.log(`Next step: ${result.nextCommand}`);
} catch (error) {
  console.error('PROJECT_STATE_BRANCH_TRANSITION_FAILED');
  console.error(`- ${error.message}`);
  process.exitCode = 1;
}
