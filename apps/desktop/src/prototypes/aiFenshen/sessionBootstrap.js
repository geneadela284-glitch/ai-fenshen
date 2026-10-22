export async function restoreBootstrapSession({
  fetchSession,
  fetchPrivacyConsent,
  accountWorkspace,
  isCurrent,
  onAuthenticated,
  onUnauthenticated,
  onUnavailable
}) {
  try {
    const { user, featureFlags } = await fetchSession();
    const privacy = user ? await fetchPrivacyConsent() : null;
    if (!isCurrent()) return { state: 'stale' };
    if (user) {
      accountWorkspace.transitionTo(user.id);
      await onAuthenticated({ user, featureFlags, privacy });
      return { state: 'authenticated' };
    }
    accountWorkspace.transitionTo(null);
    await onUnauthenticated({ featureFlags });
    return { state: 'unauthenticated' };
  } catch {
    if (!isCurrent()) return { state: 'stale' };
    await onUnavailable();
    return { state: 'unavailable' };
  }
}

export async function expireBootstrapSession({
  accountWorkspace,
  expectedToken,
  isCurrent,
  clearNativeSessionCookie,
  onExpired
}) {
  if (!isCurrent() || !accountWorkspace.isCurrent(expectedToken)) return { state: 'stale' };
  accountWorkspace.transitionTo(null);
  let nativeClearFailed = false;
  try {
    await clearNativeSessionCookie();
  } catch {
    nativeClearFailed = true;
  }
  if (!isCurrent()) return { state: 'stale' };
  await onExpired({ nativeClearFailed });
  return { state: 'expired', nativeClearFailed };
}
