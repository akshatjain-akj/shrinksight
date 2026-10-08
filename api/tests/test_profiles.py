import time

from app import profiles
from app.config import Settings
from app.main import app, get_repo
from app.profiles import LOGIN_FAILS_MAX, LOGIN_WINDOW_S, REMEMBER_TTL_S, TOKEN_TTL_S
from app.seed import DEMO_EMAIL, SEED_PASSWORD


def _secret() -> Settings:
    return Settings(auth_secret="test-secret")


def test_unknown_email_and_wrong_password_are_rejected(api):
    app.state.settings = _secret()

    unknown = api.post("/api/session", json={"email": "other@example.com", "password": SEED_PASSWORD})
    wrong = api.post("/api/session", json={"email": "skcorinva@gmail.com", "password": "nope-nope"})

    assert unknown.status_code == 401
    assert wrong.status_code == 401


def test_user_cannot_change_rules_or_layouts_and_manager_can(api):
    app.state.settings = _secret()

    user = api.post("/api/session", json={"email": "Skcorinva@gmail.com", "password": SEED_PASSWORD})
    assert user.status_code == 200
    assert user.json()["role"] == "user"
    user_headers = {"authorization": f"Bearer {user.json()['token']}"}

    blocked = api.post(
        "/api/rules",
        headers=user_headers,
        json={
            "source_text": "Alert if someone stays at the spirits shelf",
            "spec": {"supported": True, "type": "DWELL", "zone_id": "z-spirits", "min_seconds": 45, "summary": "dwell"},
        },
    )
    assert blocked.status_code == 403

    manager = api.post("/api/session", json={"email": "avni.rocks17@gmail.com", "password": SEED_PASSWORD})
    assert manager.json()["role"] == "manager"
    manager_headers = {"authorization": f"Bearer {manager.json()['token']}"}
    missing = api.put("/api/layouts/not-a-camera", headers=manager_headers, json={"zones": []})
    assert missing.status_code == 404


def test_remember_me_issues_a_longer_token(api):
    app.state.settings = _secret()
    creds = {"email": "skcorinva@gmail.com", "password": SEED_PASSWORD}

    before = int(time.time())
    short = api.post("/api/session", json=creds).json()
    long = api.post("/api/session", json={**creds, "remember": True}).json()

    assert before + TOKEN_TTL_S <= short["exp"] <= before + TOKEN_TTL_S + 5
    assert before + REMEMBER_TTL_S <= long["exp"] <= before + REMEMBER_TTL_S + 5
    ok = api.get("/api/incidents", headers={"authorization": f"Bearer {long['token']}"})
    assert ok.status_code == 200


def test_profiles_stay_off_without_a_signing_secret(api):
    missing = api.post("/api/session", json={"email": "skcorinva@gmail.com", "password": SEED_PASSWORD})
    assert missing.status_code == 503


def test_manager_can_change_a_role_and_the_last_manager_stays(api):
    app.state.settings = _secret()
    manager = api.post("/api/session", json={"email": "akshat.gms@gmail.com", "password": SEED_PASSWORD}).json()
    headers = {"authorization": f"Bearer {manager['token']}"}

    people = api.get("/api/users", headers=headers)
    assert people.status_code == 200
    assert "password_hash" not in people.text
    attendant = next(item for item in people.json() if item["email"] == "skcorinva@gmail.com")

    promoted = api.patch(f"/api/users/{attendant['id']}", headers=headers, json={"role": "manager"})
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "manager"

    roster = api.get("/api/users", headers=headers).json()
    akshat = next(item for item in roster if item["email"] == "akshat.gms@gmail.com")
    avni = next(item for item in roster if item["email"] == "avni.rocks17@gmail.com")

    avni_headers = {
        "authorization": "Bearer "
        + api.post("/api/session", json={"email": "avni.rocks17@gmail.com", "password": SEED_PASSWORD}).json()["token"]
    }
    assert api.patch(f"/api/users/{akshat['id']}", headers=avni_headers, json={"role": "user"}).status_code == 200

    attendant_headers = {
        "authorization": "Bearer "
        + api.post("/api/session", json={"email": "skcorinva@gmail.com", "password": SEED_PASSWORD}).json()["token"]
    }
    assert api.patch(f"/api/users/{avni['id']}", headers=attendant_headers, json={"role": "user"}).status_code == 200
    # The demo manager always stays, so take it out to test the last-manager rule on its own.
    repo = get_repo()
    demo = repo.get_user_by_email(DEMO_EMAIL)
    demo.enabled = False
    repo.save_user(demo)
    last = api.patch(f"/api/users/{attendant['id']}", headers=attendant_headers, json={"role": "user"})
    assert last.status_code == 400


def _google(email: str, verified: bool = True, provider: str = "google.com") -> dict:
    return {"email": email, "email_verified": verified, "firebase": {"sign_in_provider": provider}}


def test_google_sign_in_works_only_for_roster_members(api):
    app.state.settings = Settings(auth_secret="test-secret", gcp_project="test-project")
    claims = {
        "tok-member-0000000000": _google("Skcorinva@gmail.com"),
        "tok-stranger-00000000": _google("stranger@example.com"),
        "tok-unverified-000000": _google("skcorinva@gmail.com", verified=False),
        "tok-password-00000000": _google("skcorinva@gmail.com", provider="password"),
    }

    def verifier(token: str) -> dict:
        if token not in claims:
            raise ValueError("bad signature")
        return claims[token]

    app.state.google_verifier = verifier
    try:
        member = api.post("/api/session/google", json={"id_token": "tok-member-0000000000", "remember": True})
        assert member.status_code == 200
        assert member.json()["email"] == "skcorinva@gmail.com"
        assert member.json()["role"] == "user"
        assert member.json()["exp"] >= int(time.time()) + REMEMBER_TTL_S - 5

        for token in ("tok-stranger-00000000", "tok-unverified-000000", "tok-password-00000000"):
            assert api.post("/api/session/google", json={"id_token": token}).status_code == 403
        assert api.post("/api/session/google", json={"id_token": "tok-forged-0000000000"}).status_code == 401
    finally:
        app.state.google_verifier = None


def test_ten_failed_sign_ins_lock_that_email_for_the_window(api):
    app.state.settings = _secret()
    wrong = {"email": "skcorinva@gmail.com", "password": "nope-nope"}

    for _ in range(LOGIN_FAILS_MAX):
        assert api.post("/api/session", json=wrong).status_code == 401

    locked = api.post("/api/session", json={**wrong, "password": SEED_PASSWORD})
    assert locked.status_code == 429
    assert 0 < int(locked.headers["retry-after"]) <= LOGIN_WINDOW_S + 1

    other = api.post("/api/session", json={"email": "avni.rocks17@gmail.com", "password": SEED_PASSWORD})
    assert other.status_code == 200


def test_successful_sign_ins_do_not_count_towards_the_lock(api):
    app.state.settings = _secret()
    creds = {"email": "skcorinva@gmail.com", "password": SEED_PASSWORD}
    for _ in range(LOGIN_FAILS_MAX + 2):
        assert api.post("/api/session", json=creds).status_code == 200


def test_unknown_email_still_runs_the_password_hash(api, monkeypatch):
    app.state.settings = _secret()
    calls = []
    real = profiles.hash_password
    monkeypatch.setattr(profiles, "hash_password", lambda password, salt: calls.append(salt) or real(password, salt))

    assert api.post("/api/session", json={"email": "nobody@example.com", "password": "whatever"}).status_code == 401
    assert len(calls) == 1
