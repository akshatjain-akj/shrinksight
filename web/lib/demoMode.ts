"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { readSession, subscribeSession } from "./session";
import type { DemoClip } from "./types";

export { AlertOnce, forDemoMode } from "./demoAlerts";

/**
 * Demo mode: cameras on the Monitor loop their demo clips and demo-clip incidents are listed. On by default for the
 * demo account, off for everyone else; the choice is remembered per account on this browser.
 */
export const DEMO_EMAIL = "demo@shrinksight.app";
const EVENT = "shrinksight-demo-mode";
const key = (email: string) => `shrinksight.demoMode.${email}`;

export function demoModeOn(): boolean {
  if (typeof window === "undefined") return false;
  const session = readSession();
  if (!session) return false;
  const saved = localStorage.getItem(key(session.email));
  return saved ? saved === "on" : session.email === DEMO_EMAIL;
}

export function setDemoMode(on: boolean): void {
  const session = readSession();
  if (!session) return;
  localStorage.setItem(key(session.email), on ? "on" : "off");
  window.dispatchEvent(new Event(EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  const stopSession = subscribeSession(onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    stopSession();
  };
}

export function useDemoMode(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, demoModeOn, () => false);
  return [on, setDemoMode];
}

/** The demo clips (with results), refreshed every few minutes while `enabled`. */
export function useDemoClips(enabled: boolean) {
  const [clips, setClips] = useState<DemoClip[] | null>(null);
  const [uploads, setUploads] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const load = () =>
      api
        .demoClips()
        .then((body) => {
          if (!current) return;
          setClips(body.clips);
          setUploads(body.uploads);
          setError(null);
        })
        .catch((e: Error) => current && setError(e.message));
    load();
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [enabled, tick]);

  return { clips, uploads, error, reload: () => setTick((n) => n + 1) };
}
