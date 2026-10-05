"""Receipt-first reconciliation for self-checkout verdicts.

Gemini lists every item it saw and, for each, the receipt line it matches (or none). The server then
decides "scanned" deterministically: an item is scanned if and only if it matched a receipt line.
This does not depend on seeing the scan gesture, so it holds up across camera angles.

Problems are split into:
- hard: the answer contradicts the receipt (e.g. nothing matched a 5-line receipt). After one re-ask,
  a remaining hard problem turns the verdict into INCONCLUSIVE rather than a false alarm.
- soft: suspicious but possible (e.g. fewer items listed than receipt lines, an occlusion). Worth one
  re-ask, then accepted.
"""

from .models import ReceiptLine, VerdictOut


def reconcile(verdict: VerdictOut, receipt: list[ReceiptLine]) -> tuple[VerdictOut, list[str], list[str]]:
    if not receipt:
        return verdict, [], []

    out = verdict.model_copy(deep=True)
    hard: list[str] = []
    soft: list[str] = []
    used: set[int] = set()

    for item in out.seen_items:
        line = item.receipt_line
        if line is not None and not 1 <= line <= len(receipt):
            soft.append(f"'{item.description}' points at receipt line {line}; the receipt has {len(receipt)} lines.")
            line = None
        if line is not None and line in used:
            hard.append(f"Receipt line {line} ({receipt[line - 1].name}) was matched to more than one item.")
            line = None
        if line is not None:
            used.add(line)
        item.receipt_line = line
        item.scanned = line is not None

    out.items_seen = len(out.seen_items)
    out.items_scanned = sum(1 for item in out.seen_items if item.scanned)
    unscanned = out.items_seen - out.items_scanned

    if out.items_seen and out.items_scanned == 0:
        hard.append(
            f"None of the {out.items_seen} items you listed were matched to any of the {len(receipt)} receipt lines. "
            "Match items to receipt lines by what they look like; the receipt is what was actually scanned."
        )
    if out.items_seen < len(receipt):
        soft.append(
            f"You listed {out.items_seen} items but the receipt has {len(receipt)} lines. Every receipt line was "
            f"scanned, so at least {len(receipt)} items were handled. Look again for items you missed."
        )
    # Name exactly which scanned items were never found: a targeted look beats "look again".
    for number, line in enumerate(receipt, start=1):
        if number not in used and out.items_seen:
            soft.append(
                f"Receipt line {number} '{line.name}' was not matched to any item you listed. It was scanned, so it "
                "was handled: look for it specifically. It may be flat, thin, soft, edge-on, or lying on another item."
            )
    counted = len(out.inventory) or len(out.starting_items)
    if counted and out.items_seen < counted:
        soft.append(
            f"You counted {counted} items in the item pile at the start but listed only "
            f"{out.items_seen} handled. Follow every item from the pile."
        )
    if out.verdict == "SCAN_AVOIDANCE" and unscanned == 0:
        hard.append("The verdict is SCAN_AVOIDANCE, but every item you listed matches a receipt line.")
    if out.verdict == "BENIGN" and unscanned > 0:
        soft.append(
            f"The verdict is BENIGN, but {unscanned} item(s) match no receipt line. Explain why (e.g. put back), "
            "or change the verdict."
        )
    return out, hard, soft


def receipt_lines_text(receipt: list[ReceiptLine]) -> str:
    if not receipt:
        return "Till receipt: none available."
    lines = "\n".join(f"{i}. {line.name} (₹{line.price_inr:g})" for i, line in enumerate(receipt, start=1))
    return f"Till receipt lines (what was actually scanned; set receipt_line to these numbers):\n{lines}"
