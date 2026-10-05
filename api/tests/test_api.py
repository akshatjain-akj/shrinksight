import base64
import json
from dataclasses import replace

from conftest import FakeGateway, text
from test_investigator import verdict_json

from app import main


def meta_header(**meta) -> str:
    return base64.urlsafe_b64encode(json.dumps(meta).encode()).decode().rstrip("=")


def sse_events(body: str) -> list[dict]:
    return [json.loads(line[len("data: "):]) for line in body.splitlines() if line.startswith("data: ")]


def test_store_lists_cameras_and_zones(api):
    body = api.get("/api/store").json()
    assert body["currency"] == "INR"
    assert {c["id"] for c in body["cameras"]} == {"cam-sco-1", "cam-sco-2", "cam-aisle-4", "cam-aisle-2"}
    assert any(z["id"] == "z-spirits" and z["high_value"] for z in body["zones"])


def test_transactions_filter_by_lane(api):
    lanes = {t["lane_id"] for t in api.get("/api/transactions", params={"lane_id": "L2"}).json()}
    assert lanes == {"L2"}


def test_incidents_newest_first_and_detail(api):
    items = api.get("/api/incidents").json()
    assert items[0]["id"] == "inc-seed-001"
    assert api.get("/api/incidents/inc-seed-002").json()["verdict"]["verdict"] == "CONCEALMENT"
    assert api.get("/api/incidents/nope").status_code == 404


def test_review_confirms_an_incident(api):
    res = api.post("/api/incidents/inc-seed-001/review", json={"decision": "confirm"})
    assert res.status_code == 200
    assert api.repo.get_incident("inc-seed-001").status == "RESOLVED_CONFIRMED"
    assert api.post("/api/incidents/inc-seed-001/review", json={"decision": "maybe"}).status_code == 422


def test_stats_from_seed(api):
    assert api.get("/api/stats").json() == {
        "investigated": 5,
        "flagged": 3,
        "false_alarms_rejected": 2,
        "needs_review": 2,
        "est_loss_caught_inr": 4900,
    }


def test_rule_compile_save_and_toggle(api):
    spec = {"supported": True, "type": "ZONE_ENTRY", "zone_id": "z-exit", "active_from": "22:00",
            "active_to": "07:00", "severity": "HIGH", "summary": "Anyone at the exit 22:00–07:00"}
    main.app.state.gateway = FakeGateway([text(json.dumps(spec))])

    compiled = api.post("/api/rules/compile", json={"text": "Alert if anyone is at the exit after 10pm"}).json()
    assert compiled["problems"] == []

    created = api.post("/api/rules", json={"source_text": "exit after 10pm", "spec": compiled["spec"]})
    assert created.status_code == 201
    rule_id = created.json()["id"]
    assert api.patch(f"/api/rules/{rule_id}", json={"enabled": False}).json()["enabled"] is False
    assert len(api.get("/api/rules").json()) == 2


def test_rule_with_unknown_zone_cannot_be_saved(api):
    spec = {"supported": True, "type": "DWELL", "zone_id": "z-nope", "min_seconds": 30, "summary": "x"}
    assert api.post("/api/rules", json={"source_text": "something", "spec": spec}).status_code == 400


def test_investigate_streams_progress_then_result(api):
    main.app.state.gateway = FakeGateway([text(verdict_json())])
    receipt = [{"name": "Toned milk 1L", "price_inr": 68}, {"name": "Whole wheat bread", "price_inr": 50},
               {"name": "Potato chips 150g packet", "price_inr": 50}]

    res = api.post(
        "/api/investigate",
        content=b"video-bytes",
        headers={"content-type": "video/webm;codecs=vp9",
                 "x-shrinksight-meta": meta_header(camera_id="cam-sco-2", receipt=receipt)},
    )

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    events = sse_events(res.text)
    assert [e["type"] for e in events][-1] == "result"
    incident = events[-1]["incident"]
    assert [line["name"] for line in incident["receipt"]] == [
        "Toned milk 1L", "Whole wheat bread", "Potato chips 150g packet"
    ]
    assert incident["verdict"]["items_scanned"] == 3 and incident["est_loss_inr"] == 1850
    assert incident["transaction_id"].startswith("TXN-LIVE-")


def test_investigate_rejects_bad_requests(api):
    good_meta = meta_header(camera_id="cam-sco-2")
    assert api.post("/api/investigate", content=b"x",
                    headers={"content-type": "image/png", "x-shrinksight-meta": good_meta}).status_code == 415
    assert api.post("/api/investigate", content=b"x",
                    headers={"content-type": "video/mp4", "x-shrinksight-meta": "!!"}).status_code == 400
    assert api.post("/api/investigate", content=b"x",
                    headers={"content-type": "video/mp4",
                             "x-shrinksight-meta": meta_header(camera_id="cam-nope")}).status_code == 400


def test_investigate_accepts_marked_stills(api):
    main.app.state.gateway = FakeGateway([text(verdict_json(verdict="BENIGN", seen_items=[], items_seen=0,
                                                            items_scanned=0))])
    jpeg = b"\xff\xd8\xff\xd9"
    res = api.post(
        "/api/investigate",
        files=[
            ("clip", ("clip.webm", b"video-bytes", "video/webm")),
            ("still", ("before.jpg", jpeg, "image/jpeg")),
            ("still", ("reach.jpg", jpeg, "image/jpeg")),
            ("still", ("hold.jpg", jpeg, "image/jpeg")),
            ("still", ("after.jpg", b"not-a-jpeg", "image/jpeg")),
        ],
        headers={"x-shrinksight-meta": meta_header(camera_id="cam-aisle-4")},
    )

    assert res.status_code == 200
    parts = main.app.state.gateway.calls[0][1][0].parts
    images = [part for part in parts if part.inline_data and part.inline_data.mime_type == "image/jpeg"]
    texts = [part.text for part in parts if part.text]
    assert len(images) == 3
    assert "Still: before" in texts
    assert "Still: after" not in texts


def test_investigate_rejects_oversized_clip(api):
    main.app.state.settings = replace(main.app.state.settings, max_clip_bytes=10)
    res = api.post("/api/investigate", content=b"x" * 11,
                   headers={"content-type": "video/mp4", "x-shrinksight-meta": meta_header(camera_id="cam-aisle-2")})
    assert res.status_code == 413


def test_per_ip_rate_limit(api):
    main.app.state.settings = replace(main.app.state.settings, per_ip_per_minute=1)
    spec = {"supported": False, "unsupported_reason": "no", "summary": "n/a"}
    main.app.state.gateway = FakeGateway([text(json.dumps(spec))])

    first = api.post("/api/rules/compile", json={"text": "first rule text"})
    second = api.post("/api/rules/compile", json={"text": "second rule text"})

    assert first.status_code == 200
    assert second.status_code == 429 and second.headers["retry-after"] == "60"
