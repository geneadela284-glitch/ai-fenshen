async function readJson(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || '隐私服务暂时不可用。');
    error.code = payload.code || 'PRIVACY_SERVICE_UNAVAILABLE';
    throw error;
  }
  return payload;
}

export async function fetchPrivacyConsent() {
  return readJson(await fetch('/api/privacy/consent', { credentials: 'include' }));
}

export async function acceptPrivacyConsent({
  privacyNoticeVersion,
  termsVersion,
  locale = 'zh-CN',
  source = 'first_login'
} = {}) {
  return readJson(await fetch('/api/privacy/consent', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accepted: true,
      privacyNoticeVersion,
      termsVersion,
      locale,
      source
    })
  }));
}

export async function createMyDataExport() {
  return readJson(await fetch('/api/privacy/exports', {
    method: 'POST',
    credentials: 'include'
  }));
}

export function startAuthenticatedDownload(downloadUrl) {
  const anchor = document.createElement('a');
  anchor.href = downloadUrl;
  anchor.download = 'ai-fenshen-my-data.json';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export async function createDeletionRequest() {
  const payload = await readJson(await fetch('/api/privacy/deletion-requests', {
    method: 'POST',
    credentials: 'include'
  }));
  const { confirmationToken, ...summary } = payload;
  return { ...summary, confirmationHandle: confirmationToken };
}

export async function confirmDeletionRequest(confirmationHandle) {
  return readJson(await fetch('/api/privacy/deletion-requests/confirm', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      confirmationToken: confirmationHandle,
      confirmation: 'DELETE_MY_ACCOUNT'
    })
  }));
}
