"use client";

import { collection, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import { useEffect, useState } from "react";
import { api } from "./api";
import { syncLayoutsFromServer } from "./cameraConfig";
import { db, ensureAuth } from "./firebase";
import type { Incident, Rule, Store } from "./types";

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
