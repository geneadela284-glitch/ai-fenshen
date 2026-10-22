#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';

import { runCheckpointTransaction } from './checkpointTransaction.js';

const [repoRoot, statePath, expectedStateToken, generationText, value, behavior = 'none', targetPhase = 'none', delayText = '0'] = process.argv.slice(2);

function token(content) {
  return `fixture-sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function parse(content) {
  return JSON.parse(Buffer.from(content).toString('utf8'));
}

try {
  const result = runCheckpointTransaction({
    repoRoot,
    statePath,
    expectedStateToken,
    expectedGeneration: Number(generationText),
    tokenForBytes: token,
    generationForBytes: (bytes) => parse(bytes).generation,
    createCandidate: ({ actualGeneration }) => Buffer.from(`${JSON.stringify({ generation: actualGeneration + 1, value })}\n`),
    validateCandidate: (candidatePath) => parse(fs.readFileSync(candidatePath)),
    validateInstalled: () => parse(fs.readFileSync(statePath)),
    validateRestored: () => parse(fs.readFileSync(statePath)),
    faultInjector: (phase) => {
      if (phase !== targetPhase) return;
      if (behavior === 'crash') process.exit(86);
      if (behavior === 'delay') {
        const delay = Number(delayText);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
      }
      if (behavior === 'throw') throw new Error(`fixture fault at ${phase}`);
    }
  });
  console.log(`CHECKPOINT_OK ${JSON.stringify(result)}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
