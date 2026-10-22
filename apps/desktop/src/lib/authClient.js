function sessionFromPayload(payload = {}) {
  return {
    user: payload.user || null,
    featureFlags: {
      financeF201Enabled: payload.featureFlags?.financeF201Enabled === true,
      ...(payload.featureFlags?.voiceChatEnabled === true ? { voiceChatEnabled: true } : {})
    }
  };
}

function sessionUnavailableError() {
  const error = new Error('账号状态暂时无法确认，请重试。');
  error.code = 'AUTH_SESSION_UNAVAILABLE';
  return error;
}

function nativeSessionClearError() {
  const error = new Error('本机登录状态暂时无法清理，请稍后重试。');
  error.code = 'MOBILE_SESSION_CLEAR_FAILED';
  return error;
}

export async function fetchCurrentSession() {
  let response;
  try {
    response = await fetch('/api/auth/me', { credentials: 'include' });
  } catch {
    throw sessionUnavailableError();
  }
  if (response.status === 401) return sessionFromPayload();
  if (!response.ok) throw sessionUnavailableError();
  const payload = await response.json();
  return sessionFromPayload(payload);
}

export async function fetchCurrentUser() {
  return (await fetchCurrentSession()).user;
}

export async function loginSession(username, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || '用户名或密码错误。');
  }
  return sessionFromPayload(payload);
}

export async function login(username, password) {
  return (await loginSession(username, password)).user;
}

export async function logout() {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'include'
  });
  if (!response.ok) throw new Error('退出失败，请稍后重试。');
}

export async function clearNativeSessionCookie() {
  const capacitor = globalThis.Capacitor;
  if (capacitor?.isNativePlatform?.() !== true) return;
  try {
    const transport = capacitor.Plugins?.MobileTransport;
    const result = await transport?.clearSessionCookie?.();
    if (result?.cleared !== true) throw nativeSessionClearError();
  } catch {
    throw nativeSessionClearError();
  }
}

export async function logoutAndClearNativeSession() {
  await logout();
  await clearNativeSessionCookie();
}

export async function fetchExportScope() {
  const response = await fetch('/api/user/export-scope', { credentials: 'include' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.userId) throw new Error('无法确认当前账号的数据范围。');
  return payload.userId;
}
