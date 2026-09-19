import { isIP } from 'node:net';

function canonicalIp(value) {
  const text = String(value || '').trim();
  return isIP(text) ? text : '';
}

export function resolveTrustedClientIp(req, trustedProxyIps = []) {
  const socketIp = canonicalIp(req?.socket?.remoteAddress) || 'unknown';
  const trusted = new Set(
    Array.isArray(trustedProxyIps)
      ? trustedProxyIps.map(canonicalIp).filter(Boolean)
      : []
  );
  if (!trusted.has(socketIp)) return socketIp;
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.includes(',')) return socketIp;
  return canonicalIp(forwarded) || socketIp;
}
