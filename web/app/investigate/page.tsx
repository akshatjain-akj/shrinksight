"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ClipRecorder from "@/components/ClipRecorder";
import IncidentDetail from "@/components/IncidentDetail";
import InventoryConfirm, { INVENTORY_OFF, type InventoryState } from "@/components/InventoryConfirm";
import ProgressSteps, { type Step } from "@/components/ProgressSteps";
import ReceiptEditor, { emptyLine } from "@/components/ReceiptEditor";
import ScannerPhoto, { SCANNER_PHOTO_NONE, type ScannerPhotoState } from "@/components/ScannerPhoto";
import Tier1ScreenCard, { hitText } from "@/components/Tier1ScreenCard";
import { ErrorNotice, Skeletons } from "@/components/ui";
import ZoneMarker, { markedShapes, type ZoneState } from "@/components/ZoneMarker";
import { api, investigateStream, saveDemoClip, type InvestigateMeta, type MarkedStill } from "@/lib/api";
import { polygonsForCamera, savedDescriptions, savedZoneIds, syncLayoutsFromServer } from "@/lib/cameraConfig";
import { VERDICT_LABEL, inr } from "@/lib/format";
import { keepClipsOn, saveLocalClip } from "@/lib/localClips";
import { canvasToJpeg, firstFrame, markedStills, numberedPile, pileViews, type Frame, type PileViews } from "@/lib/frames";
import { shrinkClip } from "@/lib/transcode";
import { toTuning, useEdgeConfig, useRules, useStore } from "@/lib/hooks";
import { stamp } from "@/lib/tier1/engine.ts";
import { scanClip, type ScanResult } from "@/lib/tier1/scanClip";
import { actionCrop, applyHints, rectToBox, shapesToHints } from "@/lib/tier1/zones";
import type { DemoClip, Incident, ReceiptLine, TokenUsage, Transaction, VerdictKind, ZoneHint } from "@/lib/types";

const MAX_BYTES = 25 * 1024 * 1024;
const CUSTOM = "custom";
const SCREEN_KEY = "shrinksight.tier1Screen";
const VERDICTS: VerdictKind[] = ["BENIGN", "SCAN_AVOIDANCE", "CONCEALMENT", "RULE_BREACH", "INCONCLUSIVE"];

export default function InvestigatePage() {
  const { store, error: storeError } = useStore();
  const { data: rules } = useRules();
  const [cameraId, setCameraId] = useState("cam-sco-1");
  // Optional Tier-1 screening (off by default, remembered on this browser). It scans on this device and shows what it
  // decided and measured; staff then send the clip to Gemini with or without the measurements.
  const [screenOn, setScreenOn] = useState(false);
  const [screened, setScreened] = useState<ScanResult | null>(null);
  const [screenNote, setScreenNote] = useState<string | null>(null);
  const [source, setSource] = useState<"upload" | "record">("upload");
  const [clip, setClip] = useState<Blob | null>(null);
  const [clipName, setClipName] = useState("clip.webm");
  // Demo clips: analysing one (opened from Settings → Demo clips), or saving this clip as a new one.
  const [demoClip, setDemoClip] = useState<DemoClip | null>(null);
  const [demoUploads, setDemoUploads] = useState(false);
  const [saveAsDemo, setSaveAsDemo] = useState(false);
  const [expected, setExpected] = useState<VerdictKind | "">("");
  const [demoNote, setDemoNote] = useState<string | null>(null);
  const [savedDemo, setSavedDemo] = useState<string | null>(null);
  // Zones saved with the demo clip, applied once the camera's own zone boxes are loaded.
  const [pendingHints, setPendingHints] = useState<ZoneHint[] | null>(null);
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
  // This device's copy of the clip for replay: when it will be deleted, or "failed" if the browser refused it.
  const [keptUntil, setKeptUntil] = useState<number | "failed" | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [zoneState, setZoneState] = useState<ZoneState | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [scannerPhoto, setScannerPhoto] = useState<ScannerPhotoState>(SCANNER_PHOTO_NONE);
  const [savedPhotos, setSavedPhotos] = useState<Record<string, string>>({});
  const inventoryUsageRef = useRef<TokenUsage | null>(null);
  const [inventory, setInventoryState] = useState<InventoryState>(INVENTORY_OFF);
  // The run loop reads the latest list (and whether the user is editing it) through this ref.
  const inventoryRef = useRef<InventoryState>(INVENTORY_OFF);
  const setInventory = (next: InventoryState) => {
    inventoryRef.current = next;
    setInventoryState(next);
  };

  /** Waits until the list can be used: auto when untouched, or after "Continue" if the user edited it. */
  const awaitInventory = async (signal: AbortSignal, prepDoneAt: number): Promise<InventoryState> => {
    for (;;) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const current = inventoryRef.current;
      if (current.status === "off" || current.status === "failed") return current;
      if (current.status === "ready" && (!current.touched || current.confirmed)) return current;
      if (current.status === "listing" && Date.now() - prepDoneAt > 8000) {
        const timedOut: InventoryState = { ...current, status: "failed" };
        setInventory(timedOut);
        return timedOut;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  const camera = store?.cameras.find((c) => c.id === cameraId);
  const isCheckout = camera?.kind === "checkout";
  // The same auto-tuned gate this camera uses on Live edge.
  const { config: edgeConfig } = useEdgeConfig(camera?.id);
  const gate = toTuning(edgeConfig);

  useEffect(() => setScreenOn(localStorage.getItem(SCREEN_KEY) === "on"), []);
  const toggleScreen = (on: boolean) => {
    setScreenOn(on);
    localStorage.setItem(SCREEN_KEY, on ? "on" : "off");
    setScreened(null);
  };

  useEffect(() => {
    api
      .scannerPhotos()
      .then(setSavedPhotos)
      .catch(() => setSavedPhotos({}));
  }, []);

  // A photo picked for one camera's clip doesn't carry over to another camera; nor does a Tier-1 screening.
  useEffect(() => {
    setScannerPhoto(SCANNER_PHOTO_NONE);
    setScreened(null);
  }, [cameraId]);

  // The camera's saved layout is the starting point; boxes are only sent once they're real.
  useEffect(() => {
    if (!camera || !store) return;
    let cancelled = false;
    setZoneState(null);
    void syncLayoutsFromServer().then(() => {
      if (cancelled) return;
      const zones = store.zones.filter((z) => camera.zone_ids.includes(z.id));
      const marked = savedZoneIds(camera.id).filter((id) => camera.zone_ids.includes(id));
      setZoneState({
        shapes: polygonsForCamera(camera.id, zones),
        descriptions: savedDescriptions(camera.id),
        marked,
        send: marked.length > 0,
        saved: marked.length > 0,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [camera, store]);

  // Apply a demo clip's saved zones to this camera's boxes as soon as they exist.
  useEffect(() => {
    if (!zoneState || !pendingHints || !camera) return;
    // Wait for this camera's boxes (right after a camera switch the previous camera's may still be here).
    if (!zoneState.shapes.some((shape) => camera.zone_ids.includes(shape.id))) return;
    const out = applyHints(zoneState.shapes, zoneState.descriptions, pendingHints);
    setPendingHints(null);
    if (!out.placed.length) return;
    setZoneState({ ...zoneState, shapes: out.shapes, descriptions: out.descriptions, marked: out.placed, send: true, saved: false });
  }, [zoneState, pendingHints, camera]);

  // Whether this account may save demo clips (never the demo account, and only while DEMO_CLIP_UPLOADS is on).
  useEffect(() => {
    api
      .demoClips()
      .then((body) => setDemoUploads(body.uploads))
      .catch(() => setDemoUploads(false));
  }, []);

  // ?demo=<clip>: analyse a demo clip, pre-filled with its camera, zones, receipt and expected verdict.
  const demoParam = useRef<string | null>(null);
  useEffect(() => {
    if (!store || demoParam.current !== null) return;
    demoParam.current = new URLSearchParams(window.location.search).get("demo") ?? "";
    const wanted = demoParam.current;
    if (!wanted) return;
    let cancelled = false;
    setDemoNote("Loading the demo clip…");
    (async () => {
      const { clips } = await api.demoClips();
      const found = clips.find((item) => item.object === wanted);
      if (!found) throw new Error("That demo clip no longer exists.");
      const target =
        store.cameras.find((c) => found.cameras.includes(c.id) && c.kind === found.kind) ??
        store.cameras.find((c) => c.kind === found.kind);
      if (!target) throw new Error(`Add a ${found.kind} camera first.`);
      const { url } = await api.demoClipUrl(found.object);
      const blob = await (await fetch(url)).blob();
      if (cancelled) return;
      setDemoClip(found);
      setCameraId(target.id);
      setPendingHints(found.zones.length ? found.zones : null);
      if (found.receipt.length) {
        setReceiptChoice(CUSTOM);
        setLines(found.receipt.map((line) => ({ ...emptyLine(), name: line.name, price_inr: line.price_inr })));
      }
      setExpected(found.expected ?? "");
      acceptClip(new File([blob], found.name, { type: blob.type || "video/mp4" }));
      setDemoNote(null);
    })().catch((e: Error) => !cancelled && setDemoNote(`Couldn’t open the demo clip: ${e.message}`));
    return () => {
      cancelled = true;
    };
    // acceptClip and the setters are stable for this one-off load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  useEffect(() => {
    if (!clipUrl) return;
    let cancelled = false;
    setFrame(null);
    setFrameError(null);
    firstFrame(clipUrl)
      .then((f) => !cancelled && setFrame(f))
      .catch(() => !cancelled && setFrameError("Couldn’t read a frame from this clip. You can still investigate it without zones."));
    return () => {
      cancelled = true;
    };
  }, [clipUrl]);

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
    setScreened(null);
    setScreenNote(null);
    if (blob.size > MAX_BYTES) {
      setClip(null);
      setClipUrl(null);
      setClipError(`That clip is ${(blob.size / 1024 / 1024).toFixed(1)} MB; the limit is 25 MB. Trim it or record a shorter one.`);
      return;
    }
    setClip(blob);
    setClipName(blob instanceof File && blob.name ? blob.name : "recorded-clip.webm");
    setClipUrl(URL.createObjectURL(blob));
  };

  const customLines = lines.filter((l) => l.name.trim());
  const receiptReady = !isCheckout || receiptChoice !== CUSTOM || customLines.length > 0;
  const canRun = Boolean(camera && clip && consent && receiptReady && !running);

  const receiptLines = !isCheckout
    ? null
    : receiptChoice === CUSTOM
      ? customLines.length
      : (transactions.find((t) => t.id === receiptChoice)?.lines.length ?? null);

  /** Tier-1 on this device only: shows what the gate decided and what it measured. Gemini is not called. */
  const screen = async () => {
    if (!camera || !clipUrl) return;
    setScreened(null);
    setScreenNote(null);
    setError(null);
    // Only zones that were really placed: preset boxes sit wherever the preset puts them, not on this store's shelf.
    const placed = zoneState ? markedShapes(zoneState) : [];
    const has = (kind: string) => placed.some((zone) => zone.kind === kind);
    const missing = isCheckout
      ? ["scanner", "bagging"].filter((kind) => !has(kind))
      : has("shelf") ? [] : ["shelf"];
    if (missing.length) {
      setScreenNote(
        `Tier-1 needs the ${missing.join(" and ")} zone${missing.length > 1 ? "s" : ""} placed on this clip (drag, suggest or load the saved layout) before it can screen it.`,
      );
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    const relabel = (label: string) => setSteps((prev) => [...prev.slice(0, -1), { label, done: false }]);
    setSteps([{ label: "Tier-1 screening on this device · 0%", done: false }]);
    try {
      const scan = await scanClip(clipUrl, {
        cameraKind: camera.kind,
        zones: placed,
        rules: rules ?? [],
        tuning: gate,
        signal: controller.signal,
        onProgress: (f) => relabel(`Tier-1 screening on this device · ${Math.round(f * 100)}%`),
      });
      const first = scan.hits[0];
      relabel(
        scan.flagged
          ? `Tier-1 gate opened at ${stamp(scan.openedAtMs ?? 0)}${first ? ` (${hitText(first)})` : ""}`
          : "Tier-1 gate stayed shut",
      );
      setSteps((prev) => prev.map((step) => ({ ...step, done: true })));
      setScreened(scan);
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setSteps([]);
        setScreenNote(`Tier-1 couldn’t screen this clip (${(e as Error).message}). Untick it to send the clip to Gemini directly.`);
      }
    } finally {
      setRunning(false);
    }
  };

  /** tier1: the screening result and whether its measurements and close-ups go with the clip. */
  const run = async ({ tier1 }: { tier1?: { scan: ScanResult; withMeasurements: boolean } } = {}) => {
    if (!camera || !clip) return;
    const zonesToSend = zoneState?.send ? markedShapes(zoneState) : [];
    const sendZones = zonesToSend.length > 0;
    const meta: InvestigateMeta = {
      camera_id: camera.id,
      origin: "upload",
      zones: shapesToHints(zonesToSend, zoneState?.descriptions ?? {}),
      ...(frame?.duration ? { clip_seconds: Math.round(frame.duration * 10) / 10 } : {}),
    };
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
    const relabel = (label: string) => setSteps((prev) => [...prev.slice(0, -1), { label, done: false }]);
    const advance = (label: string) =>
      setSteps((prev) => [...prev.map((s) => ({ ...s, done: true })), { label, done: false }]);
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

    // Demo clips: analysing an existing one, or saving this original file as a new one first. Either way the
    // incident becomes that clip's one stored result (the server always asks Gemini again for it).
    setSavedDemo(null);
    if (demoClip && demoClip.kind === camera.kind) {
      meta.demo_clip = demoClip.object;
    } else if (saveAsDemo && demoUploads) {
      setSteps([{ label: "Saving the demo clip", done: false }]);
      try {
        const saved = await saveDemoClip(clip, clipName, camera.id, {
          receipt: meta.receipt,
          zones: meta.zones,
          expected: expected || undefined,
        });
        meta.demo_clip = saved.object;
      } catch (e) {
        setError(`Couldn’t save the demo clip: ${(e as Error).message}`);
        setRunning(false);
        return;
      }
    }

    // 0. Tier-1's result rides along: the gate's decision always, the measurements and close-ups if chosen. The
    // gate's own signal names ("put back", "possible hide") are conclusions, so they never go to Gemini.
    const handStills: MarkedStill[] = [];
    if (tier1) {
      const { scan, withMeasurements } = tier1;
      meta.tier1_screen = scan.flagged ? "flagged" : "cleared";
      if (withMeasurements) {
        meta.tier1_measure = {
          gate_opened: scan.flagged,
          opened_at_s: scan.openedAtMs == null ? null : Math.round(scan.openedAtMs / 100) / 10,
          peak_score: scan.peakScore,
          ...scan.measured,
          close_ups: scan.closeUps.map(({ label, t_s, moment }) => ({ label, t_s, moment })),
        };
        for (const shot of scan.closeUps) handStills.push({ label: shot.label as MarkedStill["label"], blob: shot.blob });
      }
    }

    // 1. Item-pile inventory: one image-only Gemini call, running while the clip is optimised.
    const pileZone = isCheckout ? zonesToSend.find((z) => z.kind === "pickup") : undefined;
    let pile: PileViews | null = null;
    if (pileZone && clipUrl) {
      pile = await pileViews(clipUrl, pileZone).catch(() => null);
    }
    setInventory(pile ? { ...INVENTORY_OFF, status: "listing" } : INVENTORY_OFF);
    inventoryUsageRef.current = null;
    if (pile) {
      api
        .inventory(camera.id, pile.views)
        .then((res) => {
          inventoryUsageRef.current = res.usage;
          if (inventoryRef.current.status === "listing") {
            setInventory({ ...INVENTORY_OFF, status: "ready", items: res.items, model: res.model });
          }
        })
        .catch(() => inventoryRef.current.status === "listing" && setInventory({ ...INVENTORY_OFF, status: "failed" }));
    }

    // 2. Stills (from the full-resolution original) and the upload-size optimisation run side by side.
    setSteps([{ label: sendZones ? "Preparing stills with the marked zones" : "Preparing stills", done: false }]);
    // Crop the uploaded video to the marked zones (+30% margin) and draw the zone outlines into it.
    const crop = actionCrop(zonesToSend);
    const [baseStills, shrunk] = await Promise.all([
      // Some codecs can't be seeked in the browser; the clip alone still works.
      clipUrl
        ? markedStills(clipUrl, zonesToSend, { skipPickup: Boolean(pile) }).catch((): MarkedStill[] => [])
        : Promise.resolve<MarkedStill[]>([]),
      shrinkClip(clip, (f) => relabel(`${crop ? "Focusing the clip on the counter" : "Optimising the clip for upload"} · ${Math.round(f * 100)}%`), {
        crop,
        zones: zonesToSend,
      }),
    ]);
    const upload = shrunk.blob;
    if (shrunk.crop) meta.video_crop = rectToBox(shrunk.crop);
    const stills = [...baseStills, ...handStills];

    // 3. Use the confirmed list: numbered boxes on the pile close-up, and the list itself for Gemini to track.
    if (pile) {
      if (inventoryRef.current.status === "listing") advance("Waiting for the item list");
      let listed: InventoryState;
      try {
        listed = await awaitInventory(controller.signal, Date.now());
      } catch {
        setRunning(false);
        return;
      }
      if (listed.status === "ready" && listed.items.length) {
        setInventory({ ...listed, status: "used" });
        stills.push({ label: "pickup_start", blob: await numberedPile(pile.base, listed.items) });
        meta.inventory = listed.items.map((i) => ({ description: i.description, box_2d: i.box_2d ?? [] }));
        if (inventoryUsageRef.current) meta.inventory_usage = inventoryUsageRef.current;
      } else {
        stills.push({ label: "pickup_start", blob: await canvasToJpeg(pile.base) });
      }
    }

    // 4. Scanner reference photo: this clip's (optionally saved for the camera), else the camera's saved one.
    if (isCheckout && scannerPhoto.photo) {
      stills.push({ label: "scanner_ref", blob: scannerPhoto.photo });
      if (scannerPhoto.saveForCamera) {
        advance("Saving the scanner photo for this camera");
        try {
          const saved = await api.saveScannerPhoto(camera.id, scannerPhoto.photo);
          setSavedPhotos((prev) => ({ ...prev, [camera.id]: saved.updated_at }));
        } catch {
          /* still used for this clip; saving can be retried next time */
        }
      }
    } else if (isCheckout && !scannerPhoto.useSaved) {
      meta.scanner_photo = "none";
    }

    const sizeNote = upload.size < clip.size ? `${mb(upload.size)} MB, was ${mb(clip.size)} MB` : `${mb(upload.size)} MB`;
    advance(`Uploading the clip (${sizeNote}) · 0%`);
    try {
      await investigateStream(
        upload,
        meta,
        (event) => {
          if (event.type === "progress") {
            setSteps((prev) => [...prev.map((s) => ({ ...s, done: true })), { label: event.label, done: false }]);
          } else if (event.type === "result") {
            setSteps((prev) => prev.map((s) => ({ ...s, done: true })));
            setResult({ incident: event.incident, cached: event.cached });
            if (meta.demo_clip) setSavedDemo(meta.demo_clip);
            // The original file (Gemini's boxes are mapped back to the full picture, so they line up with it).
            setKeptUntil(null);
            if (keepClipsOn()) {
              void saveLocalClip(event.incident.id, clip, camera.id, "investigate").then((at) =>
                setKeptUntil(at ?? "failed"),
              );
            }
          } else {
            setError(event.message);
          }
        },
        controller.signal,
        stills,
        (f) =>
          relabel(
            f < 1
              ? `Uploading the clip (${sizeNote}) · ${Math.round(f * 100)}%`
              : `Upload complete (${sizeNote}) · starting the investigation`,
          ),
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const reset = () => {
    setResult(null);
    setSavedDemo(null);
    setDemoClip(null);
    setSaveAsDemo(false);
    setKeptUntil(null);
    setScreened(null);
    setScreenNote(null);
    setSteps([]);
    setError(null);
    setClip(null);
    setClipUrl(null);
    setFrame(null);
    setInventory(INVENTORY_OFF);
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
          {savedDemo && (
            <Link href="/settings?section=demo" className="chip tone-accent">
              Stored as the result of demo clip {savedDemo.split("/").pop()}
            </Link>
          )}
          {typeof keptUntil === "number" && (
            <span className="chip" title="Only in this browser, for replay on the incident page and in Playback">
              Clip kept on this device until{" "}
              {new Date(keptUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
          {keptUntil === "failed" && (
            <span className="chip" title="The browser refused to store it, as some private windows do">
              Couldn’t keep a copy on this device
            </span>
          )}
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
      {demoNote && <p className="hint">{demoNote}</p>}
      {demoClip && (
        <p className="card small" style={{ margin: "0 0 1rem" }}>
          <strong>Analysing demo clip {demoClip.name}.</strong> Its saved camera type, zones and receipt are filled in;
          check them, then investigate. The result {demoClip.result ? "replaces the stored one" : "becomes its stored result"}{" "}
          for demo mode.
        </p>
      )}

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
                  <label htmlFor="clip-file">Video file (MP4, WebM or MOV, up to 25 MB, ideally 5–20 s)</label>
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

            {clip && clipUrl && camera && zoneState && (
              <section className="card stack" aria-labelledby="step-zones">
                <h2 id="step-zones">
                  3 · {isCheckout ? "Where are the items, the scanner and the bagging area?" : "Where are the zones?"}
                </h2>
                <p className="muted small" style={{ margin: 0 }}>
                  Works from any camera angle: mark where things are in <em>this</em> picture, or let Gemini suggest it.
                  The zones are drawn on the stills Gemini sees.
                </p>
                <ZoneMarker camera={camera} clipUrl={clipUrl} frame={frame} frameError={frameError} state={zoneState} onChange={setZoneState} />
                {isCheckout && (
                  <ScannerPhoto
                    cameraId={camera.id}
                    savedAt={savedPhotos[camera.id] ?? null}
                    state={scannerPhoto}
                    onChange={setScannerPhoto}
                    onSavedChange={(savedAt) =>
                      setSavedPhotos((prev) => {
                        const next = { ...prev };
                        if (savedAt) next[camera.id] = savedAt;
                        else delete next[camera.id];
                        return next;
                      })
                    }
                  />
                )}
              </section>
            )}

            {isCheckout && (
              <section className="card stack" aria-labelledby="step3">
                <h2 id="step3">{clip ? "4" : "3"} · What did the till scan?</h2>
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
            <h2 id="run-title">{(isCheckout ? 4 : 3) + (clip ? 1 : 0)} · Investigate</h2>
            <label className="row" style={{ alignItems: "flex-start", fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={screenOn}
                onChange={(e) => toggleScreen(e.target.checked)}
                style={{ marginTop: 4 }}
              />
              <span className="small">
                <strong>Screen with Tier-1 first</strong> (on this device, free). Shows what this camera’s Tier-1 gate
                decides and measures; you then choose to send the clip to Gemini.
              </span>
            </label>
            {demoUploads && !demoClip && (
              <label className="row" style={{ alignItems: "flex-start", fontWeight: 400 }}>
                <input type="checkbox" checked={saveAsDemo} onChange={(e) => setSaveAsDemo(e.target.checked)} style={{ marginTop: 4 }} />
                <span className="small">
                  <strong>Save as a demo clip for the Monitor</strong>. The original file, these zones and the receipt are
                  kept in demo storage, and this result becomes its stored result for demo mode.
                </span>
              </label>
            )}
            {saveAsDemo && !demoClip && (
              <div className="field">
                <label htmlFor="demo-expected">Expected verdict (optional, shown as a check in Settings)</label>
                <select id="demo-expected" value={expected} onChange={(e) => setExpected(e.target.value as VerdictKind | "")}>
                  <option value="">Not set</option>
                  {VERDICTS.map((v) => (
                    <option key={v} value={v}>
                      {VERDICT_LABEL[v]}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <label className="row" style={{ alignItems: "flex-start", fontWeight: 400 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 4 }} />
              <span className="small">
                Everyone in this clip agreed to be recorded (for example, it’s you). The clip is analysed by Gemini and not
                stored; only the report is kept.
              </span>
            </label>
            <button
              type="button"
              className={screened ? "btn" : "btn btn-primary"}
              disabled={!canRun}
              onClick={() => (screenOn ? screen() : run())}
            >
              {running ? "Working…" : screenOn ? (screened ? "Run Tier-1 again" : "Run Tier-1 on this device") : "Investigate with Gemini"}
            </button>
            {!clip && <span className="hint">Add a clip to start.</span>}
            {clip && !receiptReady && <span className="hint">Add at least one scanned item.</span>}
            {clip && receiptReady && !consent && <span className="hint">Tick the consent box to continue.</span>}
            {steps.length > 0 && <ProgressSteps steps={steps} running={running} />}
            {screened && !running && (
              <Tier1ScreenCard
                result={screened}
                gate={gate}
                receiptLines={receiptLines}
                canSend={canRun}
                onSend={(withMeasurements) => run({ tier1: { scan: screened, withMeasurements } })}
              />
            )}
            {screenNote && <p className="hint" style={{ margin: 0 }}>{screenNote}</p>}
            <InventoryConfirm state={inventory} onChange={setInventory} />
            {error && (
              <ErrorNotice onRetry={canRun ? () => run() : undefined}>{error}</ErrorNotice>
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
