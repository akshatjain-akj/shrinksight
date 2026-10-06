"""Investigate's Tier-1 measurements: how Gemini sees them, and the safety rule that checks its verdict against them.

The browser measures what the shopper's hands did (times and places, no conclusions). Gemini gets them only as places
to look; the conclusions stay Gemini's. If Gemini clears a clip that the measurements say needs a look, a person looks.
"""

from __future__ import annotations

from .models import ReceiptLine, Tier1Measure, VerdictOut

SPOT_TEXT = {
    "pocket": "at pocket height by the hip",
    "bag": "out at the side at bag height",
    "shirt": "at the centre of the torso",
    "waistband": "at the waistband",
}
MOMENT_TEXT = {
    "shelf_exit": "just after leaving the shelf zone",
    "hold": "resting on the body",
    "bagging": "reaching the bagging area",
}
# A hand resting on the body this long right after a shelf visit is worth a person's look if Gemini saw nothing.
HOLD_REVIEW_S = 1.2


def clip_time(seconds: float) -> str:
    minutes, rest = divmod(max(0.0, seconds), 60)
    return f"{int(minutes):02d}:{rest:04.1f}"


def measure_text(measure: Tier1Measure) -> str:
    """The measurements as a neutral block for Gemini's prompt."""
    lines = [
        "On-device Tier-1 measurements of the main shopper's hands. These come from a pose tracker, not a judgement: "
        "it can miss or mistime movements and it cannot see what a hand holds. Use them only as moments to look at "
        "closely. Decide from the clip itself, and if a measurement disagrees with the video, trust the video."
    ]
    for contact in measure.shelf_contacts:
        lines.append(f"- {contact.hand.capitalize()} hand in the shelf zone "
                     f"{clip_time(contact.start_s)}–{clip_time(contact.end_s)}")
    for hold in measure.holds:
        lines.append(f"- {hold.hand.capitalize()} hand left the shelf at {clip_time(hold.after_shelf_s)}, then rested "
                     f"{SPOT_TEXT[hold.spot]} {clip_time(hold.start_s)}–{clip_time(hold.end_s)} "
                     f"({hold.end_s - hold.start_s:.1f} s)")
    if measure.trips is not None:
        if measure.trips:
            trips = "; ".join(
                f"{clip_time(t.start_s)}→{clip_time(t.end_s)} "
                f"{'through the scanner zone' if t.via_scanner else 'NOT through the scanner zone'}"
                for t in measure.trips
            )
            lines.append(f"- {len(measure.trips)} hand trip(s) from the item pile to the bagging area: {trips}. "
                         "Two items carried together count as one trip, and a trip the tracker missed isn't listed. "
                         "Account for every trip: which item it carried and whether that item is on the receipt.")
        else:
            lines.append("- No hand trips from the item pile to the bagging area were measured (the tracker may "
                         "have missed them).")
    if len(lines) == 1:
        lines.append("- No shelf contact, hand rest or trip was measured.")
    return "\n".join(lines)


def close_up_text(measure: Tier1Measure | None) -> dict[str, str]:
    """Captions for the Tier-1 close-ups (hand_1…, trip_1…) that came with the clip."""
    if measure is None:
        return {}
    texts = {}
    for ref in measure.close_ups:
        what = MOMENT_TEXT[ref.moment]
        if ref.moment == "bagging":
            texts[ref.label] = f"Close-up: the hands at {clip_time(ref.t_s)}, trip {ref.label.split('_')[1]} {what}"
        else:
            texts[ref.label] = f"Close-up: the hands at {clip_time(ref.t_s)}, {what} (Tier-1 moment)"
    return texts


def apply_tier1_rule(
    verdict: VerdictOut, measure: Tier1Measure | None, receipt: list[ReceiptLine]
) -> tuple[VerdictOut, str | None]:
    """Gemini can't clear a clip the measurements say needs a look: BENIGN -> INCONCLUSIVE (a person reviews).

    - Checkout: more hand trips from the pile to the bag than receipt lines.
    - Floor: a hand rested on the body for HOLD_REVIEW_S or longer right after a shelf visit.
    """
    if measure is None or verdict.verdict != "BENIGN":
        return verdict, None
    note = None
    if measure.trips is not None and receipt and len(measure.trips) > len(receipt):
        note = (f"Tier-1 check: the tracker measured {len(measure.trips)} hand trips from the item pile to the bagging "
                f"area but the receipt has {len(receipt)} lines. Gemini said BENIGN, so a person should look.")
    else:
        long_hold = next((h for h in measure.holds if h.end_s - h.start_s >= HOLD_REVIEW_S), None)
        if long_hold is not None:
            note = (f"Tier-1 check: the {long_hold.hand} hand left the shelf at {clip_time(long_hold.after_shelf_s)} "
                    f"and rested {SPOT_TEXT[long_hold.spot]} for {long_hold.end_s - long_hold.start_s:.1f} s. "
                    "Gemini said BENIGN, so a person should look.")
    if note is None:
        return verdict, None
    return verdict.model_copy(update={"verdict": "INCONCLUSIVE", "reason": f"{note} {verdict.reason}"}), note
