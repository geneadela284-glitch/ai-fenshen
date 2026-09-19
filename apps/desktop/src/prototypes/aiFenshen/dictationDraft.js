export function mergeDictationDraft(existingDraft, transcript) {
  const existing = String(existingDraft ?? '');
  const next = String(transcript ?? '').trim();
  if (!next) return existing;
  if (!existing.trim()) return next;
  return existing.endsWith('\n') ? `${existing}${next}` : `${existing}\n${next}`;
}
