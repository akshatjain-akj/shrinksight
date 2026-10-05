"use client";

import { collection, doc, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { useEffect, useState } from "react";
import { api } from "./api";
import { syncLayoutsFromServer } from "./cameraConfig";
import { db, ensureAuth } from "./firebase";
import { DEFAULT_TUNING, type EdgeTuning } from "./tier1/engine";
import type { EdgeConfig, Incident, Rule, Store } from "./types";

interface LiveState<T> {
  data: T[] | null;
  error: string | null;
  live: boolean;
}

/**
 * Loads a collection through the API first (which also seeds Firestore on a fresh project), then keeps it
 * updated in real time via a Firestore listener. Falls back to polling the API if the listener fails.
 */
function useLiveCollection<T>(collectionName: string, fetcher: () => Promise<T[]>, max = 50): LiveState<T> {
  const [state, setState] = useState<LiveState<T>>({ data: null, error: null, live: false });

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;

    const load = () =>
      fetcher()
        .then((data) => !cancelled && setState((s) => ({ ...s, data, error: null })))
        .catch((err: Error) => !cancelled && setState((s) => ({ ...s, error: s.data ? null : err.message })));

    const startPolling = () => {
      if (!poll) poll = setInterval(load, 10_000);
    };

    load();
    ensureAuth()
      .then(() => {
        if (cancelled) return;
        const q = query(collection(db(), collectionName), orderBy("created_at", "desc"), limit(max));
        unsubscribe = onSnapshot(
          q,
          (snap) => {
            if (cancelled || snap.empty) return;
            setState({ data: snap.docs.map((d) => d.data() as T), error: null, live: true });
          },
          () => {
            setState((s) => ({ ...s, live: false }));
            startPolling();
          },
        );
      })
      .catch(startPolling);

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (poll) clearInterval(poll);
    };
  }, [collectionName, fetcher, max]);

  return state;
}

export function useIncidents() {
  return useLiveCollection<Incident>("incidents", api.incidents);
}

export function useRules() {
  return useLiveCollection<Rule>("rules", api.rules);
}

export function useStore() {
  const [store, setStore] = useState<Store | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .store()
      .then((loaded) => {
        setStore(loaded);
        void syncLayoutsFromServer();
      })
      .catch((err: Error) => setError(err.message));
  }, []);
  return { store, error };
}

export function toTuning(config: EdgeConfig | null): EdgeTuning {
  if (!config) return DEFAULT_TUNING;
  return { sendScore: config.send_score, hotFrames: config.hot_frames, holdExtraMs: config.hold_extra_ms };
}

/**
 * The camera's auto-tuned Tier-1 gate, kept live with a Firestore listener on edge_config/{camera}: when the server
 * makes the gate stricter (or staff undo it), every open Live edge and Monitor picks it up without a reload.
 */
export function useEdgeConfig(cameraId: string | null | undefined) {
  const [config, setConfig] = useState<EdgeConfig | null>(null);
  useEffect(() => {
    if (!cameraId) return;
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    setConfig(null);
    api
      .edgeConfig(cameraId)
      .then((loaded) => !cancelled && setConfig(loaded))
      .catch(() => undefined);
    ensureAuth()
      .then(() => {
        if (cancelled) return;
        unsubscribe = onSnapshot(
          doc(db(), "edge_config", cameraId),
          (snap) => {
            if (!cancelled && snap.exists()) setConfig(snap.data() as EdgeConfig);
          },
          () => undefined, // the API copy above still applies
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [cameraId]);
  return { config, setConfig, tuning: toTuning(config) };
}
