
from conftest import FakeGateway, text
from test_api import meta_header, sse_events
from test_investigator import run

from app import main
from app.models import SeenItem, VerdictOut
from app.reconcile import apply_floor_rule, floor_problems

JPEG = b"\xff\xd8\xff\xd9"


def floor_verdict(verdict="BENIGN", **item) -> VerdictOut:
    seen = {"t": "00:04.0", "description": "small tin", "scanned": False, **item}
    return VerdictOut(verdict=verdict, confidence=0.7, items_seen=1, items_scanned=0, seen_items=[SeenItem(**seen)],
                      reason="The person picked something up.")


def floor_json(verdict="BENIGN", **item) -> str:
    return floor_verdict(verdict, **item).model_dump_json()


# ---------- the rule ----------
def test_concealed_shelf_item_is_never_benign():
    out, note, overridden = apply_floor_rule(floor_verdict(came_from="shelf", ended_in="concealed"))
    assert out.verdict == "CONCEALMENT" and overridden and note.startswith("Floor check")


def test_openly_carried_item_and_own_phone_stay_benign():
    for item in ({"came_from": "shelf", "ended_in": "in_hand"},
                 {"came_from": "own_clothing_or_bag", "ended_in": "concealed"}):
        out, note, overridden = apply_floor_rule(floor_verdict(**item))
        assert out.verdict == "BENIGN" and note is None and not overridden
        assert floor_problems(floor_verdict(**item)) == []


def test_concealed_item_of_unclear_origin_goes_to_a_person():
    out, _, overridden = apply_floor_rule(floor_verdict(came_from="unclear", ended_in="concealed"))
    assert out.verdict == "INCONCLUSIVE" and overridden
    assert "came_from is unclear" in floor_problems(floor_verdict(came_from="unclear", ended_in="concealed"))[0]


def test_legacy_hand_or_pocket_still_loads():
    assert SeenItem(t="00:01", description="x", scanned=False, ended_in="hand_or_pocket").ended_in == "in_hand"


# ---------- in the investigation ----------
def test_floor_benign_with_a_pocketed_shelf_item_is_rechecked_then_flagged(repo, settings):
    answer = floor_json(came_from="shelf", ended_in="concealed", description="whisky bottle")
    gateway = FakeGateway([text(answer), text(answer)])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4")

    assert len(gateway.calls) == 2, "the contradiction is worth one re-check"
    recheck = gateway.calls[1][1][-1].parts[0].text
    assert recheck.startswith("Your answer doesn't add up:") and "till receipt" not in recheck
    incident = events[-1]["incident"]
    assert incident["verdict"]["verdict"] == "CONCEALMENT" and incident["overridden"] is True
    assert incident["est_loss_inr"] == 2400


def test_walking_away_holding_an_item_is_benign_with_no_loss(repo, settings):
    gateway = FakeGateway([text(floor_json(came_from="shelf", ended_in="in_hand", description="whisky bottle"))])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4")

    incident = events[-1]["incident"]
    assert len(gateway.calls) == 1
    assert incident["verdict"]["verdict"] == "BENIGN" and incident["est_loss_inr"] == 0


def test_exit_with_an_item_in_hand_counts_as_a_loss(repo, settings):
    gateway = FakeGateway([text(floor_json("RULE_BREACH", came_from="shelf", ended_in="in_hand",
                                           description="potato chips packet"))])

    events = run(repo, gateway, settings, camera_id="cam-aisle-2")

    assert events[-1]["incident"]["est_loss_inr"] == 50


def test_live_edge_hand_close_ups_and_clip_relative_hints(api):
    main.app.state.gateway = FakeGateway([text(floor_json(came_from="shelf", ended_in="in_hand"))])
    hint = {"t": "00:05.2", "kind": "CONCEALMENT", "score": 0.7, "detail": "Item went into a jacket pocket"}

    res = api.post(
        "/api/investigate",
        files=[("clip", ("clip.webm", b"video-bytes", "video/webm")),
               ("still", ("hold.jpg", JPEG, "image/jpeg")),
               ("still", ("hand_hold.jpg", JPEG, "image/jpeg")),
               ("still", ("hand_reach.jpg", JPEG, "image/jpeg"))],
        headers={"x-shrinksight-meta": meta_header(camera_id="cam-aisle-4", origin="edge", tier1_events=[hint])},
    )

    assert sse_events(res.text)[-1]["type"] == "result"
    parts = main.app.state.gateway.calls[0][1][0].parts
    texts = [p.text for p in parts if p.text]
    assert texts.index("Close-up: the hands when the on-device check saw a reach") < texts.index(
        "Close-up: the hands when the on-device check saw a possible hide")
    hands = [p for p in parts if p.inline_data and p.media_resolution is not None]
    assert {p.media_resolution.level.name for p in hands} >= {"MEDIA_RESOLUTION_MEDIUM"}
    assert "times are from the start of this clip" in parts[-1].text and "00:05.2" in parts[-1].text
