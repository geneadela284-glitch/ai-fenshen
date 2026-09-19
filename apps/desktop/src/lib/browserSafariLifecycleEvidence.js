function cleanMarker(value) {
  return String(value || '').trim();
}
export function mergeSafariLifecycleEvidence({
  existing = {},
  navigationType = 'navigate',
  browserRestartConfirmed = false,
  deviceRestartConfirmed = false,
  pageLoadMarker,
  now = new Date().toISOString()
} = {}) {
  const priorMarker = cleanMarker(existing?.pageLoadMarker);
  const nextMarker = cleanMarker(pageLoadMarker) || priorMarker;
  return Object.freeze({
    pageRefreshVerified: existing?.pageRefreshVerified === true || (navigationType === 'reload' && Boolean(priorMarker)),
    browserRestartVerified: existing?.browserRestartVerified === true || browserRestartConfirmed === true,
    deviceRestartVerified: existing?.deviceRestartVerified === true || deviceRestartConfirmed === true,
    pageLoadMarker: nextMarker,
    updatedAt: String(now || '')
  });
}
