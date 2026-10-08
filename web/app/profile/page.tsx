"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { clearLocalClips, keepClipsOn, localClipStats, setKeepClips } from "@/lib/localClips";
import { emptySession, readSession, subscribeSession } from "@/lib/session";

export default function ProfilePage() {
  const session = useSyncExternalStore(subscribeSession, readSession, emptySession);
  const [keep, setKeep] = useState(false);
  const [stats, setStats] = useState<{ count: number; bytes: number } | null>(null);

  const refresh = () => void localClipStats().then(setStats);

  useEffect(() => {
    setKeep(keepClipsOn());
    refresh();
  }, []);

  const toggle = (on: boolean) => {
    setKeep(on);
    setKeepClips(on);
    window.setTimeout(refresh, 300);
  };

  const clear = async () => {
    await clearLocalClips();
    refresh();
  };

  return (
    <div className="stack" style={{ maxWidth: 520 }}>
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <p>The account signed in on this desk.</p>
        </div>
      </div>
      <section className="card stack">
        <p style={{ margin: 0 }}>
          <span className="muted">Email</span>
          <br />
          <strong>{session?.email ?? "—"}</strong>
        </p>
        <p style={{ margin: 0 }}>
          <span className="muted">Role</span>
          <br />
          <strong>{session?.role ?? "—"}</strong>
        </p>
      </section>
      <section className="card stack" aria-labelledby="device-clips">
        <h2 id="device-clips" style={{ margin: 0 }}>
          Clips on this device
        </h2>
        <p className="muted small" style={{ margin: 0 }}>
          Clips are never stored on our servers. To replay an incident with Gemini’s boxes, this browser can keep its own
          copy of clips you send for 24 hours. Signing out deletes them.
        </p>
        <label className="row" style={{ fontWeight: 400 }}>
          <input type="checkbox" checked={keep} onChange={(e) => toggle(e.target.checked)} />
          <span>Keep my clips on this device for 24 h</span>
        </label>
        <div className="row">
          <span className="muted small">
            {stats == null
              ? "Checking…"
              : stats.count === 0
                ? "No clips kept"
                : `${stats.count} clip${stats.count === 1 ? "" : "s"} · ${(stats.bytes / 1024 / 1024).toFixed(1)} MB`}
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={clear} disabled={!stats?.count}>
            Delete clips on this device
          </button>
        </div>
      </section>
    </div>
  );
}
