"use client";

import { useEffect, useState } from "react";
import { expiresAt, getLocalClip } from "./localClips";

/** This device's kept copy of an incident's clip, as an object URL, and when it will be deleted. */
export function useLocalClip(incidentId: string | null | undefined): { url: string | null; expiresAt: number | null } {
  const [found, setFound] = useState<{ id: string; url: string; expiresAt: number } | null>(null);

  useEffect(() => {
    if (!incidentId) return;
    let current = true;
    let url: string | null = null;
    void getLocalClip(incidentId).then((clip) => {
      if (!current || !clip) return;
      url = URL.createObjectURL(clip.blob);
      setFound({ id: incidentId, url, expiresAt: expiresAt(clip) });
    });
    return () => {
      current = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [incidentId]);

  // A clip found for a previous incident is never shown for this one.
  if (!found || found.id !== incidentId) return { url: null, expiresAt: null };
  return { url: found.url, expiresAt: found.expiresAt };
}

/** "Your copy on this device · deleted at 18:42 · never stored on our servers". */
export function localClipNote(expiresAt: number): string {
  const at = new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `Your copy on this device · deleted at ${at} · never stored on our servers`;
}
