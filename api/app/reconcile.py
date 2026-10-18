"""Receipt-first reconciliation for self-checkout verdicts.

Gemini lists every item it saw and, for each, the receipt line it matches (or none). The server then
decides "scanned" deterministically: an item is scanned if and only if it matched a receipt line.
This does not depend on seeing the scan gesture, so it holds up across camera angles.

Problems are split into:
- hard: the answer contradicts the receipt (e.g. nothing matched a 5-line receipt). After one re-ask,
  a remaining hard problem turns the verdict into INCONCLUSIVE rather than a false alarm.
- soft: suspicious but possible (e.g. fewer items listed than receipt lines, an occlusion). Worth one
  re-ask, then accepted.

The shop floor has no receipt, so it gets its own safety rule: a store item (picked up from the shelf area) that
ended concealed in a pocket, clothing or a personal bag is never accepted as BENIGN.
"""

from .models import LEFT_BEHIND, POSITIVE_VERDICTS, TAKEN, InventoryItem, ReceiptLine, Rule, VerdictOut


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
            "put_back, bag, in_hand, concealed) and change the verdict if any were taken."
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


# On the shop floor there is no bagging area, so an item that ended in a bag went into the shopper's own bag.
FLOOR_HIDDEN = {"concealed", "bag"}


def _concealed(verdict: VerdictOut) -> tuple[list[str], list[str]]:
    """Shop-floor items that ended hidden (concealed, or in the shopper's own bag), split into store items (from the
    shelf area) and items of unclear origin. Personal items going back where they came from don't count."""
    concealed = [i for i in verdict.seen_items if i.ended_in in FLOOR_HIDDEN and i.came_from != "own_clothing_or_bag"]
    store = [i.description for i in concealed if i.came_from in ("shelf", "pile", "counter")]
    unclear = [i.description for i in concealed if i.came_from == "unclear"]
    return store, unclear


def floor_problems(verdict: VerdictOut) -> list[str]:
    """What doesn't add up in a shop-floor answer; worth one re-check.

    A store item that ended hidden under a non-theft verdict is NOT re-checked: Gemini saw the hide, and asking again
    only invites it to relabel the item as put back. apply_floor_rule decides that case (CONCEALMENT, for review).
    Only an unclear origin is asked about, and the question offers no way out of what was seen.
    """
    if verdict.verdict in POSITIVE_VERDICTS:
        return []
    store, unclear = _concealed(verdict)
    if store or not unclear:
        return []
    return [
        f"{', '.join(unclear)} ended hidden (in clothing or a bag) but came_from is unclear. Watch only where it was "
        "first picked up: the shelf area (a store item) or the person's own pocket, clothing or bag (a personal "
        "item). Keep ended_in as you saw it."
    ]


def apply_floor_rule(verdict: VerdictOut) -> tuple[VerdictOut, str | None, bool]:
    """Deterministic safety rule for the shop floor: a concealed store item is never BENIGN.

    Returns (verdict, note, whether Gemini's verdict was overridden).
    - A store item that ended concealed or in the shopper's bag -> CONCEALMENT.
    - A concealed item of unclear origin -> INCONCLUSIVE (a person looks).
    Carrying an item openly, or a personal item going back into the person's own pocket, stays as Gemini said.
    """
    if verdict.verdict in POSITIVE_VERDICTS:
        return verdict, None, False
    store, unclear = _concealed(verdict)
    if store:
        note = (f"Floor check: {', '.join(store)} came from the shelf area and ended concealed (clothing or the "
                f"shopper's bag). Gemini said {verdict.verdict}, so this was flagged for review.")
        return verdict.model_copy(update={"verdict": "CONCEALMENT", "reason": f"{note} {verdict.reason}"}), note, True
    if unclear and verdict.verdict == "BENIGN":
        note = (f"Floor check: {', '.join(unclear)} ended concealed (clothing or a bag) and it isn't clear whether it "
                "was a store item, so a person should look.")
        return verdict.model_copy(update={"verdict": "INCONCLUSIVE", "reason": f"{note} {verdict.reason}"}), note, True
    return verdict, None, False


THREAT_LABEL = {"firearm": "firearm", "knife": "knife", "other_weapon": "weapon"}


def _watched_kinds(rules: list[Rule]) -> set[str]:
    kinds: set[str] = set()
    for rule in rules:
        wanted = rule.spec.threat_of or "any_weapon"
        kinds |= {"firearm", "knife", "other_weapon"} if wanted == "any_weapon" else {wanted}
    return kinds


def apply_threat_rule(
    verdict: VerdictOut, rules: list[Rule], tier1_events: list[dict] | None = None
) -> tuple[VerdictOut, str | None, bool, bool]:
    """Deterministic rule for the store's THREAT rules. Returns (verdict, note, overridden, urgent).

    - Gemini saw a watched weapon -> RULE_BREACH, urgent: a person verifies on camera at once.
    - Tier 1 saw an aiming pose but Gemini saw no weapon, and Gemini said BENIGN -> INCONCLUSIVE (needs review):
      a missed weapon must never read as "all clear".
    Without a threat rule nothing changes.
    """
    if not rules:
        return verdict, None, False, False
    watched = _watched_kinds(rules)
    seen = [t for t in verdict.threats if t.type in watched]
    if seen:
        first = seen[0]
        what = THREAT_LABEL[first.type] + (" pointed at a person" if first.pointed_at_person else " visible in a hand")
        note = f"Possible threat: {what} at {first.t}. Verify on camera; ShrinkSight never contacts police."
        changed = verdict.verdict != "RULE_BREACH"
        updated = verdict.model_copy(update={"verdict": "RULE_BREACH", "reason": f"{note} {verdict.reason}"})
        return updated, note, changed, True
    aimed = next((e for e in tier1_events or [] if e.get("kind") == "THREAT"), None)
    if aimed and verdict.verdict == "BENIGN":
        note = (f"Threat check: the on-device check saw a possible aiming pose at {aimed.get('t', '?')}, but no weapon "
                "was visible to Gemini. A person should look at the camera.")
        updated = verdict.model_copy(update={"verdict": "INCONCLUSIVE", "reason": f"{note} {verdict.reason}"})
        return updated, note, True, False
    return verdict, None, False, False
