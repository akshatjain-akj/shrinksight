from app.config import Settings
from app.main import app
from app.models import CameraLayout, ZoneHint, ZonePoint
from app.seed import SEED_PASSWORD

SQUARE = [ZonePoint(x=0.1, y=0.1), ZonePoint(x=0.4, y=0.1), ZonePoint(x=0.4, y=0.4)]


def _zone_ids(api, camera_id):
    store = api.get("/api/store").json()
    return next(c for c in store["cameras"] if c["id"] == camera_id)["zone_ids"]


def test_added_zone_joins_its_camera_and_delete_removes_it(api):
    created = api.post("/api/zones", json={"name": "Razor shelf", "camera_id": "cam-aisle-2", "kind": "shelf",
                                           "high_value": True})
    assert created.status_code == 201
    zone = created.json()
    assert zone["high_value"] and zone["id"] in _zone_ids(api, "cam-aisle-2")

    assert api.delete(f"/api/zones/{zone['id']}").status_code == 200
    assert zone["id"] not in _zone_ids(api, "cam-aisle-2")
    assert zone["id"] not in [z["id"] for z in api.get("/api/store").json()["zones"]]


def test_zone_for_an_unknown_camera_or_zone_is_404(api):
    assert api.post("/api/zones", json={"name": "Nowhere", "camera_id": "cam-nope", "kind": "shelf"}).status_code == 404
    assert api.delete("/api/zones/z-nope").status_code == 404


def test_zone_a_rule_uses_cannot_be_deleted_even_if_the_rule_is_off(api):
    assert api.delete("/api/zones/z-spirits").status_code == 400
    for rule in api.repo.rules():
        if rule.spec.zone_id == "z-spirits":
            api.repo.save_rule(rule.model_copy(update={"enabled": False}))
    assert api.delete("/api/zones/z-spirits").status_code == 400


def test_deleting_a_zone_drops_it_from_the_saved_layout(api):
    hints = [ZoneHint(zone_id=z, kind=k, polygon=SQUARE) for z, k in (("z-snacks", "shelf"), ("z-exit", "exit"))]
    api.repo.save_layout(CameraLayout(camera_id="cam-aisle-2", zones=hints, updated_at="2026-10-06T00:00:00Z"))

    assert api.delete("/api/zones/z-exit").status_code == 200
    assert [h.zone_id for h in api.repo.get_layout("cam-aisle-2").zones] == ["z-snacks"]


def test_camera_prefs_round_trip_and_limits(api):
    assert api.get("/api/cameras/cam-aisle-4/prefs").status_code == 404
    saved = api.put("/api/cameras/cam-aisle-4/prefs", json={"loitering": False, "loiter_seconds": 45})
    assert saved.status_code == 200
    got = api.get("/api/cameras/cam-aisle-4/prefs").json()
    assert got["camera_id"] == "cam-aisle-4" and got["loitering"] is False and got["loiter_seconds"] == 45
    assert api.put("/api/cameras/cam-aisle-4/prefs", json={"loiter_seconds": 5}).status_code == 422
    assert api.put("/api/cameras/cam-nope/prefs", json={}).status_code == 404


def test_camera_prefs_go_with_a_deleted_camera(api):
    api.put("/api/cameras/cam-aisle-4/prefs", json={"person": False})
    assert api.delete("/api/cameras/cam-aisle-4").status_code == 200
    assert api.repo.get_camera_prefs("cam-aisle-4") is None


def test_user_cannot_change_zones_or_prefs(api):
    app.state.settings = Settings(auth_secret="test-secret")
    user = api.post("/api/session", json={"email": "skcorinva@gmail.com", "password": SEED_PASSWORD})
    headers = {"authorization": f"Bearer {user.json()['token']}"}
    body = {"name": "Nope", "camera_id": "cam-aisle-2", "kind": "shelf"}
    assert api.post("/api/zones", headers=headers, json=body).status_code == 403
    assert api.delete("/api/zones/z-snacks", headers=headers).status_code == 403
    assert api.put("/api/cameras/cam-aisle-2/prefs", headers=headers, json={}).status_code == 403


def test_reseeding_keeps_added_zones_and_deleted_seed_zones_gone(api):
    added = api.post("/api/zones", json={"name": "Till exit", "camera_id": "cam-sco-1", "kind": "exit"}).json()
    assert api.delete("/api/zones/z-bag-1").status_code == 200

    api.repo.ensure_seeded()

    assert _zone_ids(api, "cam-sco-1") == ["z-pick-1", "z-scan-1", added["id"]]
