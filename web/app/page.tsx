"use client";

import { useEffect, useState } from "react";
import { signInAnon } from "@/lib/firebase";

// Same-origin in production (Firebase Hosting rewrites /api/** to Cloud Run).
// For local dev, set NEXT_PUBLIC_API_BASE=http://localhost:8080
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

type Check = { ok: boolean; detail: string; ms?: number };
type Status = { state: "loading" } | { state: "done"; check: Check };

const pending: Status = { state: "loading" };

function Row({ name, status }: { name: string; status: Status }) {
  const icon = status.state === "loading" ? "…" : status.check.ok ? "✅" : "❌";
  const detail = status.state === "loading" ? "checking" : status.check.detail;
  const ms = status.state === "done" && status.check.ms !== undefined ? ` · ${status.check.ms} ms` : "";
  return (
    <tr>
      <th scope="row" style={{ textAlign: "left", padding: "8px 16px 8px 0" }}>
        {name}
      </th>
      <td style={{ padding: "8px 16px 8px 0" }} aria-label={status.state === "done" && status.check.ok ? "ok" : "not ok"}>
        {icon}
      </td>
      <td style={{ padding: "8px 0", wordBreak: "break-word" }}>
        {detail}
        {ms}
      </td>
    </tr>
  );
}

export default function Home() {
  const [api, setApi] = useState<Status>(pending);
  const [auth, setAuth] = useState<Status>(pending);
  const [checks, setChecks] = useState<Record<string, Status> | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/healthz`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => setApi({ state: "done", check: { ok: true, detail: `version ${b.version} · model ${b.model}` } }))
      .catch((e: Error) => setApi({ state: "done", check: { ok: false, detail: e.message } }));

    signInAnon()
      .then((uid) => setAuth({ state: "done", check: { ok: true, detail: `anonymous uid ${uid.slice(0, 8)}…` } }))
      .catch((e: Error) => setAuth({ state: "done", check: { ok: false, detail: e.message } }));
  }, []);

  async function runSelftest() {
    setChecks({ firestore: pending, storage: pending, gemini: pending });
    try {
      const res = await fetch(`${API_BASE}/api/selftest`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: { checks: Record<string, Check> } = await res.json();
      setChecks(
        Object.fromEntries(Object.entries(body.checks).map(([k, c]) => [k, { state: "done", check: c } as Status])),
      );
    } catch (e) {
      const failed: Status = { state: "done", check: { ok: false, detail: (e as Error).message } };
      setChecks({ firestore: failed, storage: failed, gemini: failed });
    }
  }

  const running = checks !== null && Object.values(checks).some((s) => s.state === "loading");

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 20px" }}>
      <h1 style={{ marginBottom: 4 }}>ShrinkSight</h1>
      <p style={{ marginTop: 0, color: "#94a3b8" }}>Sees what the till missed. · setup check</p>

      <section aria-labelledby="status-heading" aria-live="polite">
        <h2 id="status-heading" style={{ fontSize: 18 }}>
          Component status
        </h2>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <tbody>
            <Row name="Firebase Hosting" status={{ state: "done", check: { ok: true, detail: "you are viewing it" } }} />
            <Row name="Cloud Run API" status={api} />
            <Row name="Firebase Auth" status={auth} />
            {checks && <Row name="Firestore" status={checks.firestore} />}
            {checks && <Row name="Cloud Storage" status={checks.storage} />}
            {checks && <Row name="Gemini" status={checks.gemini} />}
          </tbody>
        </table>
      </section>

      <button
        type="button"
        onClick={runSelftest}
        disabled={running}
        style={{
          marginTop: 24,
          padding: "10px 18px",
          fontSize: 16,
          borderRadius: 8,
          border: "none",
          background: running ? "#475569" : "#38bdf8",
          color: "#0f172a",
          cursor: running ? "wait" : "pointer",
        }}
      >
        {running ? "Running self-test…" : "Run cloud self-test"}
      </button>
      <p style={{ color: "#94a3b8", fontSize: 14 }}>
        The Gemini check makes at most one live call per minute; repeat runs show the cached result.
      </p>
    </main>
  );
}
