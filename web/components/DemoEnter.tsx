"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, demoLoginOn, openDemoSession } from "@/lib/api";
import { saveSession } from "@/lib/session";

/** One click into the demo store as its manager. Hidden when the server has the demo login switched off. */
export default function DemoEnter({ className, label = "Enter the demo store" }: { className?: string; label?: string }) {
  const router = useRouter();
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let current = true;
    void demoLoginOn().then((value) => current && setOn(value));
    return () => {
      current = false;
    };
  }, []);

  if (!on) return null;

  const enter = async () => {
    setBusy(true);
    setError("");
    try {
      const session = await openDemoSession();
      if (!saveSession(session, false)) {
        setError("The demo session couldn’t be used. Refresh the page and try again.");
        return;
      }
      router.push("/monitor");
    } catch (err) {
      // A cold start can take a few seconds; the message says so instead of failing silently.
      setError(err instanceof ApiError ? err.message : "Couldn’t reach the server. It may be waking up; try again in a few seconds.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={className} onClick={enter} disabled={busy} aria-busy={busy}>
        {busy ? "Opening the demo store…" : label}
      </button>
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
