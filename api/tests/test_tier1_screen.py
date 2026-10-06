from conftest import FakeGateway, text
from test_api import meta_header, sse_events
from test_floor_rule import floor_json

from app import main

HINT = {"t": "00:04.1", "kind": "CONCEALMENT", "score": 0.7, "detail": "Item went into a jacket pocket",
        "confidence": 0.62, "camera_id": "cam-aisle-4"}


def investigate(api, **meta):
    res = api.post(
        "/api/investigate",
        files=[("clip", ("clip.webm", b"same-clip", "video/webm"))],
        headers={"x-shrinksight-meta": meta_header(camera_id="cam-aisle-4", **meta)},
    )
    return sse_events(res.text)[-1]


def test_a_screened_upload_records_the_tier1_result_and_its_hints(api):
    main.app.state.gateway = FakeGateway([text(floor_json(came_from="shelf", ended_in="in_hand"))])

    event = investigate(api, origin="upload", tier1_screen="flagged", tier1_events=[HINT])

    assert event["type"] == "result"
    incident = event["incident"]
    assert incident["tier1_screen"] == "flagged"
    assert incident["origin"] == "upload"
    assert incident["edge_confidence"] == 0.62
    prompt = main.app.state.gateway.calls[0][1][0].parts[-1].text
    assert "00:04.1" in prompt


def test_sending_anyway_is_a_fresh_analysis_not_the_screened_cache(api):
    main.app.state.gateway = FakeGateway([text(floor_json(came_from="shelf", ended_in="in_hand"))] * 3)

    plain = investigate(api, origin="upload")
    again = investigate(api, origin="upload", tier1_screen="cleared")

    assert plain["incident"].get("tier1_screen") is None
    assert again["cached"] is False
    assert again["incident"]["tier1_screen"] == "cleared"


def test_an_unknown_screen_value_is_rejected(api):
    res = api.post(
        "/api/investigate",
        files=[("clip", ("clip.webm", b"x", "video/webm"))],
        headers={"x-shrinksight-meta": meta_header(camera_id="cam-aisle-4", tier1_screen="maybe")},
    )
    assert res.status_code in (400, 422)
