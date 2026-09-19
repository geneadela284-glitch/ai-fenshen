export const allowingAccessControl = Object.freeze({
  reserveProviderAttempt({ request = {} } = {}) {
    return Object.freeze({ request });
  },
  settleProviderAttempt() {
    return true;
  }
});
