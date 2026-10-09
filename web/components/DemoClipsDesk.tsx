"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "@/lib/api";
import { useDemoClips } from "@/lib/demoMode";
import { VERDICT_LABEL } from "@/lib/format";
import { useStore } from "@/lib/hooks";
import type { Camera, DemoClip } from "@/lib/types";
import { ErrorNotice, Skeletons } from "./ui";

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * Settings → Demo clips: the clips cameras play in demo mode, each analysed once by Gemini (through Investigate) and
 * replayed from that stored result. Which camera plays which clip can be changed here.
 */
export default function DemoClipsDesk() {
  const { store, reload: reloadStore } = useStore();
  const { clips, uploads, error, reload } = useDemoClips(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const cameraName = (id: string) => store?.cameras.find((c) => c.id === id)?.name ?? id;

  const remove = async (clip: DemoClip) => {
    if (!window.confirm(`Delete ${clip.name}, its settings and its Gemini result? Cameras playing it get another clip.`)) return;
    setBusy(clip.object);
    setProblem(null);
    try {
      await api.deleteDemoClip(clip.object);
      reload();
      reloadStore();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const choose = async (camera: Camera, object: string) => {
    setBusy(camera.id);
    setProblem(null);
    try {
      await api.setCameraDemoClip(camera.id, object || null);
      reload();
      reloadStore();
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card stack" aria-labelledby="demo-clips-title">
      <h2 id="demo-clips-title" style={{ margin: 0 }}>
        Demo clips
      </h2>
      <p className="muted small" style={{ margin: 0 }}>
        In demo mode (toggle on the Monitor) each camera loops one of these clips. Each clip is analysed once by Gemini;
        the Monitor, Playback and the incident page replay that stored result, so looping costs no Gemini calls.
      </p>
      <details className="small">
        <summary>How to add clips</summary>
        <ul>
          <li>
            On <Link href="/investigate">Investigate</Link>: choose the clip and camera, mark the zones, enter the
            receipt, tick <strong>Save as a demo clip for the Monitor</strong>, then Investigate.
          </li>
          <li>
            Or upload to <code>gs://shrinksight-app-evidence/demo/checkout/</code> or <code>…/demo/floor/</code> (Cloud
            console or terminal), with an optional <code>&lt;clip&gt;.json</code> next to it holding{" "}
            <code>receipt</code>, <code>zones</code> and <code>expected</code>. Then click Analyse below.
          </li>
          <li>Your own or consented footage only, about 8–20 s, under 25 MB.</li>
        </ul>
      </details>
      {!uploads && clips && (
        <p className="hint" style={{ margin: 0 }}>
          Adding and deleting demo clips isn’t available for this account right now. Analysing still works.
        </p>
      )}
      {(error || problem) && <ErrorNotice>{problem ?? error}</ErrorNotice>}
      {!clips && !error && <Skeletons count={2} />}
      {clips && clips.length === 0 && <p className="muted">No demo clips yet.</p>}
      {clips && clips.length > 0 && (
        <div className="table-wrap">
          <table className="compare">
            <thead>
              <tr>
                <th>Clip</th>
                <th>Cameras</th>
                <th>Gemini result</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {clips.map((clip) => (
                <tr key={clip.object}>
                  <td>
                    <strong>{clip.name}</strong>
                    <br />
                    <span className="muted small">
                      {clip.kind === "checkout" ? "Checkout" : "Shop floor"} · {mb(clip.size)}
                      {clip.kind === "checkout" && ` · receipt ${clip.receipt.length} line${clip.receipt.length === 1 ? "" : "s"}`}
                      {clip.expected && ` · expected ${VERDICT_LABEL[clip.expected] ?? clip.expected}`}
                    </span>
                  </td>
                  <td className="small">{clip.cameras.length ? clip.cameras.map(cameraName).join(", ") : "—"}</td>
                  <td className="small">
                    {clip.result ? (
                      <>
                        <Link href={`/incident?id=${encodeURIComponent(clip.result.incident_id)}`}>
                          {VERDICT_LABEL[clip.result.verdict]} {Math.round(clip.result.confidence * 100)}%
                        </Link>
                        {clip.matches === true && <span className="demo-ok"> ✓ as expected</span>}
                        {clip.matches === false && <span className="demo-bad"> ✗ not as expected</span>}
                      </>
                    ) : (
                      <span className="muted">Not analysed</span>
                    )}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <Link className="btn btn-sm" href={`/investigate?demo=${encodeURIComponent(clip.object)}`}>
                        {clip.result ? "Re-analyse" : "Analyse"}
                      </Link>
                      {uploads && (
                        <button
                          type="button"
                          className="btn btn-sm btn-ghost"
                          disabled={busy === clip.object}
                          onClick={() => void remove(clip)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {store && clips && clips.length > 0 && (
        <>
          <h3 style={{ margin: "0.5rem 0 0" }}>Which camera plays which clip</h3>
          <div className="stack" style={{ gap: "0.4rem" }}>
            {store.cameras.map((camera) => {
              const options = clips.filter((clip) => clip.kind === camera.kind);
              return (
                <label key={camera.id} className="row small" style={{ fontWeight: 400 }}>
                  <span style={{ minWidth: "12rem" }}>{camera.name}</span>
                  <select
                    value={camera.demo_clip ?? ""}
                    disabled={busy === camera.id || options.length === 0}
                    onChange={(e) => void choose(camera, e.target.value)}
                  >
                    <option value="">{options.length ? "Automatic (least used)" : "No clip of this kind yet"}</option>
                    {options.map((clip) => (
                      <option key={clip.object} value={clip.object}>
                        {clip.name}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
