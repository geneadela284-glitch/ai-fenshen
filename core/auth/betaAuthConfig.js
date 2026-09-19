import path from 'node:path';

export function resolveBetaAuthDbPath({ env = process.env, projectRoot = process.cwd() } = {}) {
  if (env.AI_SECRETARY_AUTH_DB) return path.resolve(env.AI_SECRETARY_AUTH_DB);
  if (env.AI_SECRETARY_DATA_DIR) return path.resolve(env.AI_SECRETARY_DATA_DIR, 'auth/auth.sqlite');
  if (env.NODE_ENV === 'production') return '/data/auth/auth.sqlite';
  return path.resolve(projectRoot, 'data/auth/auth.sqlite');
}
