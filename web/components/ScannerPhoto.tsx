"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { scannerPhotoJpeg } from "@/lib/frames";

export interface ScannerPhotoState {
  /** A photo picked for this clip (already resized), or null. */
  photo: Blob | null;
  /** Also save it as the camera's scanner photo, so later clips and the Live edge use it. */
  saveForCamera: boolean;
  /** Use the camera's saved photo when this clip has none. */
  useSaved: boolean;
}

export const SCANNER_PHOTO_NONE: ScannerPhotoState = { photo: null, saveForCamera: true, useSaved: true };

/**
 * Optional reference photo of the scanning device. Saved once per camera and reused automatically, or uploaded for
 * one clip. Gemini then only counts a scan when an item passes over THIS device (not paper, a phone or the counter).
 */
export default function ScannerPhoto({ cameraId, savedAt, state, onChange, onSavedChange }: {
  cameraId: string;
  /** When the camera's saved photo was stored, or null if it has none. */
  savedAt: string | null;
  state: ScannerPhotoState;
  onChange: (next: ScannerPhotoState) => void;
  onSavedChange: (savedAt: string | null) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!state.photo) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(state.photo);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [state.photo]);

  const pick = async (file: File) => {
    setError(null);
    try {
      const photo = await scannerPhotoJpeg(file);
      onChange({ ...state, photo, saveForCamera: state.saveForCamera || !savedAt });
    } catch {
      setError("Couldn’t read that image. Try a JPEG or PNG photo.");
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteScannerPhoto(cameraId);
      onSavedChange(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div>
        <strong>Scanner reference photo</strong> <span className="muted small">(optional)</span>
        <p className="muted small" style={{ margin: "0.2rem 0 0" }}>
          A photo of this checkout’s scanning device, even a rough phone shot. Gemini then only counts a scan when an
          item passes over this device, not over paper, a phone or the counter.
        </p>
      </div>

      {state.photo && preview ? (
        <div className="scanner-photo">
          <img src={preview} alt="Scanner photo for this clip" />
          <div className="stack" style={{ gap: "0.3rem" }}>
            <span className="small">Using this photo for this clip.</span>
            <label className="row small" style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={state.saveForCamera}
                onChange={(e) => onChange({ ...state, saveForCamera: e.target.checked })}
              />
              Save as this camera’s scanner photo
            </label>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...state, photo: null })}>
              Don’t use it
            </button>
          </div>
        </div>
      ) : savedAt ? (
        <div className="scanner-photo">
          <img src={api.scannerPhotoUrl(cameraId, savedAt)} alt="This camera's saved scanner photo" />
          <div className="stack" style={{ gap: "0.3rem" }}>
            <label className="row small" style={{ fontWeight: 400 }}>
              <input
                type="checkbox"
                checked={state.useSaved}
                onChange={(e) => onChange({ ...state, useSaved: e.target.checked })}
              />
              Use this camera’s saved scanner photo
            </label>
            <div className="row">
              <label className="btn btn-sm">
                Replace for this clip
                <input className="visually-hidden" type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
              </label>
              <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={remove}>
                Remove saved photo
              </button>
            </div>
          </div>
        </div>
      ) : (
        <label className="btn btn-sm" style={{ alignSelf: "flex-start" }}>
          Add a scanner photo
          <input className="visually-hidden" type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
        </label>
      )}
      {error && <span className="small" style={{ color: "var(--danger)" }}>{error}</span>}
    </div>
  );
}
