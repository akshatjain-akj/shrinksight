"use client";

import { useEffect } from "react";

/** Wakes a scaled-to-zero Cloud Run instance as soon as a judge opens the app. */
export default function Warmup() {
  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_API_BASE ?? "";
    fetch(`${base}/api/healthz`).catch(() => undefined);
  }, []);
  return null;
}
