"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ClipRecorder from "@/components/ClipRecorder";
import IncidentDetail from "@/components/IncidentDetail";
import ProgressSteps, { type Step } from "@/components/ProgressSteps";
import ReceiptEditor, { emptyLine } from "@/components/ReceiptEditor";
import { ErrorNotice, Skeletons } from "@/components/ui";
import { api, investigateStream, type InvestigateMeta } from "@/lib/api";
import { inr } from "@/lib/format";
import { useStore } from "@/lib/hooks";
import type { Incident, ReceiptLine, Transaction } from "@/lib/types";

const MAX_BYTES = 15 * 1024 * 1024;
const CUSTOM = "custom";

export default function InvestigatePage() {
  const { store, error: storeError } = useStore();
  const [cameraId, setCameraId] = useState("cam-sco-1");
  const [source, setSource] = useState<"upload" | "record">("upload");
  const [clip, setClip] = useState<Blob | null>(null);
  const [clipUrl, setClipUrl] = useState<string | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [receiptChoice, setReceiptChoice] = useState(CUSTOM);
  const [lines, setLines] = useState<ReceiptLine[]>([emptyLine()]);
  const [consent, setConsent] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ incident: Incident; cached: boolean } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const camera = store?.cameras.find((c) => c.id === cameraId);
  const isCheckout = camera?.kind === "checkout";

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => () => {
    if (clipUrl) URL.revokeObjectURL(clipUrl);
  }, [clipUrl]);

  useEffect(() => {
    if (!camera?.lane_id) return;
    api
      .transactions(camera.lane_id)
      .then(setTransactions)
      .catch(() => setTransactions([]));
  }, [camera?.lane_id]);

  const acceptClip = (blob: Blob) => {
    setClipError(null);
    setResult(null);
    if (blob.size > MAX_BYTES) {
      setClip(null);
      setClipUrl(null);
      setClipError(`That clip is ${(blob.size / 1024 / 1024).toFixed(1)} MB; the limit is 15 MB. Trim it or record a shorter one.`);
      return;
    }
    setClip(blob);
    setClipUrl(URL.createObjectURL(blob));
  };

  const customLines = lines.filter((l) => l.name.trim());
  const receiptReady = !isCheckout || receiptChoice !== CUSTOM || customLines.length > 0;
  const canRun = Boolean(camera && clip && consent && receiptReady && !running);

  const run = async () => {
    if (!camera || !clip) return;
    const meta: InvestigateMeta = { camera_id: camera.id };
    if (isCheckout) {
      if (receiptChoice === CUSTOM) meta.receipt = customLines.map((l) => ({ name: l.name.trim(), price_inr: l.price_inr }));
      else meta.transaction_id = receiptChoice;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError(null);
    setResult(null);
    setSteps([{ label: "Uploading the clip", done: false }]);
    try {
      await investigateStream(
        clip,
        meta,
        (event) => {
          if (event.type === "progress") {
            setSteps((prev) => [...prev.map((s) => ({ ...s, done: true })), { label: event.label, done: false }]);
          } else if (event.type === "result") {
            setSteps((prev) => prev.map((s) => ({ ...s, done: true })));
            setResult({ incident: event.incident, cached: event.cached });
          } else {
            setError(event.message);
          }
        },
        controller.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const reset = () => {
    setResult(null);
    setSteps([]);
    setError(null);
    setClip(null);
    setClipUrl(null);
  };

  if (result) {
    return (
      <>
        <div className="row" style={{ marginBottom: "1rem" }}>
          <button type="button" className="btn" onClick={reset}>
            ← Investigate another clip
          </button>
          <Link href="/monitor" className="btn btn-ghost">
            See it in the monitor
          </Link>
          {result.cached && <span className="chip">Cached analysis · no AI quota used</span>}
        </div>
        <IncidentDetail incident={result.incident} videoUrl={clipUrl ?? undefined} />
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Investigate a clip</h1>
          <p>Upload or record a short clip. A Gemini agent watches it, checks the till receipt and reports what happened.</p>
        </div>
        <span className="chip tone-accent">Beta</span>
      </div>

      {storeError && <ErrorNotice>Couldn’t load the store: {storeError}</ErrorNotice>}
      {!store && !storeError && <Skeletons count={3} />}

      {store && (
        <div className="grid-main">
          <div className="stack">
            <section className="card stack" aria-labelledby="step1">
              <h2 id="step1">1 · Which camera is this?</h2>
              <div className="choice-grid" role="radiogroup" aria-labelledby="step1">
                {store.cameras.map((c) => (
                  <label key={c.id} className="choice">
                    <input
                      type="radio"
                      name="camera"
                      value={c.id}
                      checked={cameraId === c.id}
                      onChange={() => setCameraId(c.id)}
                    />
                    <strong>{c.name}</strong>
                    <span className="muted small">{c.kind === "checkout" ? "Checks against the till receipt" : "Watches for concealment"}</span>
                  </label>
                ))}
              </div>
            </section>

            <section className="card stack" aria-labelledby="step2">
              <div className="row">
                <h2 id="step2" style={{ margin: 0 }}>
                  2 · The clip
                </h2>
                <span className="spacer" />
                <div className="tabs" role="tablist" aria-label="Clip source">
                  <button type="button" role="tab" aria-selected={source === "upload"} onClick={() => setSource("upload")}>
                    Upload
                  </button>
                  <button type="button" role="tab" aria-selected={source === "record"} onClick={() => setSource("record")}>
                    Record with webcam
                  </button>
                </div>
              </div>
              {source === "upload" ? (
                <div className="field">
                  <label htmlFor="clip-file">Video file (MP4, WebM or MOV, up to 15 MB, ideally 5–20 s)</label>
                  <input
                    id="clip-file"
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime,video/*"
                    onChange={(e) => e.target.files?.[0] && acceptClip(e.target.files[0])}
                  />
                </div>
              ) : (
                <ClipRecorder onClip={acceptClip} />
              )}
              {clipError && <ErrorNotice>{clipError}</ErrorNotice>}
              {clipUrl && clip && (
                <div className="preview stack">
                  <video src={clipUrl} controls playsInline muted aria-label="Selected clip preview" />
                  <span className="muted small">Ready · {(clip.size / 1024 / 1024).toFixed(1)} MB</span>
                </div>
              )}
            </section>

            {isCheckout && (
              <section className="card stack" aria-labelledby="step3">
                <h2 id="step3">3 · What did the till scan?</h2>
                <div className="field">
                  <label htmlFor="receipt-choice">Till receipt for this visit</label>
                  <select id="receipt-choice" value={receiptChoice} onChange={(e) => setReceiptChoice(e.target.value)}>
                    <option value={CUSTOM}>Type the items that were scanned…</option>
                    {transactions.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.id} · {t.lines.length} items · {inr(t.total_inr)}
                      </option>
                    ))}
                  </select>
                  <span className="hint">
                    For your own clip, list only the items you actually passed over the scanner. Gemini compares this with
                    what it sees.
                  </span>
                </div>
                {receiptChoice === CUSTOM && <ReceiptEditor lines={lines} onChange={setLines} />}
              </section>
            )}
          </div>

          <aside className="card stack" aria-labelledby="run-title" style={{ position: "sticky", top: "5rem" }}>
            <h2 id="run-title">{isCheckout ? "4" : "3"} · Investigate</h2>
            <label className="row" style={{ alignItems: "flex-start", fontWeight: 400 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 4 }} />
              <span className="small">
                Everyone in this clip agreed to be recorded (for example, it’s you). The clip is analysed by Gemini and not
                stored; only the report is kept.
              </span>
            </label>
            <button type="button" className="btn btn-primary" disabled={!canRun} onClick={run}>
              {running ? "Investigating…" : "Investigate with Gemini"}
            </button>
            {!clip && <span className="hint">Add a clip to start.</span>}
            {clip && !receiptReady && <span className="hint">Add at least one scanned item.</span>}
            {clip && receiptReady && !consent && <span className="hint">Tick the consent box to continue.</span>}
            {steps.length > 0 && <ProgressSteps steps={steps} running={running} />}
            {error && (
              <ErrorNotice onRetry={canRun ? run : undefined}>{error}</ErrorNotice>
            )}
            <p className="hint" style={{ margin: 0 }}>
              Free-tier AI quota is shared, so investigations are rate-limited. Re-running the same clip is instant.
            </p>
          </aside>
        </div>
      )}
    </>
  );
}
