#!/usr/bin/env node

import path from 'node:path';

import {
  CANONICAL_STATE_FILE,
  PROJECT_STATE_ERROR,
  PROJECT_STATE_OK,
  findRepositoryRoot,
  inspectProjectStateCheckpoint,
  validateProjectState
} from './projectState.js';

function printFailure(errors) {
  console.error(PROJECT_STATE_ERROR);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
}

function printSummary(state, stateToken) {
  console.log(PROJECT_STATE_OK);
  console.log(`Project: ${state.canonical_project_name}`);
  console.log(`Milestone: ${state.current_milestone.label}`);
  console.log(`Status: ${state.status}`);
  console.log(`Checkpoint generation: ${state.checkpoint_generation}`);
  console.log(`State token: ${stateToken}`);
  console.log(`Verified timestamp: ${state.verified_at}`);
  console.log(`Git branch/base: ${state.verified_branch} / ${state.verified_base_commit}`);
  console.log(`Working-tree status: ${state.working_tree.state} (${state.working_tree.entries.length} entries)`);
  console.log(
    `Working-tree fingerprint: v${state.working_tree.fingerprint.version} ` +
    `${state.working_tree.fingerprint.algorithm}:${state.working_tree.fingerprint.value}`
  );
  console.log('Tests:');
  for (const item of state.tests) console.log(`- ${item.name}: ${item.result} [${item.verification_scope}]`);
  console.log(`Build: ${state.build.result} [${state.build.verification_scope}]`);
  console.log(`Real data modified: ${state.real_data_modified ? 'YES' : 'NO'}`);
  console.log(`Blocker: ${state.blocker}`);
  console.log(
    `Current engineering action: [${state.current_engineering_action.id}] ` +
    `${state.current_engineering_action.title} (${state.current_engineering_action.status})`
  );
  console.log(
    `Next product action after stabilization: [${state.next_product_action_after_stabilization.id}] ` +
    `${state.next_product_action_after_stabilization.title} ` +
    `(${state.next_product_action_after_stabilization.status})`
  );
  console.log('Decision gates:');
  for (const gate of state.decision_gates) {
    console.log(
      `- [${gate.id}] ${gate.title}: ${gate.status}; ` +
      `blocks following actions: ${gate.blocks_following_actions ? 'YES' : 'NO'}`
    );
  }
  console.log('Forbidden actions:');
  for (const action of state.forbidden_actions) {
    console.log(
      `- [${action.id}] ${action.description} ` +
      `(${action.severity}; ${action.enforcement}; condition: ${action.condition.type})`
    );
  }
}

try {
  const repoRoot = findRepositoryRoot();
  const transaction = inspectProjectStateCheckpoint(repoRoot);
  if (transaction.pending) {
    printFailure([
      `PROJECT_STATE_RECOVERY_REQUIRED: unfinished checkpoint transaction artifacts exist (${transaction.artifacts.join(', ')}).`,
      'Run pnpm project:checkpoint -- --recover before resuming.'
    ]);
  } else {
  const result = validateProjectState({ repoRoot, statePath: path.join(repoRoot, CANONICAL_STATE_FILE) });
  if (!result.ok) printFailure(result.errors);
  else {
    const finalTransactionCheck = inspectProjectStateCheckpoint(repoRoot);
    if (finalTransactionCheck.pending) {
      printFailure([
        `PROJECT_STATE_RECOVERY_REQUIRED: checkpoint transaction began during resume (${finalTransactionCheck.artifacts.join(', ')}).`
      ]);
    } else {
      printSummary(result.state, result.stateToken);
    }
  }
  }
} catch (error) {
  printFailure([error.message]);
}
