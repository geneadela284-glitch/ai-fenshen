export const ROLES = Object.freeze({
  USER: 'user',
  ADMIN: 'admin',
  BETA_USER: 'beta_user'
});

const ADMIN_PAGES = new Set(['管理员中心']);

function canonicalRole(role) {
  return role === ROLES.ADMIN ? ROLES.ADMIN : ROLES.USER;
}

export function isAdminUser(user) {
  return canonicalRole(user?.role) === ROLES.ADMIN;
}

export function authorizeRole(user, requiredRole = ROLES.USER) {
  if (!user) return { allowed: false, status: 401 };
  const actual = canonicalRole(user.role);
  const required = canonicalRole(requiredRole);
  return actual === ROLES.ADMIN || required === ROLES.USER
    ? { allowed: true, status: 200 }
    : { allowed: false, status: 403 };
}

export function resolveAuthorizedPage(page, user, fallback = '工作秘书') {
  return ADMIN_PAGES.has(page) && !isAdminUser(user) ? fallback : page;
}

export function filterAuthorizedMenu(menu = [], user) {
  return menu.filter((page) => resolveAuthorizedPage(page, user, '') === page);
}
