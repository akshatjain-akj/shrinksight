"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

/** Re-signs a short-lived URL before it expires. `load` returning null means "no clip". */
function useSigned(key: string | null, load: (key: string) => Promise<string>): string | null {
  const [found, setFound] = useState<{ key: string; url: string } | null>(null);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const fetchUrl = () =>
      load(key)
        .then((url) => !cancelled && setFound({ key, url }))
        .catch(() => !cancelled && setFound(null));
    fetchUrl();
    const timer = setInterval(fetchUrl, 12 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // load is a stable module-level function per caller
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return found && found.key === key ? found.url : null;
}

/** The demo clip a camera plays in demo mode (null when off, or when the camera has none). */
export function useClipUrl(cameraId: string | null, enabled = true): string | null {
  return useSigned(enabled ? cameraId : null, (id) => api.clip(id).then((body) => body.url));
}

/** A specific demo clip, e.g. the one a demo incident was analysed from. */
export function useDemoClipUrl(object: string | null | undefined): string | null {
  return useSigned(object ?? null, (name) => api.demoClipUrl(name).then((body) => body.url));
}
