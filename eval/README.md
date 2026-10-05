# Evaluation harness

Measures how well the Gemini investigator does on labelled clips, so accuracy claims in the README, deck and
video are real numbers.

## 1. Label the clips
Edit `manifest.json`. One entry per video file:

| Field | Meaning |
|---|---|
| `file` | File name inside the clips folder (videos are never committed) |
| `camera_id` | e.g. `cam-sco-1` (self-checkout) or `cam-aisle-4` (shop floor) |
| `angle`, `lighting` | Free text tags, e.g. `top`, `left`, `front`; `normal`, `dim`. Results are broken down by these |
| `receipt` | What the till actually scanned. Prices can be `0` |
| `expected.verdict` | `BENIGN` if everything was paid for, `SCAN_AVOIDANCE` / `CONCEALMENT` otherwise |
| `expected.unscanned` | Items handled but **not** on the receipt |
| `seconds` (optional) | Clip length; clips over 10 s are sampled at 3 fps, as on the website |
| `zones` (optional) | Where the scanner/bagging areas are in this clip. On the Investigate page, mark them and click **Copy zones for eval**, then paste here |

Entries containing `FILL_ME` are skipped until you fill them in.

## 2. Run
```bash
cd api
uv run python ../eval/run.py --clips ../Clips --tag v2                          # default model
uv run python ../eval/run.py --clips ../Clips --tag v2 --model gemini-3.5-flash --sleep 45
uv run python ../eval/run.py --clips ../Clips --only clip2.mp4 clip3.mp4         # a subset
```
Uses your key from `api/.env`, an in-memory store (nothing touches production) and your own free-tier quota.
Each clip costs about 2–3 Gemini requests: keep `--sleep` at ~15 s for Flash Lite and ~45 s for Flash.

## 3. Read the results
Each run writes `results/<time>-<tag>-<model>.json` and `.md` and prints the table:
- **Verdict accuracy:** flagged vs. benign was right (INCONCLUSIVE never counts as right)
- **Exact count:** the number of unscanned items matched exactly
- **Precision / recall:** of the clips we flagged, how many were real / of the real ones, how many we caught
- **False alarm rate:** benign clips that were wrongly flagged (what staff fatigue is about)
- **Latency:** median and p95 seconds per investigation

Commit the `.md` files you want to quote in the deck.
