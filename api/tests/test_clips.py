from fastapi.testclient import TestClient

from app import main

client = TestClient(main.app)


def test_unknown_camera_has_no_clip():
    res = client.get("/api/clips/cam-sco-1")
    assert res.status_code == 404


def test_aisle_clip_returns_the_signer_url(monkeypatch):
    monkeypatch.setattr(main.app.state, "clip_signer", lambda camera_id: f"https://example.test/{camera_id}")
    res = client.get("/api/clips/cam-aisle-4")
    assert res.status_code == 200
    body = res.json()
    assert body["url"] == "https://example.test/cam-aisle-4"
    assert body["expires_in"] == 900
    assert body["camera_id"] == "cam-aisle-4"


def test_signing_failure_is_a_503(monkeypatch):
    def boom(_camera_id: str) -> str:
        raise RuntimeError("no key")

    monkeypatch.setattr(main.app.state, "clip_signer", boom)
    res = client.get("/api/clips/cam-aisle-4")
    assert res.status_code == 503
