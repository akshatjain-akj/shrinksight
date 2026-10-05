from dataclasses import replace

from conftest import FakeGateway, text
from test_api import meta_header, sse_events
from test_investigator import run, verdict_json

from app import edge_tuning, main, memory
from app.gemini import GenResult, add_usage
from app.models import Feedback, Incident

JPEG = b"\xff\xd8\xff\xd9"


def with_usage(value: str, total=1000) -> GenResult:
    return GenResult(text=value, usage={"input": total - 100, "output": 80, "thinking": 20, "total": total})


def feedback(incident_id, decision, reviewed_at, reason=None, camera_id="cam-sco-2"):
    return Feedback(incident_id=incident_id, camera_id=camera_id, decision=decision, reason=reason,
                    verdict="SCAN_AVOIDANCE", summary="something happened", reviewed_at=reviewed_at)


# ---------- token usage ----------
def test_tokens_are_summed_over_the_watch_and_the_recheck(repo, settings):
    contradicting = verdict_json(verdict="SCAN_AVOIDANCE", seen_items=[], items_seen=0, items_scanned=0)
    gateway = FakeGateway([with_usage(contradicting, 1000), with_usage(verdict_json(), 400)])

    events = run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"))

    usage = events[-1]["incident"]["usage"]
    assert usage == {"input": 1200, "output": 160, "thinking": 40, "total": 1400, "calls": 2}


def test_add_usage_ignores_calls_without_counts():
    assert add_usage({}, {}) == {}
    assert add_usage({}, {"input": 5, "total": 5})["calls"] == 1


# ---------- per-camera memory ----------
def test_pick_balances_dismissals_and_confirmations():
    items = [feedback(f"d{i}", "dismiss", f"2026-10-0{i}T00:00:00Z") for i in range(1, 6)]
    items += [feedback(f"c{i}", "confirm", f"2026-10-0{i}T01:00:00Z") for i in range(1, 4)]

    chosen = memory.pick(items, 5)

    assert [f.incident_id for f in chosen] == ["d5", "d4", "c3", "d3", "c2"]
    assert memory.pick(items, 0) == []


def test_memory_goes_into_the_prompt_and_is_recorded(repo, settings):
    gateway = FakeGateway([text(verdict_json(similar_past_case="Like the 4 Oct personal phone case"))])
    past = [feedback("inc-old-1", "dismiss", "2026-10-04T10:00:00Z", "personal_item")]

    events = run(repo, gateway, settings, transaction=repo.get_transaction("TXN-L2-2041"), memory=past)

    briefing = gateway.calls[0][1][0].parts[-1].text
    assert "past review decisions on this camera" in briefing and "DISMISSED" in briefing
    assert "personal item" in briefing
    assert "memory" in [e["step"] for e in events if e["type"] == "progress"]
    incident = events[-1]["incident"]
    assert [m["incident_id"] for m in incident["memory_used"]] == ["inc-old-1"]
    assert incident["verdict"]["similar_past_case"].startswith("Like the 4 Oct")


def test_memory_never_overrides_the_receipt_check(repo, settings):
    # Gemini leans on a past dismissal and says BENIGN, but an unpaid item ended in the bag.
    benign = verdict_json(verdict="BENIGN", seen_items=[
        {"t": "00:01.0", "description": "milk carton", "scanned": True, "receipt_line": 1},
        {"t": "00:03.0", "description": "bread loaf", "scanned": True, "receipt_line": 2},
        {"t": "00:05.0", "description": "chips packet", "scanned": True, "receipt_line": 3},
        {"t": "00:06.4", "description": "red wine bottle", "scanned": False, "ended_in": "bag"},
    ])
    past = [feedback("inc-old-1", "dismiss", "2026-10-04T10:00:00Z", "bagging")]

    # The answer contradicts the receipt, so the usual one re-check happens (and says the same).
    events = run(repo, FakeGateway([text(benign), text(benign)]), settings,
                 transaction=repo.get_transaction("TXN-L2-2041"), memory=past)

    incident = events[-1]["incident"]
    assert incident["verdict"]["verdict"] == "SCAN_AVOIDANCE" and incident["overridden"] is True


def test_new_feedback_changes_the_cache_key(repo, settings):
    gateway = FakeGateway([text(verdict_json()), text(verdict_json())])
    txn = repo.get_transaction("TXN-L2-2041")

    run(repo, gateway, settings, transaction=txn)
    again = run(repo, gateway, settings, transaction=txn,
                memory=[feedback("inc-old-1", "dismiss", "2026-10-04T10:00:00Z")])

    assert len(gateway.calls) == 2 and again[-1]["cached"] is False


def test_memory_can_be_turned_off(repo, settings):
    gateway = FakeGateway([text(verdict_json())])
    run(repo, gateway, replace(settings, memory_examples=0), transaction=repo.get_transaction("TXN-L2-2041"),
        memory=[feedback("inc-old-1", "dismiss", "2026-10-04T10:00:00Z")])
    assert "past review decisions" not in gateway.calls[0][1][0].parts[-1].text


def test_review_with_a_reason_becomes_camera_memory(api):
    res = api.post("/api/incidents/inc-seed-001/review",
                   json={"decision": "dismiss", "reason": "personal_item", "note": "own phone"})

    assert res.status_code == 200 and res.json()["review_reason"] == "personal_item"
    saved = api.repo.feedback("cam-sco-2")
    assert saved[0].incident_id == "inc-seed-001" and saved[0].note == "own phone"
    assert saved[0].items == ["green glass wine bottle"]
    bad = api.post("/api/incidents/inc-seed-001/review", json={"decision": "dismiss", "reason": "missed_scan"})
    assert bad.status_code == 422


def test_seeded_lane_1_memory_reaches_gemini(api):
    main.app.state.gateway = FakeGateway([text(verdict_json())] * 2)
    res = api.post("/api/investigate", content=b"video-bytes",
                   headers={"content-type": "video/webm",
                            "x-shrinksight-meta": meta_header(camera_id="cam-sco-1", transaction_id="TXN-L1-1001")})

    incident = sse_events(res.text)[-1]["incident"]
    assert {m["incident_id"] for m in incident["memory_used"]} == {"inc-seed-005", "inc-seed-006"}


# ---------- scanner reference photo ----------
def test_scanner_photo_saved_per_camera_and_used_automatically(api):
    assert api.get("/api/cameras/cam-sco-2/scanner-photo").status_code == 404
    assert api.put("/api/cameras/cam-sco-2/scanner-photo", content=b"png?").status_code == 415
    assert api.put("/api/cameras/cam-sco-2/scanner-photo", content=JPEG).status_code == 200
    assert api.get("/api/cameras/cam-sco-2/scanner-photo").content == JPEG
    assert "cam-sco-2" in api.get("/api/scanner-photos").json()

    main.app.state.gateway = FakeGateway([text(verdict_json())])
    res = api.post("/api/investigate", content=b"video-bytes",
                   headers={"content-type": "video/webm",
                            "x-shrinksight-meta": meta_header(camera_id="cam-sco-2", transaction_id="TXN-L2-2041")})

    assert sse_events(res.text)[-1]["incident"]["scanner_photo"] == "saved"
    texts = [p.text for p in main.app.state.gateway.calls[0][1][0].parts if p.text]
    assert any(t.startswith("Reference photo: this store's scanning device") for t in texts)

    assert api.delete("/api/cameras/cam-sco-2/scanner-photo").status_code == 200
    assert api.get("/api/cameras/cam-sco-2/scanner-photo").status_code == 404


def test_scanner_photo_uploaded_with_the_clip_wins_and_can_be_skipped(api):
    api.put("/api/cameras/cam-sco-2/scanner-photo", content=JPEG + b"saved")
    clip_photo = JPEG + b"clip"
    main.app.state.gateway = FakeGateway([text(verdict_json()), text(verdict_json())])

    res = api.post("/api/investigate",
                   files=[("clip", ("clip.webm", b"video-bytes", "video/webm")),
                          ("still", ("scanner_ref.jpg", clip_photo, "image/jpeg"))],
                   headers={"x-shrinksight-meta": meta_header(camera_id="cam-sco-2", transaction_id="TXN-L2-2041")})
    assert sse_events(res.text)[-1]["incident"]["scanner_photo"] == "clip"
    images = [p.inline_data.data for p in main.app.state.gateway.calls[0][1][0].parts if p.inline_data
              and p.inline_data.mime_type == "image/jpeg"]
    assert images == [clip_photo]

    res = api.post("/api/investigate", content=b"other-video",
                   headers={"content-type": "video/webm",
                            "x-shrinksight-meta": meta_header(camera_id="cam-sco-2", transaction_id="TXN-L2-2041",
                                                              scanner_photo="none")})
    assert sse_events(res.text)[-1]["incident"]["scanner_photo"] is None


# ---------- self-calibrating edge gate ----------
def edge_incident(repo, n, status, confidence=0.6, camera_id="cam-aisle-2"):
    base = repo.get_incident("inc-seed-003")
    return base.model_copy(update={"id": f"inc-edge-{n}", "created_at": f"2026-10-05T10:{n:02d}:00Z",
                                   "camera_id": camera_id, "status": status, "origin": "edge",
                                   "edge_confidence": confidence})


def test_gate_gets_stricter_after_mostly_false_alarms(repo, settings):
    for n in range(8):
        repo.save_incident(edge_incident(repo, n, "REJECTED" if n < 6 else "NEEDS_REVIEW"))

    changed = edge_tuning.retune(repo, "cam-aisle-2", settings)

    assert changed is not None and changed.level == 1 and changed.hot_frames == 10
    assert "6 of the last 8" in changed.reason
    assert repo.get_edge_config("cam-aisle-2").send_score == 0.45
    assert edge_tuning.retune(repo, "cam-aisle-2", settings) is None, "a change starts a fresh window"


def test_gate_waits_for_enough_alerts_and_respects_near_misses(repo, settings):
    for n in range(5):
        repo.save_incident(edge_incident(repo, n, "REJECTED"))
    assert edge_tuning.retune(repo, "cam-aisle-2", settings) is None

    for n in range(5, 7):
        repo.save_incident(edge_incident(repo, n, "REJECTED"))
    repo.save_incident(edge_incident(repo, 7, "RESOLVED_CONFIRMED", confidence=0.5))
    assert edge_tuning.retune(repo, "cam-aisle-2", settings) is None, "a confirmed theft near the new bar blocks it"


def test_gate_relaxes_and_undo_restores(repo, settings):
    repo.save_edge_config(edge_tuning.config_for("cam-aisle-2", 2, since="2026-10-05T09:00:00Z"))
    for n in range(8):
        repo.save_incident(edge_incident(repo, n, "NEEDS_REVIEW"))

    assert edge_tuning.retune(repo, "cam-aisle-2", settings).level == 1
    undone = edge_tuning.undo(repo, "cam-aisle-2")
    assert undone.level == 2 and undone.reason == "Undone by staff."


def test_upload_incidents_never_tune_the_edge(repo, settings):
    for n in range(10):
        repo.save_incident(edge_incident(repo, n, "REJECTED").model_copy(update={"origin": "upload"}))
    assert edge_tuning.retune(repo, "cam-aisle-2", settings) is None


def test_edge_investigation_and_dismissal_retune_the_camera(api):
    main.app.state.settings = replace(main.app.state.settings, edge_tune_min_alerts=2)
    benign = text(verdict_json(verdict="BENIGN", seen_items=[], items_seen=0, items_scanned=0))
    main.app.state.gateway = FakeGateway([benign, benign])
    event = {"t": "00:02.0", "kind": "CONCEALMENT", "score": 0.7, "confidence": 0.62}
    for n in range(2):
        api.post("/api/investigate", content=f"clip-{n}".encode(),
                 headers={"content-type": "video/webm",
                          "x-shrinksight-meta": meta_header(camera_id="cam-aisle-2", origin="edge",
                                                            tier1_events=[event])})

    config = api.get("/api/edge-config/cam-aisle-2").json()
    assert config["level"] == 1 and config["alerts"] == 2
    latest = api.repo.incidents(1)[0]
    assert latest.origin == "edge" and latest.edge_confidence == 0.62
    assert api.post("/api/edge-config/cam-aisle-2/undo").json()["level"] == 0
    assert api.get("/api/edge-config/cam-nope").status_code == 404


def test_incident_without_new_fields_still_loads(repo):
    doc = repo.get_incident("inc-seed-001").model_dump()
    for key in ("origin", "usage", "memory_used", "scanner_photo", "review_reason"):
        doc.pop(key)
    assert Incident(**doc).memory_used == []
