export function createBrowserStorage({ prefix = 'ai-work-center' } = {}) {
  return {
    get(key) {
      const raw = localStorage.getItem(`${prefix}:${key}`);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    },

    set(key, value) {
      localStorage.setItem(`${prefix}:${key}`, JSON.stringify(value));
      return value;
    },

    remove(key) {
      localStorage.removeItem(`${prefix}:${key}`);
      return true;
    },

    list() {
      return Object.fromEntries(
        Object.keys(localStorage)
          .filter((key) => key.startsWith(`${prefix}:`))
          .map((key) => [key.replace(`${prefix}:`, ''), this.get(key.replace(`${prefix}:`, ''))])
      );
    },

    clear() {
      Object.keys(localStorage)
        .filter((key) => key.startsWith(`${prefix}:`))
        .forEach((key) => localStorage.removeItem(key));
    }
  };
}
