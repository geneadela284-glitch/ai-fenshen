export const DICTATION_CANCEL_DEDUPE_MS = 500;

export function createDictationCancelDispatcher(
  onCancel = () => {},
  { now = () => Date.now(), dedupeMs = DICTATION_CANCEL_DEDUPE_MS } = {}
) {
  let lastActivationAt = Number.NEGATIVE_INFINITY;

  const handle = (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const currentTime = Number(now());
    const timestamp = Number.isFinite(currentTime) ? currentTime : Date.now();
    if (timestamp - lastActivationAt < dedupeMs) return false;
    lastActivationAt = timestamp;
    onCancel();
    return true;
  };

  return Object.freeze({ handle });
}
