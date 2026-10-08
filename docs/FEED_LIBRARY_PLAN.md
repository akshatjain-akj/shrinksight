# Plan (parked): demo feed library

Status: **parked** (8 Oct 2026). Not started. Pick it up after the demo login and on-device clip replay, if time
allows before the 15 Oct freeze.

## Goal
No black camera tiles. Every camera, including ones added later, plays a real clip from a curated library, and
incidents raised from those clips can always be replayed with Gemini's boxes.

## Blocking question: where are the clips from?
We have 100–200 dataset clips. Before any upload:
- **Self-recorded / consented / synthetic:** fine.
- **Public datasets of real store CCTV** (UCF-Crime, Kaggle shoplifting sets, DCSASS, …) usually show real faces and are
  often research / non-commercial only, sometimes cut from YouTube. The rules forbid real PII and third-party
  copyrighted material without rights, and the T&C grant the organiser a publicity licence. Use only if the licence
  allows it, and blur faces before upload.

## Design
1. **Ingest (one-time, run locally):** `api/scripts/build_clip_library.py`
   - Input: a folder split into `checkout/` and `floor/`.
   - Per clip: 720p, no audio, ≤ ~20 s, **faces blurred** (MediaPipe face detection, offline).
   - Upload to `gs://shrinksight-app-evidence/library/{checkout|floor}/…` (no lifecycle rule, unlike `evidence/`).
   - Write one Firestore doc per clip (`clip_library`): kind, seconds, optional label (theft / normal), object name.
   - Budget: ~200 × 2–5 MB ≈ 1 GB, inside the 5 GB free tier (bucket is in us-central1).
2. **Feed per camera:**
   - On `POST /api/cameras`, assign a library clip of the same kind (least-used first). Seed cameras get one too.
   - Stored on the camera, so every login and device sees the same feed.
   - Camera settings → **Change feed** (pick or shuffle). Optional playlist of 3–5 clips per camera.
   - `/api/clips/{camera_id}` signs the camera's feed; signing is allowed only for `seed/` and `library/` objects.
3. **Monitor:** every tile loops its feed. Tier-1 overlay (pose, zones, gate score) runs on the **selected tile only**
   so four tiles stay smooth on a judge's laptop.
4. **Feed → incident:** an **Investigate this clip** button on a tile sends its current clip to Gemini. The incident
   stores `clip_ref` (the library object), so Playback and the incident page can always play it with the time-synced
   boxes. Manual by default; automatic only for the selected tile with a daily cap (free quota).
5. **Bigger evaluation:** if clips are labelled, run 30–50 through `eval/run.py` (with `--sleep`) and record Tier-1
   flagged / cleared for each. Report both in the README.

## Guidance
- Curate **20–40** strong clips (clear angle, 8–20 s, obvious action) rather than loading all 200.
- Still record 3–4 of our own clips for the seeded example incidents.

## Effort
About 1–1.5 days: ingest script, library model and signing, feed assignment (create + seed), Change feed UI, Monitor
changes, `clip_ref` on incidents, tests and docs.

## Open decisions
1. Source and licence of the clips.
2. One feed per camera, or a playlist of 3–5.
3. "Investigate this clip": manual only (recommended), or automatic on the selected tile with a daily cap.
