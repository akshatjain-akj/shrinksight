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

from .models import LEFT_BEHIND, POSITIVE_VERDICTS, TAKEN, InventoryItem, ReceiptLine, VerdictOut


def reconcile(
    verdict: VerdictOut, receipt: list[ReceiptLine], confirmed: list[InventoryItem] | None = None
) -> tuple[VerdictOut, list[str], list[str]]:
    confirmed = confirmed or []
    if not receipt and not confirmed:
        return verdict, [], []

    out = verdict.model_copy(deep=True)
    hard: list[str] = []
    soft: list[str] = []
    if confirmed:
        out.inventory = list(confirmed)
        soft += _account_for_confirmed(out, confirmed)
    if not receipt:
        return out, hard, soft

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
    counted = 0 if confirmed else (len(out.inventory) or len(out.starting_items))
    if counted and out.items_seen < counted:
        soft.append(
            f"You counted {counted} items in the item pile at the start but listed only "
            f"{out.items_seen} handled. Follow every item from the pile."
        )
    if out.verdict == "SCAN_AVOIDANCE" and unscanned == 0:
        hard.append("The verdict is SCAN_AVOIDANCE, but every item you listed matches a receipt line.")
    taken = [i.description for i in out.seen_items if not i.scanned and i.ended_in in TAKEN]
    if out.verdict == "BENIGN" and taken:
        hard.append(
            f"The verdict is BENIGN, but {len(taken)} item(s) not on the receipt ended in the bag or with the "
            f"shopper ({', '.join(taken)}). That is SCAN_AVOIDANCE unless those items really stayed or were put back."
        )
    elif out.verdict == "BENIGN" and unscanned > 0:
        soft.append(
            f"The verdict is BENIGN, but {unscanned} item(s) match no receipt line. Set ended_in for each (pile, "
            "put_back, bag, hand_or_pocket) and change the verdict if any were taken."
        )
    return out, hard, soft


def apply_receipt_rule(verdict: VerdictOut, receipt: list[ReceiptLine]) -> tuple[VerdictOut, str | None, bool]:
    """Deterministic safety rule: Gemini can clear an alert only when the receipt agrees.

    Returns (verdict, note explaining the decision, whether Gemini's verdict was overridden).
    - Items not on the receipt that ended in the bag or with the shopper -> at least SCAN_AVOIDANCE.
    - BENIGN with unmatched items whose destination is unclear -> INCONCLUSIVE (a person looks).
    - BENIGN is kept only when every item matched the receipt or stayed in the pile / was put back.
    """
    if not receipt:
        return verdict, None, False
    unscanned = [i for i in verdict.seen_items if not i.scanned]
    taken = [i.description for i in unscanned if i.ended_in in TAKEN]
    unclear = [i.description for i in unscanned if i.ended_in not in TAKEN | LEFT_BEHIND]
    left = [i.description for i in unscanned if i.ended_in in LEFT_BEHIND]

    if taken and verdict.verdict not in POSITIVE_VERDICTS:
        note = (f"Receipt check: {len(taken)} item(s) not on the receipt ended in the bag or with the shopper "
                f"({', '.join(taken)}). Gemini said {verdict.verdict}, so this was flagged for review.")
        updated = verdict.model_copy(update={"verdict": "SCAN_AVOIDANCE", "reason": f"{note} {verdict.reason}"})
        return updated, note, True
    if verdict.verdict == "BENIGN" and unclear:
        note = (f"Receipt check: {len(unclear)} item(s) not on the receipt with an unclear destination "
                f"({', '.join(unclear)}), so a person should look.")
        return verdict.model_copy(update={"verdict": "INCONCLUSIVE", "reason": f"{note} {verdict.reason}"}), note, True
    if verdict.verdict == "BENIGN":
        matched = verdict.items_scanned
        basis = f"Receipt check: all {matched} item(s) handled matched the receipt"
        if left:
            basis += f"; {len(left)} unmatched item(s) stayed in the pile or were put back ({', '.join(left)})"
        return verdict, basis + ".", False
    if taken:
        return verdict, f"Receipt check: not on the receipt and taken: {', '.join(taken)}.", False
    return verdict, None, False


def _account_for_confirmed(out: VerdictOut, confirmed: list[InventoryItem]) -> list[str]:
    """Every item on the confirmed list must appear in seen_items (by inventory_id); name the ones that don't."""
    problems: list[str] = []
    seen_ids: set[int] = set()
    for item in out.seen_items:
        number = item.inventory_id
        if number is not None and not 1 <= number <= len(confirmed):
            item.inventory_id = None
            continue
        if number is not None and number in seen_ids:
            problems.append(f"Item #{number} ({confirmed[number - 1].description}) was used for more than one item.")
            item.inventory_id = None
            continue
        if number is not None:
            seen_ids.add(number)
    for number, listed in enumerate(confirmed, start=1):
        if number not in seen_ids:
            problems.append(
                f"Item #{number} ({listed.description}) from the confirmed list isn't accounted for. Find where it "
                "went (over the scanner, around it, into the bag, or still in the pile) and include it."
            )
    return problems


def confirmed_list_text(confirmed: list[InventoryItem]) -> str:
    lines = "\n".join(f"#{i} {item.description}" for i, item in enumerate(confirmed, start=1))
    return (
        "Confirmed item list (numbered boxes on the item-pile close-up). Track EVERY # item: list each one in "
        "seen_items with its inventory_id. Extra items not on the list are allowed with inventory_id null.\n"
        + lines
    )


def receipt_lines_text(receipt: list[ReceiptLine]) -> str:
    if not receipt:
        return "Till receipt: none available."
    lines = "\n".join(f"{i}. {line.name} (₹{line.price_inr:g})" for i, line in enumerate(receipt, start=1))
    return f"Till receipt lines (what was actually scanned; set receipt_line to these numbers):\n{lines}"
