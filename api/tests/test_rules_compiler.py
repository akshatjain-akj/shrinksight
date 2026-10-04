import json

from conftest import FakeGateway, text

from app.rules_compiler import compile_rule

DWELL = {
    "supported": True,
    "type": "DWELL",
    "zone_id": "z-spirits",
    "min_seconds": 45,
    "active_from": "21:00",
    "active_to": "06:00",
    "severity": "MEDIUM",
    "summary": "Loitering at the Spirits shelf for over 45 s, 21:00–06:00",
}


def test_valid_rule_compiles_and_is_cached(repo):
    gateway = FakeGateway([text(json.dumps(DWELL))])
    sentence = "Alert if anyone stays at spirits more than 45s after 9pm"

    first = compile_rule(sentence, repo.zones(), gateway, "m", repo)
    reworded = "  alert if anyone STAYS at spirits more than 45s after 9pm "
    second = compile_rule(reworded, repo.zones(), gateway, "m", repo)

    assert first.problems == [] and first.cached is False
    assert second.cached is True and second.spec == first.spec
    assert len(gateway.calls) == 1


def test_unsupported_rule_reports_the_reason(repo):
    spec = {"supported": False, "unsupported_reason": "Rules can't target appearance.", "summary": "n/a"}
    result = compile_rule("Alert on people wearing hoodies", repo.zones(), FakeGateway([text(json.dumps(spec))]),
                          "m", repo)
    assert result.problems == ["Rules can't target appearance."]


def test_unknown_zone_and_bad_time_are_rejected(repo):
    spec = {**DWELL, "zone_id": "z-nowhere", "active_from": "25:00"}
    result = compile_rule("Alert at the moon shelf", repo.zones(), FakeGateway([text(json.dumps(spec))]), "m", repo)
    assert any("zone" in p for p in result.problems)
    assert any("25:00" in p for p in result.problems)


def test_garbage_model_output_is_not_saved_to_cache(repo):
    gateway = FakeGateway([text("not json"), text(json.dumps(DWELL))])

    first = compile_rule("Alert if loitering at spirits for 45 seconds", repo.zones(), gateway, "m", repo)
    second = compile_rule("Alert if loitering at spirits for 45 seconds", repo.zones(), gateway, "m", repo)

    assert first.spec.supported is False and first.problems
    assert second.problems == [] and second.cached is False
