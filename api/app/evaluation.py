"""Scoring for the evaluation harness (eval/run.py). Pure functions so they can be unit-tested.

A clip is "positive" when the expected verdict flags something (scan avoidance, concealment, rule breach).
INCONCLUSIVE never counts as a catch: on a positive clip it is a miss, on a benign clip it is not a false alarm.
"""

from dataclasses import asdict, dataclass, field
from statistics import median

from .models import POSITIVE_VERDICTS


@dataclass
class ClipResult:
    file: str
    angle: str
    lighting: str
    model: str
    expected_verdict: str
    expected_unscanned: int
    predicted_verdict: str | None = None
    predicted_unscanned: int | None = None
    predicted_items: list[str] = field(default_factory=list)
    latency_ms: int | None = None
    error: str | None = None
    answered_by: str | None = None
    timings: dict[str, int] = field(default_factory=dict)

    @property
    def scored(self) -> bool:
        return self.error is None and self.predicted_verdict is not None

    @property
    def expected_positive(self) -> bool:
        return self.expected_verdict in POSITIVE_VERDICTS

    @property
    def predicted_positive(self) -> bool:
        return self.predicted_verdict in POSITIVE_VERDICTS

    @property
    def verdict_ok(self) -> bool:
        return self.scored and self.predicted_verdict != "INCONCLUSIVE" and (
            self.expected_positive == self.predicted_positive
        )

    @property
    def count_ok(self) -> bool:
        return self.scored and self.predicted_unscanned == self.expected_unscanned

    def to_dict(self) -> dict:
        return {**asdict(self), "verdict_ok": self.verdict_ok, "count_ok": self.count_ok}


def _ratio(num: int, den: int) -> float | None:
    return round(num / den, 3) if den else None


def _p95(values: list[int]) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))]


def summarise(results: list[ClipResult]) -> dict:
    scored = [r for r in results if r.scored]
    tp = sum(1 for r in scored if r.expected_positive and r.predicted_positive)
    fp = sum(1 for r in scored if not r.expected_positive and r.predicted_positive)
    fn = sum(1 for r in scored if r.expected_positive and not r.predicted_positive)
    tn = sum(1 for r in scored if not r.expected_positive and not r.predicted_positive)
    latencies = [r.latency_ms for r in scored if r.latency_ms is not None]
    return {
        "clips": len(results),
        "scored": len(scored),
        "errors": len(results) - len(scored),
        "verdict_accuracy": _ratio(sum(r.verdict_ok for r in scored), len(scored)),
        "exact_count_accuracy": _ratio(sum(r.count_ok for r in scored), len(scored)),
        "precision": _ratio(tp, tp + fp),
        "recall": _ratio(tp, tp + fn),
        "false_alarm_rate": _ratio(fp, fp + tn),
        "inconclusive_rate": _ratio(sum(r.predicted_verdict == "INCONCLUSIVE" for r in scored), len(scored)),
        "latency_ms_median": round(median(latencies)) if latencies else None,
        "latency_ms_p95": _p95(latencies),
    }


def by_group(results: list[ClipResult], attr: str) -> dict[str, dict]:
    groups: dict[str, list[ClipResult]] = {}
    for result in results:
        groups.setdefault(getattr(result, attr) or "unknown", []).append(result)
    return {name: summarise(items) for name, items in sorted(groups.items())}


def _fmt(value) -> str:
    if value is None:
        return "–"
    if isinstance(value, float):
        return f"{value:.0%}" if value <= 1 else f"{value:.1f}"
    return str(value)


def to_markdown(results: list[ClipResult], title: str) -> str:
    summary = summarise(results)
    lines = [
        f"# {title}",
        "",
        "| Clip | Angle | Expected | Got | Unscanned (exp → got) | Verdict | Count | Latency | Model |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        got = r.error or r.predicted_verdict or "–"
        unscanned = f"{r.expected_unscanned} → {_fmt(r.predicted_unscanned)}"
        latency = f"{r.latency_ms / 1000:.1f} s" if r.latency_ms else "–"
        lines.append(
            f"| {r.file} | {r.angle} | {r.expected_verdict} | {got} | {unscanned} | "
            f"{'✅' if r.verdict_ok else '❌'} | {'✅' if r.count_ok else '❌'} | {latency} | {r.answered_by or '–'} |"
        )
    lines += ["", "## Totals", "", "| Metric | Value |", "|---|---|"]
    lines += [f"| {key.replace('_', ' ')} | {_fmt(value)} |" for key, value in summary.items()]
    angles = by_group(results, "angle")
    if len(angles) > 1:
        lines += ["", "## By angle", "", "| Angle | Clips | Verdict accuracy | Exact count | False alarm rate |",
                  "|---|---|---|---|---|"]
        for angle, s in angles.items():
            lines.append(
                f"| {angle} | {s['clips']} | {_fmt(s['verdict_accuracy'])} | {_fmt(s['exact_count_accuracy'])} | "
                f"{_fmt(s['false_alarm_rate'])} |"
            )
    return "\n".join(lines) + "\n"
