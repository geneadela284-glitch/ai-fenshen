// Used only in the JavaScriptCore bundle. All primitives come from CryptoKit/Security.
const host = () => globalThis.__memoryCrypto;
export default {
  createHash(algorithm) {
    if (algorithm !== 'sha256') throw new Error('Unsupported digest');
    let text = '';
    return { update(value) { text += String(value); return this; }, digest(format) {
      if (format !== 'hex') throw new Error('Unsupported digest encoding');
      return host().sha256(text);
    } };
  },
  randomUUID: () => host().uuid(),
  randomBytes: count => ({ toString(format) {
    if (format !== 'hex') throw new Error('Unsupported random encoding');
    const value = host().randomHex(count);
    if (typeof value !== 'string' || value.length !== count * 2) throw new Error('Secure random failed');
    return value;
  } })
};
