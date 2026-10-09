from app.config import Settings
from app.main import app
from app.seed import DEMO_EMAIL


def _settings(**extra) -> Settings:
    # Pinned so a developer's api/.env (DEMO_LOGIN, DEMO_CLIP_UPLOADS) can't change test results
    return Settings(**{"auth_secret": "test-secret", "demo_login": True, "demo_clip_uploads": True, **extra})


def test_enter_the_demo_store_signs_in_as_a_full_manager_without_a_password(api):
    app.state.settings = _settings()

    res = api.post("/api/session/demo")

    assert res.status_code == 200
    session = res.json()
    assert session["email"] == DEMO_EMAIL and session["role"] == "manager"
    headers = {"authorization": f"Bearer {session['token']}"}
    camera = api.post("/api/cameras", json={"name": "Judge cam", "kind": "floor"}, headers=headers)
    assert camera.status_code == 201
    assert api.get("/api/users", headers=headers).status_code == 200


def test_the_demo_login_can_be_switched_off_and_health_says_so(api):
    app.state.settings = _settings(demo_login=False)

    assert api.post("/api/session/demo").status_code == 404
    assert api.get("/api/healthz").json()["demo_login"] is False

    app.state.settings = _settings()
    assert api.get("/api/healthz").json()["demo_login"] is True


def test_the_demo_account_cannot_be_demoted_so_nobody_gets_locked_out(api):
    app.state.settings = _settings()
    headers = {"authorization": f"Bearer {api.post('/api/session/demo').json()['token']}"}
    demo = next(u for u in api.get("/api/users", headers=headers).json() if u["email"] == DEMO_EMAIL)

    res = api.patch(f"/api/users/{demo['id']}", json={"role": "user"}, headers=headers)

    assert res.status_code == 400
    assert "demo account stays a manager" in res.json()["detail"]
