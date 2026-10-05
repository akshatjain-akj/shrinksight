import json

from conftest import FakeGateway, text
from test_investigator import CLIP, camera, verdict_json

from app import main
from app.investigator import investigate
from app.models import ReceiptLine, VerdictOut, ZoneHint
from app.reconcile import receipt_lines_text, reconcile
from app.zones import box_to_polygon, suggest_zones, zones_context

RECEIPT = [ReceiptLine(name="bottle", price_inr=0), ReceiptLine(name="fruit", price_inr=0),
           ReceiptLine(name="box", price_inr=0)]


def verdict(items, kind="SCAN_AVOIDANCE") -> VerdictOut:
    return VerdictOut(
        verdict=kind, confidence=0.8, items_seen=len(items), items_scanned=0, reason="r",
        seen_items=[{"t": "00:01.0", "description": d, "scanned": False, "receipt_line": line} for d, line in items],
    )


SCANNER = {"zone_id": "z-scan-1", "kind": "scanner", "description": "white paper square",
           "polygon": [{"x": 0.4, "y": 0.5}, {"x": 0.6, "y": 0.5}, {"x": 0.6, "y": 0.7}, {"x": 0.4, "y": 0.7}]}


# ---------- reconcile ----------
def test_scanned_is_decided_by_receipt_match_not_by_the_model():
    checked, hard, soft = reconcile(verdict([("bottle", 1), ("fruit", 2), ("biscuit", None), ("box", 3)]), RECEIPT)

    assert [i.scanned for i in checked.seen_items] == [True, True, False, True]
    assert (checked.items_seen, checked.items_scanned) == (4, 3)
    assert hard == [] and soft == []


def test_nothing_matched_against_a_full_receipt_is_a_hard_contradiction():
    _, hard, _ = reconcile(verdict([("a", None), ("b", None), ("c", None)]), RECEIPT)
    assert any("None of the 3 items" in p for p in hard)


def test_duplicate_line_and_verdict_mismatch_are_hard():
    checked, hard, _ = reconcile(verdict([("bottle", 1), ("bottle again", 1), ("fruit", 2), ("box", 3)]), RECEIPT)
    assert checked.seen_items[1].receipt_line is None
    assert any("more than one item" in p for p in hard)

    _, hard, _ = reconcile(verdict([("bottle", 1), ("fruit", 2), ("box", 3)]), RECEIPT)
    assert any("every item you listed matches" in p for p in hard)


def test_fewer_items_than_receipt_and_benign_with_unmatched_are_soft():
    _, hard, soft = reconcile(verdict([("bottle", 1), ("fruit", 2)], kind="BENIGN"), RECEIPT)
    assert hard == [] and any("receipt has 3 lines" in p for p in soft)

    _, hard, soft = reconcile(verdict([("bottle", 1), ("fruit", 2), ("box", 3), ("pen", None)], kind="BENIGN"), RECEIPT)
    assert hard == [] and any("BENIGN" in p for p in soft)


def test_no_receipt_means_no_reconciliation():
    original = verdict([("a", None)])
    checked, hard, soft = reconcile(original, [])
    assert checked is original and hard == [] and soft == []


def test_receipt_lines_are_numbered_for_the_prompt():
    assert "1. bottle" in receipt_lines_text(RECEIPT) and "3. box" in receipt_lines_text(RECEIPT)


# ---------- investigator with receipt-first + zones ----------
def test_contradiction_is_re_asked_then_accepted(repo, settings):
    wrong = verdict_json(seen_items=[{"t": "00:01", "description": d, "scanned": False} for d in ("a", "b", "c")])
    gateway = FakeGateway([text("notes"), text(wrong), text(verdict_json())])

    events = list(investigate(CLIP, "video/webm", camera(repo, "cam-sco-2"), repo.get_transaction("TXN-L2-2041"),
                              repo, gateway, settings))

    assert events[-1]["incident"]["verdict"]["verdict"] == "SCAN_AVOIDANCE"
    assert "doesn't add up" in gateway.calls[-1][1][-1].parts[0].text


def test_contradiction_twice_becomes_inconclusive(repo, settings):
    wrong = verdict_json(seen_items=[{"t": "00:01", "description": d, "scanned": True} for d in ("a", "b", "c")])
    gateway = FakeGateway([text("notes"), text(wrong), text(wrong)])

    events = list(investigate(CLIP, "video/webm", camera(repo, "cam-sco-2"), repo.get_transaction("TXN-L2-2041"),
                              repo, gateway, settings))

    incident = events[-1]["incident"]
    assert incident["verdict"]["verdict"] == "INCONCLUSIVE"
    assert incident["status"] == "NEEDS_REVIEW" and incident["est_loss_inr"] == 0


def test_zones_reach_the_prompt_change_the_cache_key_and_are_recorded(repo, settings):
    hint = ZoneHint(**SCANNER)
    txn = repo.get_transaction("TXN-L1-1001")
    seen = [{"t": "00:01", "description": d, "scanned": True, "receipt_line": i}
            for i, d in enumerate(["milk", "bread", "chips", "chocolate"], start=1)]
    benign = verdict_json(verdict="BENIGN", items_scanned=4, seen_items=seen)
    gateway = FakeGateway([text("notes"), text(benign), text("notes"), text(benign)])

    first = list(investigate(CLIP, "video/webm", camera(repo, "cam-sco-1"), txn, repo, gateway, settings, zones=[hint]))
    second = list(investigate(CLIP, "video/webm", camera(repo, "cam-sco-1"), txn, repo, gateway, settings, zones=[]))

    prompt = gateway.calls[0][1][0].parts[-1].text
    assert "white paper square" in prompt and "[500, 400, 700, 600]" in prompt
    assert second[-1]["cached"] is False, "different zones must not reuse the cached analysis"
    assert first[-1]["incident"]["zones_used"][0]["zone_id"] == "z-scan-1"


# ---------- zone helpers + suggestions ----------
def test_zone_box_and_context():
    hint = ZoneHint(**SCANNER)
    assert hint.box_2d() == [500, 400, 700, 600]
    assert [(p.x, p.y) for p in box_to_polygon([500, 400, 700, 600])][0] == (0.4, 0.5)
    assert "z-scan-1" in zones_context([hint], []) and zones_context([], []) == ""


def test_suggestions_are_cleaned_cached_and_cover_every_zone(repo):
    raw = {"zones": [
        {"zone_id": "z-scan-1", "found": True, "box_2d": [500, 400, 700, 600], "description": "paper square"},
        {"zone_id": "z-spirits", "found": True, "box_2d": [1, 1, 900, 900]},       # not this camera: dropped
    ]}
    gateway = FakeGateway([text(json.dumps(raw))])
    cam = camera(repo, "cam-sco-1")

    first, cached1 = suggest_zones(b"\xff\xd8jpeg", "image/jpeg", cam, repo.zones(), gateway, "m", repo)
    second, cached2 = suggest_zones(b"\xff\xd8jpeg", "image/jpeg", cam, repo.zones(), gateway, "m", repo)

    assert [s.zone_id for s in first] == ["z-scan-1", "z-bag-1"]
    assert first[0].found and not first[1].found and first[1].box_2d == []
    assert (cached1, cached2) == (False, True) and second == first


def test_invalid_suggested_box_is_marked_not_found(repo):
    raw = {"zones": [{"zone_id": "z-scan-1", "found": True, "box_2d": [500, 400, 505, 600]}]}
    suggestions, _ = suggest_zones(b"img", "image/png", camera(repo, "cam-sco-1"), repo.zones(),
                                   FakeGateway([text(json.dumps(raw))]), "m", repo)
    assert suggestions[0].found is False


# ---------- layout endpoints ----------
def test_layout_save_list_and_validation(api):
    assert api.get("/api/layouts").json() == {}

    saved = api.put("/api/layouts/cam-sco-1", json={"zones": [SCANNER]})
    assert saved.status_code == 200
    assert api.get("/api/layouts").json()["cam-sco-1"]["zones"][0]["description"] == "white paper square"

    wrong_camera = {**SCANNER, "zone_id": "z-spirits", "kind": "shelf"}
    assert api.put("/api/layouts/cam-sco-1", json={"zones": [wrong_camera]}).status_code == 400
    assert api.put("/api/layouts/cam-nope", json={"zones": []}).status_code == 404
    bad_point = {**SCANNER, "polygon": [{"x": 2, "y": 0}] * 3}
    assert api.put("/api/layouts/cam-sco-1", json={"zones": [bad_point]}).status_code == 422


def test_suggest_endpoint(api):
    raw = {"zones": [{"zone_id": "z-scan-1", "found": True, "box_2d": [500, 400, 700, 600], "description": "paper"}]}
    main.app.state.gateway = FakeGateway([text(json.dumps(raw))])

    res = api.post("/api/layouts/cam-sco-1/suggest", content=b"\xff\xd8frame", headers={"content-type": "image/jpeg"})

    assert res.status_code == 200
    assert res.json()["zones"][0]["box_2d"] == [500, 400, 700, 600]
    assert api.post("/api/layouts/cam-sco-1/suggest", content=b"x",
                    headers={"content-type": "text/plain"}).status_code == 415
