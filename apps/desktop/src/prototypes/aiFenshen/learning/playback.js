export function canStartTeacherAudio({ request, pageHidden }) {
  return Boolean(request && !request.signal?.aborted && !pageHidden);
}

export async function loadCachedSpeech(cache, key, load) {
  let cached = cache.get(key);
  if (!cached) {
    const pending = Promise.resolve(load());
    cache.set(key, pending);
    try {
      cached = await pending;
      if (cache.get(key) === pending) cache.set(key, cached);
    } catch (error) {
      if (cache.get(key) === pending) cache.delete(key);
      throw error;
    }
  }
  return await cached;
}
