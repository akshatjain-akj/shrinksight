from app.config import Settings
from app.main import app
from app.seed import SEED_PASSWORD


def test_manager_path_adds_checkout_camera_and_delete_removes_it(api):
    created = api.post("/api/cameras", json={"name": "Lane 9", "kind": "checkout", "lane_id": "l9"})
    assert created.status_code == 201
    camera = created.json()["camera"]
    assert camera["lane_id"] == "L9"
    assert len(created.json()["zones"]) == 3

    assert api.delete(f"/api/cameras/{camera['id']}").status_code == 200
    store = api.get("/api/store").json()
    assert camera["id"] not in [item["id"] for item in store["cameras"]]


def test_deleted_seed_camera_is_not_restored(api):
    assert api.delete("/api/cameras/cam-sco-1").status_code == 200
    store = api.get("/api/store").json()
    assert "cam-sco-1" not in [item["id"] for item in store["cameras"]]
    assert "z-scan-1" not in [item["id"] for item in store["zones"]]


def test_checkout_without_a_lane_is_rejected(api):
    assert api.post("/api/cameras", json={"name": "Lane", "kind": "checkout"}).status_code == 422


def test_user_cannot_add_or_delete_a_camera(api):
    app.state.settings = Settings(auth_secret="test-secret")
    user = api.post("/api/session", json={"email": "skcorinva@gmail.com", "password": SEED_PASSWORD})
    headers = {"authorization": f"Bearer {user.json()['token']}"}
    assert api.post("/api/cameras", headers=headers, json={"name": "Nope", "kind": "floor"}).status_code == 403
    assert api.delete("/api/cameras/cam-sco-2", headers=headers).status_code == 403
