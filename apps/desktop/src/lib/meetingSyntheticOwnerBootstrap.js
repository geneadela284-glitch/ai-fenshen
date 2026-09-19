export function parseSyntheticOwnerBootstrapUsernames(value = '') {
  return Object.freeze(
    [...new Set(
      String(value)
        .split(',')
        .map((username) => username.trim())
        .filter(Boolean)
    )]
  );
}

export function shouldInitializeSyntheticOwnerKey({ enabled = false, username = '', allowedUsernames = [] } = {}) {
  return enabled === true && allowedUsernames.includes(String(username).trim());
}
