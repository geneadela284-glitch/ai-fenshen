import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

const hash = value => createHash('sha256').update(String(value || '')).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonNegative = value => Number.isSafeInteger(value) && value >= 0;

// Called on the logger's serial append queue. A persisted claim survives restart;
// missing or invalid authorization must never enable unrestricted collection.
export function createMeetingInputDiagnosticScope({ scopeFilePath, now }) {
  async function save(state) {
    const temporary = `${scopeFilePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    await rename(temporary, scopeFilePath);
  }

  return async function admit(input, entry) {
    try {
      const state = JSON.parse(await readFile(scopeFilePath, 'utf8'));
      const time = Date.parse(now());
      if (state.version !== 1 || !validHash(state.ownerHash)
        || typeof state.marker !== 'string' || !state.marker
        || !Number.isFinite(state.armedAt) || !Number.isFinite(state.expiresAt) || !Number.isFinite(time)
        || state.expiresAt <= state.armedAt || state.expiresAt > state.armedAt + 86_400_000
        || !nonNegative(state.eventCount ?? 0) || !nonNegative(state.byteCount ?? 0)
        || (state.attemptHash && (!validHash(state.attemptHash) || !Number.isFinite(state.claimedAt)))
        || (state.closeAfter !== undefined && !Number.isFinite(state.closeAfter))) return false;
      if (state.closed) return false;
      if (time >= state.expiresAt || (state.attemptHash && time >= state.claimedAt + 600_000)
        || (state.closeAfter !== undefined && time >= state.closeAfter)) {
        await save({ ...state, closed: true });
        return false;
      }
      if (entry.phase !== 'recording_checkpoint' || entry.diagnosticMarker !== state.marker
        || !input.ownerId || hash(input.ownerId) !== state.ownerHash
        || !String(input.recordingAttemptId || '').trim()) return false;
      const attemptHash = hash(input.recordingAttemptId);
      if (state.attemptHash && state.attemptHash !== attemptHash) return false;
      if (!state.attemptHash) {
        const createdAt = Date.parse(input.recordingAttemptCreatedAt);
        if (input.captureEpoch !== 0 || !Number.isFinite(createdAt)
          || createdAt < state.armedAt || createdAt > time) return false;
        state.attemptHash = attemptHash;
        state.claimedAt = time;
      }
      const bytes = Buffer.byteLength(`${JSON.stringify(entry)}\n`);
      if ((state.eventCount ?? 0) >= 2_000 || (state.byteCount ?? 0) + bytes > 1_048_576) {
        await save({ ...state, closed: true });
        return false;
      }
      if (entry.event === 'capture_input_session_finished' && state.closeAfter === undefined) {
        state.closeAfter = time + 60_000;
      }
      // Reserve the bounded budget before append; a write failure can lose a
      // diagnostic, but cannot reopen authorization or exceed its limits.
      state.eventCount = (state.eventCount ?? 0) + 1;
      state.byteCount = (state.byteCount ?? 0) + bytes;
      await save(state);
      return true;
    } catch {
      return false;
    }
  };
}
