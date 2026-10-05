"""Runs labelled clips through the real investigator and scores the results.

Usage (from the repo root, with your Gemini key in api/.env or the environment):

    cd api && uv run python ../eval/run.py --clips ../Clips --model gemini-3.5-flash-lite --tag v2

Writes eval/results/<timestamp>-<tag>-<model>.json and .md and prints the markdown table.
Uses an in-memory store (no Firestore) and your own free-tier quota. Each clip costs about 2-3 Gemini requests,
so keep --sleep high enough for the model's per-minute limit (Flash Lite ~15/min, Flash ~5/min).
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))

from app.config import Settings  # noqa: E402
from app.evaluation import ClipResult, summarise, to_markdown  # noqa: E402
from app.gemini import GeminiGateway, GeminiUnavailable  # noqa: E402
from app.investigator import investigate  # noqa: E402
from app.models import InventoryItem, ReceiptLine, Transaction, ZoneHint  # noqa: E402
from app.repo import MemoryRepo  # noqa: E402

MIME = {".mp4": "video/mp4", ".mov": "video/mov", ".webm": "video/webm", ".3gp": "video/3gpp"}
PLACEHOLDER = "FILL_ME"


def load_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    env_file = ROOT / "api" / ".env"
    if not key and env_file.is_file():
        for line in env_file.read_text().splitlines():
            if line.strip().startswith("GEMINI_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        sys.exit("No GEMINI_API_KEY found (set it in api/.env or the environment).")
    return key


def needs_filling(entry: dict) -> bool:
    return PLACEHOLDER in json.dumps(entry)


def run_clip(entry: dict, clips_dir: Path, repo: MemoryRepo, gateway, settings: Settings) -> ClipResult:
    expected = entry["expected"]
    result = ClipResult(
        file=entry["file"],
        angle=entry.get("angle", "unknown"),
        lighting=entry.get("lighting", "normal"),
        model=settings.investigator_model,
        expected_verdict=expected["verdict"],
        expected_unscanned=len(expected.get("unscanned", [])),
    )
    path = clips_dir / entry["file"]
    if not path.is_file():
        result.error = "file not found"
        return result
    mime = MIME.get(path.suffix.lower())
    clip = path.read_bytes()
    if mime is None:
        result.error = f"unsupported type {path.suffix}"
        return result
    if len(clip) > settings.max_clip_bytes:
        result.error = f"too large ({len(clip) / 1024 / 1024:.1f} MB > {settings.max_clip_bytes // (1024 * 1024)} MB)"
        return result

    camera = next(c for c in repo.cameras() if c.id == entry["camera_id"])
    transaction = None
    if entry.get("receipt") is not None and camera.kind == "checkout":
        transaction = Transaction(
            id=f"TXN-EVAL-{path.stem}", lane_id=camera.lane_id or "", started_at="2026-10-05T00:00:00Z",
            lines=[ReceiptLine(**line) for line in entry["receipt"]], source="live",
        )
    zones = [ZoneHint(**zone) for zone in entry.get("zones", [])]
    # Optional fixed item list (as if confirmed in the browser): tests tracking separately from discovery.
    confirmed = [InventoryItem(description=name) for name in entry.get("inventory", [])] or None

    started = time.monotonic()
    events = list(investigate(clip, mime, camera, transaction, repo, gateway, settings, zones=zones,
                              clip_seconds=entry.get("seconds"), inventory=confirmed))
    result.latency_ms = round((time.monotonic() - started) * 1000)
    final = events[-1] if events else {"type": "error", "message": "no events"}
    if final["type"] == "error":
        result.error = final["message"][:80]
        return result
    verdict = final["incident"]["verdict"]
    result.answered_by = final["incident"].get("model")
    result.timings = final["incident"].get("timings", {})
    result.tokens = (final["incident"].get("usage") or {}).get("total")
    result.predicted_verdict = verdict["verdict"]
    result.predicted_unscanned = verdict["items_seen"] - verdict["items_scanned"]
    result.predicted_items = [
        f"{item['description']} ({'scanned' if item['scanned'] else 'NOT scanned'})" for item in verdict["seen_items"]
    ]
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--clips", type=Path, default=ROOT / "Clips", help="folder with the video files")
    parser.add_argument("--manifest", type=Path, default=ROOT / "eval" / "manifest.json")
    parser.add_argument("--model", default=None, help="Gemini model id (default: GEMINI_INVESTIGATOR_MODEL)")
    parser.add_argument("--tag", default="run", help="label for this run, e.g. v2 or top-angle")
    parser.add_argument("--only", nargs="*", default=None, help="run only these clip file names")
    parser.add_argument("--sleep", type=float, default=15, help="seconds between clips (rate limits)")
    parser.add_argument("--repeat", type=int, default=1, help="run each clip N times to measure stability")
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text())
    entries = [e for e in manifest["clips"] if not args.only or e["file"] in args.only]
    key = load_key()
    base = Settings()
    settings = Settings(gemini_api_key=key, investigator_model=args.model or base.investigator_model)
    gateway = GeminiGateway(key, settings.gemini_timeout_ms, settings.gemini_max_retries)
    results: list[ClipResult] = []
    runnable = [e for e in entries if not needs_filling(e)]
    for e in entries:
        if needs_filling(e):
            print(f"skip {e['file']}: replace {PLACEHOLDER} in the manifest first")
    jobs = [(run_no, entry) for run_no in range(1, max(1, args.repeat) + 1) for entry in runnable]
    for index, (run_no, entry) in enumerate(jobs):
        if index:
            time.sleep(args.sleep)
        # A fresh in-memory store per run, so repeats really call Gemini instead of hitting the cache.
        repo = MemoryRepo()
        print(f"[{index + 1}/{len(jobs)}] run {run_no} · {entry['file']} ({entry.get('angle', '?')}) …", flush=True)
        try:
            result = run_clip(entry, args.clips, repo, gateway, settings)
            result.run = run_no
        except GeminiUnavailable as exc:
            result = ClipResult(file=entry["file"], angle=entry.get("angle", "unknown"),
                                lighting=entry.get("lighting", "normal"), model=settings.investigator_model,
                                expected_verdict=entry["expected"]["verdict"],
                                expected_unscanned=len(entry["expected"].get("unscanned", [])), error=str(exc)[:80],
                                run=run_no)
        results.append(result)
        status = result.error or f"{result.predicted_verdict}, {result.predicted_unscanned} unscanned"
        print(f"    → {status}")

    if not results:
        sys.exit("Nothing was run.")
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    out_dir = ROOT / "eval" / "results"
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = out_dir / f"{stamp}-{args.tag}-{settings.investigator_model}"
    title = f"ShrinkSight eval · {args.tag} · {settings.investigator_model} · {stamp}"
    markdown = to_markdown(results, title)
    stem.with_suffix(".json").write_text(json.dumps(
        {"title": title, "summary": summarise(results), "results": [r.to_dict() for r in results]}, indent=2
    ))
    stem.with_suffix(".md").write_text(markdown)
    print("\n" + markdown)
    print(f"Saved {stem}.json and .md")


if __name__ == "__main__":
    main()
