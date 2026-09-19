export const SAFARI_VALIDATION_EVIDENCE_FIELDS = Object.freeze([
  'syntheticFixtureVerified',
  'recoveryVerified',
  'secondDeviceRecovery',
  'oldDeviceRevoked',
  'deviceUnlockVerified',
  'logoutLoginVerified',
  'wrongAccountRejected',
  'siteDataCleared',
  'privateModeBlocked'
]);

export function mergeSafariValidationEvidence({ existing = {}, updates = {}, now = new Date().toISOString() } = {}) {
  const result = {};
  for (const field of SAFARI_VALIDATION_EVIDENCE_FIELDS) {
    result[field] = existing?.[field] === true || updates?.[field] === true;
  }
  return Object.freeze({ ...result, updatedAt: String(now || '') });
}
export function isSafariValidationComplete(evidence = {}) {
  return SAFARI_VALIDATION_EVIDENCE_FIELDS.every((field) => evidence?.[field] === true);
}
