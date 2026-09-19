import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { SpeechGateway } from './speech.js';
import { learningError } from '../../core/learning/contract.js';

const execute = promisify(execFile);
// Explicit local-development adapter, never silently selected for Linux production.
export function createLocalSpeech({ python, model, tempRoot = os.tmpdir() } = {}) {
  if (process.platform !== 'darwin' || !python || !model || !existsSync(python) || !existsSync(model)) return new SpeechGateway();
  async function withFiles(operation) {
    const dir = await mkdtemp(path.join(tempRoot, 'af-learning-voice-'));
    try { return await operation(dir); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
  return new SpeechGateway({
    transcribe: (bytes, { signal }) => withFiles(async dir => {
      const audio = path.join(dir, 'input.wav');
      await writeFile(audio, bytes, { mode: 0o600 });
      const { stdout } = await execute(python, [fileURLToPath(new URL('./transcribeLocal.py', import.meta.url)), model, audio], { signal, timeout: 29000, maxBuffer: 128 * 1024 });
      try { return JSON.parse(stdout); } catch { throw learningError('TRANSCRIPTION_FAILED', 502); }
    }),
    synthesize: (text, { signal, rate }) => withFiles(async dir => {
      const output = path.join(dir, 'speech.wav');
      await execute('/usr/bin/say', ['-v', 'Samantha', '-r', '175', '-o', output, '--file-format=WAVE', '--data-format=LEI16@16000', '--', text], { signal, timeout: 29000, maxBuffer: 64 * 1024 });
      return readFile(output);
    })
  });
}
