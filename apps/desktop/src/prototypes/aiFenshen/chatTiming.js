// Opt-in, bounded in-memory diagnostics. Never retain transcript, audio, owner or memory contents.
export function recordChatTiming(event) {
  if (globalThis.__AF_CHAT_TIMING_ENABLED__ !== true) return;
  const item = { stage: String(event.stage).slice(0, 48), at: Date.now() };
  for (const key of ['durationMs', 'count', 'inputEpoch']) if (Number.isFinite(event[key])) item[key] = event[key];
  if (event.turnId) item.turnId = String(event.turnId).slice(0, 80);
  const records = globalThis.__AF_CHAT_TIMINGS__ ||= [];
  records.push(item); if (records.length > 120) records.splice(0, records.length - 120);
}
