"use client";

import { useSyncExternalStore } from "react";
import { emptySession, readSession, subscribeSession } from "@/lib/session";

export default function ProfilePage() {
  const session = useSyncExternalStore(subscribeSession, readSession, emptySession);

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
    </div>
  );
}
