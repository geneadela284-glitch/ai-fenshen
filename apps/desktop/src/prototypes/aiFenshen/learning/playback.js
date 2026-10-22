export function canStartTeacherAudio({ request, pageHidden }) {
  return Boolean(request && !request.signal?.aborted && !pageHidden);
}

const pendingSignals = new WeakMap();
export async function loadCachedSpeech(cache, key, load, signal) {
  signal?.throwIfAborted();
  let cached = cache.get(key);
  if (cached && pendingSignals.get(cached)?.aborted) { cache.delete(key); cached = null; }
  if (!cached) {
    const pending = Promise.resolve(load());
    cache.set(key, pending);
    if (signal) pendingSignals.set(pending, signal);
    try {
      cached = await pending;
      signal?.throwIfAborted();
      if (cache.get(key) === pending) cache.set(key, cached);
    } catch (error) {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    }
  }
  const result = await cached;
  signal?.throwIfAborted();
  return result;
}
