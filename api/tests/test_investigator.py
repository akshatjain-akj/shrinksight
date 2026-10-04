import json

from conftest import FakeGateway, call, text

from app.gemini import FunctionCall, GeminiUnavailable, GenResult
from app.investigator import investigate, normalise_mime

CLIP = b"\x00fake-video-bytes"


def verdict_json(**overrides) -> str:
    base = {
        "verdict": "SCAN_AVOIDANCE",
        "confidence": 0.9,
        "items_seen": 4,
        "items_scanned": 3,
        "seen_items": [
            {"t": "00:01.0", "description": "milk carton", "scanned": True, "box_2d": [1, 2, 3, 4]},
            {"t": "00:03.0", "description": "bread loaf", "scanned": True},
            {"t": "00:06.4", "description": "red wine bottle", "scanned": False, "box_2d": [300, 600, 640, 700]},
            {"t": "00:08.0", "description": "chips packet", "scanned": True},
        ],
        "timeline": [{"t": "00:06.4", "event": "wine bottle moved beside the scanner"}],
        "reason": "The wine bottle went around the scanner.",
    }
    base.update(overrides)
    return json.dumps(base)


def camera(repo, camera_id):
    return next(c for c in repo.cameras() if c.id == camera_id)


def run(repo, gateway, settings, camera_id="cam-sco-2", transaction=None):
    return list(investigate(CLIP, "video/webm", camera(repo, camera_id), transaction, repo, gateway, settings))


def test_checkout_scan_avoidance_end_to_end(repo, settings):
    txn = repo.get_transaction("TXN-L2-2041")
    gateway = FakeGateway([call("get_pos_transaction", lane_id="L2"), text("wine skipped"), text(verdict_json())])

    events = run(repo, gateway, settings, transaction=txn)

    steps = [e.get("step") for e in events if e["type"] == "progress"]
    assert steps == ["watching", "tool", "report"]
    result = events[-1]
    assert result["type"] == "result" and result["cached"] is False
    incident = result["incident"]
    assert incident["status"] == "NEEDS_REVIEW"
    assert incident["transaction_id"] == "TXN-L2-2041"
    assert [u["matched_sku"] for u in incident["unscanned_items"]] == ["SKU-0005"]
    assert incident["est_loss_inr"] == 1850
    assert incident["tool_calls"][0]["name"] == "get_pos_transaction"
    assert repo.get_incident(incident["id"]) is not None
    assert all(c[0] == "test-model" for c in gateway.calls)


def test_same_clip_is_served_from_cache_without_calling_gemini(repo, settings):
    txn = repo.get_transaction("TXN-L2-2041")
    first = run(repo, FakeGateway([text("notes"), text(verdict_json())]), settings, transaction=txn)
    second_gateway = FakeGateway([])

    second = run(repo, second_gateway, settings, transaction=txn)

    assert second[-1]["cached"] is True
    assert second[-1]["incident"]["id"] == first[-1]["incident"]["id"]
    assert second_gateway.calls == []


def test_receipt_is_fetched_even_if_model_skips_the_tool(repo, settings):
    gateway = FakeGateway([text("all scanned"), text(verdict_json(verdict="BENIGN", items_scanned=4))])

    events = run(repo, gateway, settings)

    incident = events[-1]["incident"]
    assert incident["tool_calls"][0]["name"] == "get_pos_transaction"
    assert incident["status"] == "REJECTED"
    assert incident["unscanned_items"] == [] and incident["est_loss_inr"] == 0
    assert incident["receipt"], "latest seeded Lane 2 receipt should be attached"


def test_invalid_json_is_re_asked_once(repo, settings):
    gateway = FakeGateway([text("notes"), text("{not json"), text(verdict_json())])

    events = run(repo, gateway, settings)

    assert events[-1]["incident"]["verdict"]["verdict"] == "SCAN_AVOIDANCE"
    assert len(gateway.calls) == 3


def test_invalid_json_twice_becomes_inconclusive(repo, settings):
    gateway = FakeGateway([text("notes"), text("nope"), text("still nope")])

    events = run(repo, gateway, settings)

    incident = events[-1]["incident"]
    assert incident["verdict"]["verdict"] == "INCONCLUSIVE"
    assert incident["status"] == "NEEDS_REVIEW"


def test_gemini_outage_yields_an_error_event(repo, settings):
    gateway = FakeGateway([GeminiUnavailable("quota reached", 429)])

    events = run(repo, gateway, settings)

    assert events[-1] == {"type": "error", "message": "quota reached"}


def test_tool_calls_are_capped(repo, settings):
    many = GenResult(function_calls=[FunctionCall("get_sku_price", {"description": "wine"})] * 10)
    gateway = FakeGateway([many, text("budget used, notes"), text(verdict_json())])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4")

    assert len(events[-1]["incident"]["tool_calls"]) == settings.agent_max_tool_calls


def test_floor_concealment_prices_the_hidden_item(repo, settings):
    concealment = verdict_json(
        verdict="CONCEALMENT", items_seen=1, items_scanned=0,
        seen_items=[{"t": "00:03.4", "description": "whisky bottle", "scanned": False}],
    )
    gateway = FakeGateway([call("get_zone_policy", zone_id="z-spirits"), text("into jacket"), text(concealment)])

    events = run(repo, gateway, settings, camera_id="cam-aisle-4")

    incident = events[-1]["incident"]
    assert incident["camera_kind"] == "floor" and incident["receipt"] == []
    assert incident["est_loss_inr"] == 2400


def test_normalise_mime():
    assert normalise_mime("video/webm;codecs=vp9") == "video/webm"
    assert normalise_mime("video/quicktime") == "video/mov"
    assert normalise_mime("image/png") is None
