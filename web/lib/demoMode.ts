"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { readSession, subscribeSession } from "./session";
import { addSighting, type DemoSighting } from "./demoAlerts";
import type { DemoClip, Incident } from "./types";

export {
  ALERTING,
  forDemoMode,
  shouldAlert,
  withDemoIncidents,
  withSightings,
  type DemoSighting,
} from "./demoAlerts";

/**
 * Demo mode: cameras on the Monitor loop their demo clips and demo-clip incidents are listed.
 * Off until this browser turns it on; the choice is remembered per account.
 */
const EVENT = "shrinksight-demo-mode";
const key = (email: string) => `shrinksight.demoMode.${email}`;

export function demoModeOn(): boolean {
  if (typeof window === "undefined") return false;
  const session = readSession();
  if (!session) return false;
  return localStorage.getItem(key(session.email)) === "on";
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

/** Every demo clip's stored result (they fall outside the newest-incidents window), refreshed every minute. */
export function useDemoIncidents(enabled: boolean): Incident[] {
  const [items, setItems] = useState<Incident[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    const load = () =>
      api
        .demoIncidents()
        .then((list) => current && setItems(list))
        .catch(() => undefined);
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [enabled]);
  return enabled ? items : NO_INCIDENTS;
}

const NO_INCIDENTS: Incident[] = [];

/*
 * What the Monitor wall has flagged during this sign-in. Kept in localStorage under a key tied to the session, so every
 * tab shares it, while a new sign-in (or a new incognito window) starts fresh. The Monitor alerts once per clip per
 * sign-in, and Playback lists exactly these demo incidents.
 */
const SEEN_PREFIX = "shrinksight.demoSeen.";
const SEEN_EVENT = "shrinksight-demo-seen";
const NONE: DemoSighting[] = [];
let seenRaw: string | null | undefined;
let seenSnapshot: DemoSighting[] = NONE;

function seenKey(): string | null {
  const session = readSession();
  if (!session) return null;
  return `${SEEN_PREFIX}${session.email}.${session.exp ?? session.token.slice(-12)}`;
}

/** Drops the wall's "already flagged" list so a clip can alert again when it next reaches its moment. */
export function clearSightings(): void {
  if (typeof window === "undefined") return;
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(SEEN_PREFIX)) localStorage.removeItem(key);
  }
  seenRaw = undefined;
  seenSnapshot = NONE;
  window.dispatchEvent(new Event(SEEN_EVENT));
}

export function readSightings(): DemoSighting[] {
  if (typeof window === "undefined") return NONE;
  const storageKey = seenKey();
  const raw = storageKey ? localStorage.getItem(storageKey) : null;
  if (raw !== seenRaw) {
    seenRaw = raw;
    try {
      const parsed = raw ? (JSON.parse(raw) as DemoSighting[]) : NONE;
      seenSnapshot = Array.isArray(parsed) ? parsed : NONE;
    } catch {
      seenSnapshot = NONE;
    }
  }
  return seenSnapshot;
}

export function recordSighting(sighting: DemoSighting): boolean {
  const storageKey = seenKey();
  if (!storageKey) return false;
  const current = readSightings();
  const next = addSighting(current, sighting);
  if (next === current) return false;
  // Lists from earlier sign-ins are dropped so they never pile up.
  for (const stale of Object.keys(localStorage)) {
    if (stale.startsWith(SEEN_PREFIX) && stale !== storageKey) localStorage.removeItem(stale);
  }
  localStorage.setItem(storageKey, JSON.stringify(next));
  window.dispatchEvent(new Event(SEEN_EVENT));
  return true;
}

function subscribeSeen(onChange: () => void): () => void {
  window.addEventListener(SEEN_EVENT, onChange);
  // Another tab flagged a clip, or the sign-in changed.
  window.addEventListener("storage", onChange);
  const stopSession = subscribeSession(onChange);
  return () => {
    window.removeEventListener(SEEN_EVENT, onChange);
    window.removeEventListener("storage", onChange);
    stopSession();
  };
}

export function useSightings(): DemoSighting[] {
  return useSyncExternalStore(subscribeSeen, readSightings, () => NONE);
}
