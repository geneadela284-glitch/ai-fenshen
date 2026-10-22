#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import {
  CANONICAL_STATE_FILE,
  checkpointProjectState,
  findRepositoryRoot
} from './projectState.js';
import { runProjectVerification } from './verificationReceipt.js';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function required(name) {
  const value = argument(name);
  if (!value) throw new Error(`--${name} is required with --checkpoint.`);
  return value;
}

function stateUpdates() {
  const inlineJson = argument('state-updates-json');
  const filePath = argument('state-updates-file');
  if (inlineJson && filePath) throw new Error('Provide at most one state updates source.');
  if (!inlineJson && !filePath) return {};
  const parsed = JSON.parse(inlineJson || fs.readFileSync(path.resolve(filePath), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('State updates JSON must be an object.');
  }
  return parsed;
}

try {
  const repoRoot = findRepositoryRoot();
  const result = runProjectVerification({
    repoRoot,
    statePath: path.join(repoRoot, CANONICAL_STATE_FILE)
  });
  if (!result.ok) throw new Error(result.failures.join(' '));
  console.log('PROJECT_VERIFICATION_RECEIPT_ISSUED');
  console.log(`Receipt ID: ${result.receiptId}`);
  console.log('Receipt scope: current verification process only');
  console.log(`Expires at: ${result.receipt.expires_at}`);
  console.log(`Project-state tests: ${result.receipt.tests.project_state.pass}/${result.receipt.tests.project_state.tests} PASS`);
  console.log(
    `Domain regression: ${result.receipt.tests.domain_regression.pass}/` +
    `${result.receipt.tests.domain_regression.tests} PASS`
  );
  console.log(`Build: ${result.receipt.build.result} (Vite ${result.receipt.build.vite_version}; ${result.receipt.build.transformed_modules} modules transformed)`);
  console.log('Real data modified: NO');
  if (process.argv.includes('--checkpoint')) {
    const checkpoint = checkpointProjectState({
      repoRoot,
      statePath: path.join(repoRoot, CANONICAL_STATE_FILE),
      input: {
        verificationReceipt: result.receipt,
        expectedStateToken: required('expected-state-token'),
        expectedWorkingTreeFingerprint: required('expected-working-tree-fingerprint'),
        stateUpdates: stateUpdates()
      }
    });
    console.log('PROJECT_STATE_CHECKPOINT_UPDATED');
    console.log(`Checkpoint generation: ${checkpoint.state.checkpoint_generation}`);
    console.log(`State token: ${checkpoint.stateToken}`);
  }
} catch (error) {
  console.error('PROJECT_VERIFICATION_FAILED');
  console.error(`- ${error.message}`);
  process.exitCode = 1;
}
