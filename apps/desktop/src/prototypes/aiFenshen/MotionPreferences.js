import { useEffect, useState } from 'react';

export function useReducedMotion(forced = false) {
  const [reduced, setReduced] = useState(() => forced || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false);

  useEffect(() => {
    if (forced || !globalThis.matchMedia) {
      setReduced(Boolean(forced));
      return undefined;
    }
    const query = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, [forced]);

  return reduced;
}
