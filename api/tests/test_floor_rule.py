
from conftest import FakeGateway, text
from test_api import meta_header, sse_events
from test_investigator import run

from app import investigator, main
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
def test_floor_benign_with_a_pocketed_shelf_item_is_flagged_without_a_recheck(repo, settings):
    answer = floor_json(came_from="shelf", ended_in="concealed", description="whisky bottle")
    gateway = FakeGateway([text(answer)])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4")

    assert len(gateway.calls) == 1, "Gemini saw the hide; the floor rule decides, no second look to talk it out of it"
    incident = events[-1]["incident"]
    assert incident["verdict"]["verdict"] == "CONCEALMENT" and incident["overridden"] is True
    assert incident["est_loss_inr"] == 2400
    assert "recheck_ms" not in incident["timings"]


def test_a_recheck_can_no_longer_relabel_a_seen_hide_as_put_back(repo, settings):
    # What used to happen: the re-check said "unless it went back to the shelf", Gemini answered put_back, BENIGN.
    seen = floor_json(came_from="shelf", ended_in="concealed", description="whisky bottle")
    recanted = floor_json(came_from="shelf", ended_in="put_back", description="whisky bottle")
    gateway = FakeGateway([text(seen), text(recanted)])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4")

    assert len(gateway.calls) == 1
    assert events[-1]["incident"]["verdict"]["verdict"] == "CONCEALMENT"


def test_unclear_origin_recheck_asks_only_where_it_was_picked_up(repo, settings):
    answer = floor_json(came_from="unclear", ended_in="concealed", description="small tin")
    gateway = FakeGateway([text(answer), text(answer)])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4")

    assert len(gateway.calls) == 2
    recheck = gateway.calls[1][1][-1].parts[0].text
    assert "first picked up" in recheck and "Keep ended_in as you saw it" in recheck
    assert "put back" not in recheck and "went back to the shelf" not in recheck
    assert events[-1]["incident"]["verdict"]["verdict"] == "INCONCLUSIVE"


def test_a_shelf_item_into_the_shoppers_bag_on_the_floor_is_concealment_with_a_loss(repo, settings):
    gateway = FakeGateway([text(floor_json(came_from="shelf", ended_in="bag", description="whisky bottle"))])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4")

    incident = events[-1]["incident"]
    assert len(gateway.calls) == 1
    assert incident["verdict"]["verdict"] == "CONCEALMENT" and incident["overridden"] is True
    assert "shopper's bag" in incident["receipt_check"]
    assert incident["est_loss_inr"] == 2400


def test_own_item_back_into_own_bag_stays_benign():
    out, note, overridden = apply_floor_rule(floor_verdict(came_from="own_clothing_or_bag", ended_in="bag"))
    assert out.verdict == "BENIGN" and note is None and not overridden
    assert floor_problems(floor_verdict(came_from="own_clothing_or_bag", ended_in="bag")) == []


def test_floor_prompt_tells_gemini_a_shoppers_bag_is_concealed(repo, settings):
    gateway = FakeGateway([text(floor_json(came_from="shelf", ended_in="in_hand"))])
    run(repo, gateway, settings, camera_id="cam-aisle-4")
    assert investigator.FLOOR_BAG_NOTE in gateway.calls[0][1][0].parts[-1].text


def test_checkout_prompt_and_cache_are_untouched_by_floor_changes(repo, settings, monkeypatch):
    from test_investigator import verdict_json

    gateway = FakeGateway([text(verdict_json())])
    txn = repo.get_transaction("TXN-L2-2041")
    first = run(repo, gateway, settings, transaction=txn)
    request_text = " ".join(p.text for p in gateway.calls[0][1][0].parts if p.text)
    assert "shop floor there is no bagging area" not in request_text

    # A new floor prompt version must not re-run cached checkout clips...
    monkeypatch.setattr(investigator, "FLOOR_PROMPT_VERSION", "next")
    again = run(repo, FakeGateway([]), settings, transaction=txn)
    assert first[-1]["cached"] is False and again[-1]["cached"] is True


def test_a_new_floor_prompt_version_re_runs_floor_clips(repo, settings, monkeypatch):
    answer = text(floor_json(came_from="shelf", ended_in="in_hand"))
    run(repo, FakeGateway([answer]), settings, camera_id="cam-aisle-4")
    monkeypatch.setattr(investigator, "FLOOR_PROMPT_VERSION", "next")
    again = run(repo, FakeGateway([answer]), settings, camera_id="cam-aisle-4")
    assert again[-1]["cached"] is False


def test_a_checkout_item_in_the_bag_is_still_judged_by_the_receipt(repo, settings):
    from test_investigator import verdict_json

    gateway = FakeGateway([text(verdict_json())])
    events = run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"))
    incident = events[-1]["incident"]
    assert incident["verdict"]["verdict"] == "SCAN_AVOIDANCE"
    assert not (incident["receipt_check"] or "").startswith("Floor check")


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
