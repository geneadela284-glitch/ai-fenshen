export async function copyRecoveryCredential({ secret, clipboard = globalThis.navigator?.clipboard } = {}) {
  if (!String(secret || '')) return { ok: false, errorCode: 'RECOVERY_CREDENTIAL_NOT_READY' };
  if (typeof clipboard?.writeText !== 'function') return { ok: false, errorCode: 'CLIPBOARD_UNAVAILABLE' };
  try {
    await clipboard.writeText(String(secret));
    return { ok: true };
  } catch {
    return { ok: false, errorCode: 'CLIPBOARD_WRITE_FAILED' };
  }
}

