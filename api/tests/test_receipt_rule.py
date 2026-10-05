import json

from conftest import FakeGateway, text
from test_investigator import run, verdict_json

from app.models import ReceiptLine, VerdictOut
from app.reconcile import apply_receipt_rule, reconcile

RECEIPT = [ReceiptLine(name="bottle", price_inr=0), ReceiptLine(name="fruit", price_inr=0)]


def verdict(kind: str, items: list[tuple[str, int | None, str]]) -> VerdictOut:
    return VerdictOut(
        verdict=kind, confidence=0.8, items_seen=len(items), items_scanned=sum(1 for _, line, _ in items if line),
        reason="model reason",
        seen_items=[{"t": "00:01", "description": d, "scanned": bool(line), "receipt_line": line, "ended_in": end}
                    for d, line, end in items],
    )


# ---------- the deterministic rule ----------
def test_benign_with_unscanned_items_in_the_bag_is_overridden_to_review():
    v = verdict("BENIGN", [("bottle", 1, "bag"), ("fruit", 2, "bag"), ("flower", None, "bag"),
                           ("biscuits", None, "hand_or_pocket")])

    out, note, overridden = apply_receipt_rule(v, RECEIPT)

    assert overridden and out.verdict == "SCAN_AVOIDANCE"
    assert "2 item(s) not on the receipt ended in the bag or with the shopper (flower, biscuits)" in note
    assert out.reason.startswith("Receipt check:")


def test_unscanned_items_left_in_the_pile_stay_benign_with_a_reason():
    v = verdict("BENIGN", [("bottle", 1, "bag"), ("fruit", 2, "bag"), ("pen", None, "pile"), ("cup", None, "put_back")])

    out, note, overridden = apply_receipt_rule(v, RECEIPT)

    assert not overridden and out.verdict == "BENIGN"
    assert note == ("Receipt check: all 2 item(s) handled matched the receipt; 2 unmatched item(s) stayed in the "
                    "pile or were put back (pen, cup).")


def test_benign_with_unclear_destination_becomes_inconclusive():
    out, note, overridden = apply_receipt_rule(verdict("BENIGN", [("bottle", 1, "bag"), ("box", None, "unclear")]),
                                               RECEIPT)
    assert overridden and out.verdict == "INCONCLUSIVE" and "unclear destination (box)" in note


def test_positive_verdicts_are_not_downgraded_and_no_receipt_means_no_rule():
    flagged = verdict("SCAN_AVOIDANCE", [("bottle", 1, "bag"), ("flower", None, "bag")])
    out, note, overridden = apply_receipt_rule(flagged, RECEIPT)
    assert out.verdict == "SCAN_AVOIDANCE" and not overridden and "flower" in note

    assert apply_receipt_rule(flagged, []) == (flagged, None, False)


def test_benign_with_taken_items_is_a_hard_contradiction_for_the_recheck():
    _, hard, _ = reconcile(verdict("BENIGN", [("bottle", 1, "bag"), ("fruit", 2, "bag"), ("flower", None, "bag")]),
                           RECEIPT)
    assert any("ended in the bag or with the shopper (flower)" in p for p in hard)


# ---------- end to end: the case from the field ----------
def seen(entries):
    return [{"t": f"00:0{i}", "description": d, "scanned": line is not None, "receipt_line": line,
             "location": loc, "ended_in": end} for i, (d, line, loc, end) in enumerate(entries, start=1)]


def test_benign_answer_with_three_bagged_items_not_on_receipt_is_flagged_not_rejected(repo, settings):
    items = seen([("milk carton", 1, "over_scanner", "bag"), ("bread loaf", 2, "over_scanner", "bag"),
                  ("chips packet", 3, "over_scanner", "bag"), ("wine bottle", None, "never_near_scanner", "bag"),
                  ("razor pack", None, "never_near_scanner", "bag"),
                  ("whisky bottle", None, "never_near_scanner", "bag")])
    benign = verdict_json(verdict="BENIGN", items_seen=6, items_scanned=3, seen_items=items)
    gateway = FakeGateway([text(benign), text(benign)])  # Gemini insists on BENIGN after the re-check too

    events = run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"))

    incident = events[-1]["incident"]
    assert len(gateway.calls) == 2, "the contradiction is re-asked once"
    assert incident["verdict"]["verdict"] == "SCAN_AVOIDANCE"
    assert incident["status"] == "NEEDS_REVIEW" and incident["overridden"] is True
    assert "3 item(s) not on the receipt ended in the bag" in incident["receipt_check"]
    assert {u["description"] for u in incident["unscanned_items"]} == {"wine bottle", "razor pack", "whisky bottle"}
    assert incident["est_loss_inr"] > 0


def test_items_that_stayed_in_the_pile_are_not_priced_as_loss(repo, settings):
    items = seen([("milk carton", 1, "over_scanner", "bag"), ("bread loaf", 2, "over_scanner", "bag"),
                  ("chips packet", 3, "over_scanner", "bag"), ("red wine bottle", None, "never_near_scanner", "bag"),
                  ("apples", None, "unclear", "pile")])
    flagged = verdict_json(verdict="SCAN_AVOIDANCE", items_seen=5, items_scanned=3, seen_items=items)

    events = run(repo, FakeGateway([text(flagged)]), settings, transaction=repo.get_transaction("TXN-L2-2041"))

    incident = events[-1]["incident"]
    assert [u["description"] for u in incident["unscanned_items"]] == ["red wine bottle"]
    assert incident["est_loss_inr"] == 1850


def test_genuine_rejection_records_why(repo, settings):
    items = seen([("milk carton", 1, "over_scanner", "bag"), ("bread loaf", 2, "over_scanner", "bag"),
                  ("chips packet", 3, "over_scanner", "bag")])
    benign = verdict_json(verdict="BENIGN", items_seen=3, items_scanned=3, seen_items=items)

    events = run(repo, FakeGateway([text(benign)]), settings, transaction=repo.get_transaction("TXN-L2-2041"))

    incident = events[-1]["incident"]
    assert incident["status"] == "REJECTED" and incident["overridden"] is False
    assert incident["receipt_check"] == "Receipt check: all 3 item(s) handled matched the receipt."


def test_bundle_rule_is_in_the_prompt():
    from app.investigator import SYSTEM_PROMPT

    assert "Bundled items (taped, rubber-banded, or in one tray)" in SYSTEM_PROMPT
    assert json.dumps("never_near_scanner")[1:-1] in SYSTEM_PROMPT
