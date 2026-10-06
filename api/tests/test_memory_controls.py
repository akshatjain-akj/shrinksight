from app.config import Settings
from app.main import app
from app.seed import SEED_PASSWORD


def _an_incident(api, camera_id):
    return next(i for i in api.repo.incidents() if i.camera_id == camera_id)


def test_a_review_marked_not_to_remember_saves_no_camera_memory(api):
    incident = _an_incident(api, "cam-sco-2")
    before = len(api.repo.feedback("cam-sco-2"))

    res = api.post(f"/api/incidents/{incident.id}/review", json={"decision": "dismiss", "reason": "other",
                                                                "remember": False})

    assert res.status_code == 200 and res.json()["status"] == "RESOLVED_DISMISSED"
    assert incident.id not in [f.incident_id for f in api.repo.feedback("cam-sco-2")]
    assert len(api.repo.feedback("cam-sco-2")) <= before


def test_re_reviewing_as_not_remembered_drops_the_earlier_example(api):
    incident = _an_incident(api, "cam-sco-2")
    api.post(f"/api/incidents/{incident.id}/review", json={"decision": "confirm"})
    assert incident.id in [f.incident_id for f in api.repo.feedback("cam-sco-2")]

    api.post(f"/api/incidents/{incident.id}/review", json={"decision": "confirm", "remember": False})

    assert incident.id not in [f.incident_id for f in api.repo.feedback("cam-sco-2")]


def test_clearing_a_cameras_memory_forgets_its_decisions_only(api):
    for camera_id in ("cam-sco-2", "cam-aisle-4"):
        api.post(f"/api/incidents/{_an_incident(api, camera_id).id}/review", json={"decision": "confirm"})
    other = len(api.repo.feedback("cam-aisle-4"))
    assert api.get("/api/cameras/cam-sco-2/memory").json()["decisions"] >= 1

    cleared = api.delete("/api/cameras/cam-sco-2/memory").json()

    assert cleared["cleared"] >= 1
    assert api.get("/api/cameras/cam-sco-2/memory").json() == {"camera_id": "cam-sco-2", "decisions": 0,
                                                                "used_per_clip": 0}
    assert len(api.repo.feedback("cam-aisle-4")) == other
    # Seeded examples don't come back on the next request
    api.get("/api/store")
    assert api.repo.feedback("cam-sco-2") == []


def test_only_a_manager_can_clear_memory(api):
    app.state.settings = Settings(auth_secret="test-secret")
    user = api.post("/api/session", json={"email": "skcorinva@gmail.com", "password": SEED_PASSWORD})
    headers = {"authorization": f"Bearer {user.json()['token']}"}
    assert api.delete("/api/cameras/cam-sco-2/memory", headers=headers).status_code == 403
    assert api.delete("/api/cameras/cam-nope/memory").status_code in (401, 404)
