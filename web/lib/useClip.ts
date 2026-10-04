"use client";

import { useEffect, useState } from "react";
import { api } from "./api";

/** Cameras that have a stored demo clip. Checkout lanes stay as painted scenes. */
export const CLIP_CAMERAS = ["cam-aisle-4", "cam-aisle-2"] as const;
export const CLIP_CAMERA_ID = CLIP_CAMERAS[0];

export function hasClip(cameraId: string | null): boolean {
  return cameraId != null && (CLIP_CAMERAS as readonly string[]).includes(cameraId);
}

/** Fetches a short-lived signed URL and refreshes it before it expires. */
export function useClipUrl(cameraId: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!cameraId || !hasClip(cameraId)) {
      setUrl(null);
      return;
    }
    const id = cameraId;
    let cancelled = false;
    const load = () =>
      api
        .clip(id)
        .then((body) => {
          if (!cancelled) setUrl(body.url);
        })
        .catch(() => {
          if (!cancelled) setUrl(null);
        });
    load();
    const timer = setInterval(load, 12 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [cameraId]);

  return url;
}
