import { useEffect, useState } from 'react';
import { createAttachmentPreviewResource } from './attachmentClient.js';

export function useAttachmentPreviewSources(sources) {
  const native = globalThis.Capacitor?.isNativePlatform?.() === true;
  const key = JSON.stringify([...new Set(native ? sources.filter(source =>
    /^\/api\/attachments\/[^/?#]+\/content$/.test(source)) : [])]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState({ key: '', revision: -1, urls: {}, errors: {} });
  useEffect(() => {
    let active = true;
    setState({ key, revision, urls: {}, errors: {} });
    const resources = JSON.parse(key).map(source => {
      const resource = createAttachmentPreviewResource(source);
      resource.ready.then(url => {
        if (active) setState(current => ({ ...current, urls: { ...current.urls, [source]: url } }));
      }, () => {
        if (active) setState(current => ({ ...current, errors: { ...current.errors, [source]: true } }));
      });
      return resource;
    });
    return () => { active = false; resources.forEach(resource => resource.dispose()); };
  }, [key, revision]);
  const current = state.key === key && state.revision === revision ? state : { urls: {}, errors: {} };
  const mediated = new Set(JSON.parse(key));
  return {
    resolve: source => mediated.has(source) ? current.urls[source] || '' : source,
    failed: source => Boolean(current.errors[source]),
    retry: () => setRevision(value => value + 1)
  };
}
