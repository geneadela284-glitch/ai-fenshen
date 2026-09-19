async function request(path, options = {}) {
  const response = await fetch(path, { credentials: 'include', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.message || '服务暂时不可用。');
  return payload;
}

const jsonOptions = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

export async function fetchAiServiceStatus() {
  try {
    return Boolean((await request('/api/ai/status')).available);
  } catch {
    return false;
  }
}

export async function fetchAdminAiSettings() {
  return (await request('/api/admin/ai/settings')).settings;
}

export async function importAdminAiSettings(settings) {
  return (await request('/api/admin/ai/settings/import', jsonOptions('POST', settings))).settings;
}

export async function saveAdminProvider(providerId, config) {
  return (await request(`/api/admin/ai/providers/${encodeURIComponent(providerId)}`, jsonOptions('PUT', config))).config;
}

export async function testAdminProvider(providerId, config) {
  return (await request(`/api/admin/ai/providers/${encodeURIComponent(providerId)}/test`, jsonOptions('POST', config))).result;
}

export async function saveAdminRouter(router) {
  return (await request('/api/admin/ai/router', jsonOptions('PUT', router))).router;
}

export async function fetchAdminAiTraces() {
  return (await request('/api/admin/ai/traces?limit=20')).traces || [];
}
