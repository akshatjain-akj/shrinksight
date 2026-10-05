from fastapi.testclient import TestClient

from app import main, selftest
from app.config import Settings

client = TestClient(main.app)


def test_healthz_is_ok_and_makes_no_external_calls():
    res = client.get("/api/healthz")
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["service"] == "shrinksight-api"


def test_selftest_aggregates_each_check(monkeypatch):
    ok = {"ok": True, "detail": "fine", "ms": 1}
    bad = {"ok": False, "detail": "boom", "ms": 1}
    monkeypatch.setattr(selftest, "check_firestore", lambda s: ok)
    monkeypatch.setattr(selftest, "check_storage", lambda s: ok)
    monkeypatch.setattr(selftest, "check_gemini", lambda s: bad)
    monkeypatch.setattr(selftest, "check_models", lambda s: ok)

    body = client.get("/api/selftest").json()

    assert body["ok"] is False
    assert body["checks"]["firestore"]["ok"] is True
    assert body["checks"]["gemini"]["detail"] == "boom"


def test_gemini_check_reports_missing_key_without_raising():
    result = selftest.check_gemini(Settings(gemini_api_key=""))
    assert result["ok"] is False
    assert "GEMINI_API_KEY" in result["detail"]


def test_storage_check_reports_missing_bucket_without_raising():
    result = selftest.check_storage(Settings(evidence_bucket=""))
    assert result["ok"] is False
    assert "EVIDENCE_BUCKET" in result["detail"]
