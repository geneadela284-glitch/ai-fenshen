import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../..');
const runScript = path.join(root, 'scripts/model-evaluation/run.mjs');
const replayScript = path.join(root, 'scripts/model-evaluation/replay.mjs');
const validityReplayScript = path.join(root, 'scripts/model-evaluation/validity-replay.mjs');

test('preflight CLI prints exact calls and token ceilings without invoking Providers', async () => {
  const { stdout } = await exec(process.execPath, [runScript, '--mode', 'preflight'], {
    cwd: root,
    env: { ...process.env, MODEL_EVAL_FAIL_IF_PROVIDER_CALLED: 'true' }
  });
  assert.match(stdout, /INITIAL_CALLS=96/);
  assert.match(stdout, /HARD_CALLS=120/);
  assert.match(stdout, /MAX_OUTPUT_TOKENS_FORMAL=73728/);
  assert.match(stdout, /WITHIN_HARD_TOKEN_BUDGET=YES/);
});

test('mock run creates deterministic cache, result, report, and replay makes zero Provider calls', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-eval-cli-'));
  try {
    const run = await exec(process.execPath, [
      runScript, '--mode', 'mock', '--output', directory
    ], { cwd: root });
    assert.match(run.stdout, /CALL_COUNT=96/);
    const raw = await readFile(path.join(directory, 'raw-cache.ndjson'), 'utf8');
    assert.equal(raw.trim().split('\n').length, 96);
    const before = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8'));

    const replay = await exec(process.execPath, [
      replayScript, '--output', directory
    ], {
      cwd: root,
      env: { ...process.env, MODEL_EVAL_FAIL_IF_PROVIDER_CALLED: 'true' }
    });
    assert.match(replay.stdout, /PROVIDER_CALLS=0/);
    const after = JSON.parse(await readFile(path.join(directory, 'results.json'), 'utf8'));
    assert.deepEqual(after, before);
    assert.match(await readFile(path.join(directory, 'report.md'), 'utf8'), /Provider 对比表/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('formal CLI refuses to start without the exact confirmation environment gate', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-eval-formal-gate-'));
  try {
    await assert.rejects(
      exec(process.execPath, [
        runScript, '--mode', 'formal', '--output', directory
      ], { cwd: root }),
      /FORMAL_EVALUATION_CONFIRMATION_REQUIRED/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('validity replay consumes only cached evidence and marks domain-only M12 rates as unavailable', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'model-eval-validity-cli-'));
  const canaryPath = path.join(directory, 'canary.json');
  const output = path.join(directory, 'output');
  try {
    await writeFile(canaryPath, JSON.stringify({
      schema_version: 1,
      call_count: 0,
      call_limit: 8,
      exceeded_call_limit: false,
      stopped_at_limit: false,
      provider_id: 'qwen',
      model_id: 'qwen-max',
      cases: [],
      upstream_records: []
    }));
    const replay = await exec(process.execPath, [
      validityReplayScript,
      '--baseline', path.join(root, 'artifacts/model-evaluation-m12-b1-v1'),
      '--canary', canaryPath,
      '--output', output
    ], {
      cwd: root,
      env: { ...process.env, MODEL_EVAL_FAIL_IF_PROVIDER_CALLED: 'true' }
    });

    assert.match(replay.stdout, /PROVIDER_CALLS=0/);
    const corrected = JSON.parse(await readFile(path.join(output, 'corrected-results.json'), 'utf8'));
    assert.ok(corrected.providers.every(({ metrics }) =>
      metrics.memory_success_rate === null && metrics.calendar_success_rate === null));
    assert.match(await readFile(path.join(output, 'report.md'), 'utf8'), /第一处分叉/);
    assert.ok(JSON.parse(await readFile(path.join(output, 'layer-trace.json'), 'utf8')));
    assert.ok(JSON.parse(await readFile(path.join(output, 'router-policy.json'), 'utf8')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
