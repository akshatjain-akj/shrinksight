from conftest import FakeGateway, text
from test_api import meta_header, sse_events
from test_floor_rule import floor_json, floor_verdict

from app import main
from app.models import ReceiptLine, Tier1Measure
from app.tier1 import apply_tier1_rule, close_up_text, measure_text

HOLD = {"hand": "right", "start_s": 3.4, "end_s": 5.0, "spot": "pocket", "after_shelf_s": 2.9}
FLOOR = {"gate_opened": False, "peak_score": 0.14, "person_seen": 1.0,
         "shelf_contacts": [{"hand": "right", "start_s": 2.1, "end_s": 2.9}], "holds": [HOLD],
         "close_ups": [{"label": "hand_1", "t_s": 2.9, "moment": "shelf_exit"},
                       {"label": "hand_2", "t_s": 3.8, "moment": "hold"}]}
TRIPS = [{"start_s": 1.0, "end_s": 2.0, "via_scanner": True}, {"start_s": 3.0, "end_s": 4.1, "via_scanner": True},
         {"start_s": 5.0, "end_s": 6.2, "via_scanner": False}, {"start_s": 7.0, "end_s": 8.0, "via_scanner": True}]
RECEIPT = [ReceiptLine(name=name, price_inr=10) for name in ("milk", "bread", "chips")]


def measure(**overrides) -> Tier1Measure:
    return Tier1Measure.model_validate({**FLOOR, **overrides})


def investigate(api, camera_id="cam-aisle-4", stills=(), **meta):
    files = [("clip", ("clip.webm", b"same-clip", "video/webm"))]
    files += [("still", (f"{label}.jpg", b"\xff\xd8jpeg", "image/jpeg")) for label in stills]
    res = api.post("/api/investigate", files=files,
                   headers={"x-shrinksight-meta": meta_header(camera_id=camera_id, **meta)})
    return res, sse_events(res.text)


# ---------- what Gemini reads ----------
def test_measurements_are_times_and_places_not_conclusions():
    out = measure_text(measure(trips=TRIPS))
    assert "Right hand in the shelf zone 00:02.1–00:02.9" in out
    assert "left the shelf at 00:02.9, then rested at pocket height by the hip 00:03.4–00:05.0 (1.6 s)" in out
    assert "4 hand trip(s)" in out and "00:05.0→00:06.2 NOT through the scanner zone" in out
    assert "trust the video" in out
    for conclusion in ("put back", "conceal", "theft", "stole", "hide"):
        assert conclusion not in out.lower()


def test_close_ups_are_captioned_with_their_moment():
    captions = close_up_text(measure())
    assert captions == {
        "hand_1": "Close-up: the hands at 00:02.9, just after leaving the shelf zone (Tier-1 moment)",
        "hand_2": "Close-up: the hands at 00:03.8, resting on the body (Tier-1 moment)",
    }


# ---------- the safety rule ----------
def test_more_trips_than_receipt_lines_sends_a_benign_checkout_to_review():
    out, note = apply_tier1_rule(floor_verdict(), measure(holds=[], trips=TRIPS), RECEIPT)
    assert out.verdict == "INCONCLUSIVE" and note.startswith("Tier-1 check: the tracker measured 4 hand trips")


def test_trips_matching_the_receipt_keep_benign():
    out, note = apply_tier1_rule(floor_verdict(), measure(holds=[], trips=TRIPS[:3]), RECEIPT)
    assert out.verdict == "BENIGN" and note is None


def test_a_long_hand_rest_after_the_shelf_sends_a_benign_floor_clip_to_review():
    out, note = apply_tier1_rule(floor_verdict(), measure(), [])
    assert out.verdict == "INCONCLUSIVE" and "rested at pocket height by the hip for 1.6 s" in note


def test_a_short_rest_or_a_positive_verdict_is_left_alone():
    short = measure(holds=[{**HOLD, "end_s": 4.0}])
    assert apply_tier1_rule(floor_verdict(), short, [])[0].verdict == "BENIGN"
    positive = floor_verdict("CONCEALMENT", came_from="shelf", ended_in="concealed")
    assert apply_tier1_rule(positive, measure(), []) == (positive, None)
    assert apply_tier1_rule(floor_verdict(), None, []) == (floor_verdict(), None)


# ---------- through the API ----------
def test_upload_with_measurements_reaches_gemini_and_review(api):
    main.app.state.gateway = FakeGateway([text(floor_json(came_from="shelf", ended_in="in_hand"))])

    res, events = investigate(api, origin="upload", tier1_screen="cleared", tier1_measure=FLOOR,
                              stills=("hand_1", "hand_2"))

    assert res.status_code == 200 and events[-1]["type"] == "result"
    incident = events[-1]["incident"]
    assert incident["verdict"]["verdict"] == "INCONCLUSIVE" and incident["status"] == "NEEDS_REVIEW"
    assert incident["overridden"] and "Tier-1 check" in incident["receipt_check"]
    assert incident["tier1_measure"]["holds"][0]["spot"] == "pocket"
    assert incident["tier1_screen"] == "cleared" and incident["edge_confidence"] == 0.14
    parts = main.app.state.gateway.calls[0][1][0].parts
    texts = [p.text for p in parts if p.text]
    assert any("just after leaving the shelf zone" in t for t in texts)
    assert "On-device Tier-1 measurements" in texts[-1]


def test_measurements_change_the_cache_key(api):
    main.app.state.gateway = FakeGateway([text(floor_json(came_from="shelf", ended_in="in_hand"))] * 2)
    _, plain = investigate(api, origin="upload", tier1_screen="cleared")
    _, measured = investigate(api, origin="upload", tier1_screen="cleared", tier1_measure=FLOOR)
    assert plain[-1]["incident"].get("tier1_measure") is None
    assert measured[-1]["cached"] is False


def test_a_bad_close_up_label_in_the_measurements_is_rejected(api):
    bad = {**FLOOR, "close_ups": [{"label": "hand_9", "t_s": 1, "moment": "hold"}]}
    res, _ = investigate(api, tier1_measure=bad)
    assert res.status_code == 400


def test_live_edge_put_back_hints_never_reach_gemini(api):
    main.app.state.gateway = FakeGateway([text(floor_json(came_from="shelf", ended_in="in_hand"))])
    put_back = {"t": "00:00.0", "kind": "PUT_BACK", "score": 0.3, "detail": "Item put back on the shelf."}
    shelf = {"t": "00:02.0", "kind": "SHELF_REACH", "score": 0.55, "detail": "Hand reached into the shelf."}

    investigate(api, origin="edge", tier1_events=[put_back, shelf])

    prompt = main.app.state.gateway.calls[0][1][0].parts[-1].text
    assert "SHELF_REACH" in prompt and "PUT_BACK" not in prompt and "put back on the shelf" not in prompt
