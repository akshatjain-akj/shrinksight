from dataclasses import replace
from datetime import UTC, datetime

from conftest import FakeGateway, text
from test_investigator import CLIP, camera, verdict_json

from app import quota
from app.gemini import GeminiUnavailable, _daily_quota
from app.investigator import investigate

TXN = "TXN-L2-2041"


def run(repo, gateway, settings, clip=CLIP):
    cam = camera(repo, "cam-sco-2")
    return list(investigate(clip, "video/webm", cam, repo.get_transaction(TXN), repo, gateway, settings))


def with_backup(settings):
    return replace(settings, investigator_model="main-model", fallback_models=("backup-model",))


def test_a_used_up_daily_quota_is_recognised():
    class Err(Exception):
        details = {"error": {"details": [{"violations": [{"quotaId": "GenerateRequestsPerDayPerProjectPerModel"}]}]}}

    assert _daily_quota(Err("429 RESOURCE_EXHAUSTED")) is True
    assert _daily_quota(Exception("429 GenerateRequestsPerMinutePerProjectPerModel")) is False


def test_daily_quota_switches_to_the_backup_and_later_requests_start_there(repo, settings):
    s = with_backup(settings)
    gateway = FakeGateway([GeminiUnavailable("quota", 429, daily=True), text(verdict_json()), text(verdict_json())])

    first = run(repo, gateway, s)
    second = run(repo, gateway, s, clip=CLIP + b"-another-clip")

    assert [call[0] for call in gateway.calls] == ["main-model", "backup-model", "backup-model"]
    assert first[-1]["incident"]["fallback_from"] == "main-model"
    assert first[-1]["incident"]["model"] == "backup-model"
    assert any(e.get("step") == "fallback" and "out of quota" in e["label"] for e in second)
    until = quota.resting_until(repo, "main-model")
    assert until is not None and datetime.fromtimestamp(until, UTC).hour in (7, 8)  # midnight Pacific


def test_a_backup_answer_is_not_cached_so_the_main_model_answers_once_back(repo, settings):
    s = with_backup(settings)
    run(repo, FakeGateway([GeminiUnavailable("quota", 429, daily=True), text(verdict_json())]), s)
    repo.cache_put("quota:main-model", {"until": 0})  # the quota has reset

    again = run(repo, FakeGateway([text(verdict_json())]), s)

    assert again[-1]["cached"] is False and again[-1]["incident"]["fallback_from"] is None
    assert run(repo, FakeGateway([]), s)[-1]["cached"] is True, "the main model's answer is cached"


def test_a_per_minute_limit_rests_the_model_for_about_a_minute(repo):
    exc = GeminiUnavailable("rate limited", 429, retry_after=7)
    until = quota.rest(repo, "main-model", exc, now=1000.0)
    assert until == 1060.0
    assert quota.usable(repo, ["main-model", "backup-model"], now=1030.0) == ["backup-model"]
    assert quota.usable(repo, ["main-model", "backup-model"], now=1061.0) == ["main-model", "backup-model"]


def test_when_every_model_is_resting_the_whole_chain_is_tried(repo):
    for model in ("main-model", "backup-model"):
        quota.rest(repo, model, GeminiUnavailable("quota", 429, daily=True), now=1000.0)
    assert quota.usable(repo, ["main-model", "backup-model"], now=1001.0) == ["main-model", "backup-model"]


def test_a_normal_answer_records_no_fallback(repo, settings):
    events = run(repo, FakeGateway([text(verdict_json())]), with_backup(settings))
    assert events[-1]["incident"]["fallback_from"] is None
    assert quota.resting_until(repo, "main-model") is None
