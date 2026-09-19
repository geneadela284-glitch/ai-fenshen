const SAFE_PROVIDER_STATUSES = new Set(['可用', '连接失败', '未测试', '未配置', '已禁用']);

export function isAdminUser(user) {
  return user?.role === 'admin';
}

export function maskAccountIdentifier(identifier = '') {
  const value = String(identifier || '').trim();
  if (!value) return '';
  if (/^1\d{10}$/.test(value)) return `${value.slice(0, 3)}****${value.slice(-4)}`;
  const at = value.indexOf('@');
  if (at > 0) return `${value[0]}***${value.slice(at)}`;
  return value;
}

export function normalizeSafeAdminSettings(snapshot = {}) {
  const input = Array.isArray(snapshot.providers) ? snapshot.providers : Object.values(snapshot.providers || {});
  const providers = input.map((provider = {}) => ({
    id: String(provider.id || ''),
    label: String(provider.displayName || provider.name || 'AI 服务'),
    apiKeyConfigured: Boolean(provider.apiKeyConfigured),
    maskedApiKey: provider.apiKeyConfigured ? String(provider.maskedApiKey || '已配置') : '未配置',
    healthy: provider.healthy === true ? true : provider.healthy === false ? false : null,
    status: SAFE_PROVIDER_STATUSES.has(provider.status) ? provider.status : (provider.healthy === true ? '可用' : '未测试')
  })).filter((provider) => provider.id);
  return { providers };
}

export function createProviderSavePayload(apiKey = '') {
  const value = String(apiKey || '').trim();
  return value ? { apiKey: value } : {};
}
