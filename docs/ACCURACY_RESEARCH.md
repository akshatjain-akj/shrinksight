# Accuracy research: what we adopted and why

Summary of the research note *"Enhancing LossLens Detection Accuracy Using Google…"* (the `.docx` in this folder,
written when the product was still called LossLens), checked against the ShrinkSight code. Every adopted change is
measured with the evaluation harness (`eval/run.py --repeat 3`) before and after.

## Adopted

| Recommendation | Where it lives | Why |
|---|---|---|
| **Crop the uploaded video to the action area** (marked zones + 30% margin) before encoding | `web/lib/transcode.ts`, `web/lib/tier1/zones.ts` (`actionCrop`), `api/app/zones.py` (`to_crop` / `from_crop`) | Items get ~3× more pixels in every frame Gemini watches, at no speed or quota cost. Zone boxes are given to Gemini in crop coordinates and item boxes are mapped back to the full view for the evidence overlay. |
| **Zone outlines burned into the video** | `web/lib/transcode.ts` | Same labelled outlines as the stills and Live edge, so the video itself shows where the scanner is |
| **Chain of custody per item** (picked up, at scanner, ended) | `api/app/models.py` (`SeenItem`), prompt in `api/app/investigator.py`, incident timeline | Conclusions are anchored in observed moments; reviewers see a per-item timeline |
| **Object provenance + benign look-alikes** (phone back into pocket, rescan after failed read, pulling bags apart) | `SYSTEM_PROMPT` in `api/app/investigator.py` | Fewer false alarms on personal items and normal checkout gestures (text form; image examples deferred) |
| **MediaPipe confidence tuning**: pose detection/presence 0.6, tracking 0.65; objects 0.45 / max 5 | `web/lib/tier1/vision.ts` | Fewer ghost detections and earlier re-detection during fast hand movement (Live edge, Monitor, Playback) |
| **One Euro filter** on pose landmarks (f_min = 1 Hz, β = 0.007) | `web/lib/tier1/oneEuro.ts`, used in Live edge and the Monitor/Playback scans | Removes jitter when still without lagging fast reaches; privacy blur keeps the raw landmarks |
| Pose **Full** model, structured JSON with boxes, temperature 0, SHA-256 verdict cache, backoff, lighter backup models | already in place | — |

## Already covered differently (or more strongly)

| Recommendation | What ShrinkSight does instead |
|---|---|
| Kinematic reach/dwell rules | The Tier-1 engine already tracks reach → hold phases with a minimum hold time per sensitivity |
| SWEETHEARTING category | Any method (bypass, covered barcode, item under another) is caught by the **receipt check**: an item that isn't on the receipt and ended in the bag is flagged |
| Gemini tool calls to the POS during the investigation | The server fetches the receipt up front (one Gemini call instead of several); the **Ask about this incident** agent does real tool calling |

## Deferred

| Recommendation | Why later |
|---|---|
| Multimodal few-shot **image** examples | Needs our own staged frames (no third-party images) and adds tokens to every call; the text version is in place |
| Hand-trajectory "breadcrumbs" drawn into the video | Requires running pose detection during the shrink step; lower value than cropping |
| Cross-checking Gemini's boxes against Tier-1 tracks | Little accuracy gain for the self-checkout flow |

## Not adopted

| Recommendation | Reason |
|---|---|
| 1 frame-per-second sampling | Too slow for sub-second scans (the note itself says a sweep takes < 600 ms). We sample 5 fps (3 fps above 10 s). |
| Quota figures in the note (e.g. 1,500 requests/day for Flash) | Don't match our key: Flash has 20/day, Flash Lite 500/day. Our design uses Flash Lite plus a separate inventory model. |
| Quoted gains ("24% less drift", "65% fewer tokens") | Not measured by us; we only quote numbers from our own eval |
