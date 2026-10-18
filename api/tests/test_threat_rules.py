import json

from conftest import FakeGateway, text
from test_api import meta_header, sse_events
from test_floor_rule import floor_verdict

from app import main
from app.models import Rule, RuleSpec, ThreatSeen, validate_rule_spec
from app.reconcile import apply_threat_rule
from app.rules_compiler import compile_rule

FIREARM = RuleSpec(supported=True, type="THREAT", threat_of="firearm", zone_id=None, severity="HIGH",
                   summary="Alert if anyone points a gun")


def rule(spec: RuleSpec = FIREARM, enabled: bool = True) -> Rule:
    return Rule(id="rule-threat", source_text="Alert if anyone points a gun", spec=spec, enabled=enabled,
                created_at="2026-10-19T00:00:00Z")


def gun(pointed: bool = True, kind: str = "firearm") -> ThreatSeen:
    return ThreatSeen(type=kind, t="00:04.2", box_2d=[300, 400, 380, 520], pointed_at_person=pointed,
                      description="dark handgun held out at arm's length")


# ---------- rule spec ----------
def test_a_threat_rule_may_cover_every_camera_but_a_named_zone_must_exist(repo):
    zones = {z.id: z for z in repo.zones()}
    assert validate_rule_spec(FIREARM, zones) == []
    assert validate_rule_spec(FIREARM.model_copy(update={"zone_id": "z-spirits"}), zones) == []
    assert validate_rule_spec(FIREARM.model_copy(update={"zone_id": "z-nowhere"}), zones)
    other = RuleSpec(supported=True, type="DWELL", min_seconds=30, summary="Loitering")
    assert validate_rule_spec(other, zones)  # every other type still needs a zone


def test_the_gun_rule_now_compiles(repo):
    gateway = FakeGateway([text(json.dumps(FIREARM.model_dump()))])
    result = compile_rule("Alert if anyone points a gun", repo.zones(), gateway, "m", repo)
    assert result.problems == [] and result.spec.type == "THREAT" and result.spec.threat_of == "firearm"
    prompt = gateway.calls[0][2].system_instruction
    assert "THREAT" in prompt


# ---------- deterministic threat rule ----------
def test_a_visible_watched_weapon_is_an_urgent_rule_breach():
    verdict, note, changed, urgent = apply_threat_rule(floor_verdict("BENIGN", t="00:02.0", description="tin")
                                                       .model_copy(update={"threats": [gun()]}), [rule()])
    assert verdict.verdict == "RULE_BREACH" and urgent and changed
    assert note.startswith("Possible threat: firearm pointed at a person at 00:04.2")
    assert "never contacts police" in note


def test_an_aiming_pose_without_a_visible_weapon_needs_review_not_all_clear():
    events = [{"t": "00:03.1", "kind": "THREAT", "score": 0.9, "detail": "Arm held out straight"}]
    verdict, note, changed, urgent = apply_threat_rule(floor_verdict("BENIGN", description="tin"), [rule()], events)
    assert verdict.verdict == "INCONCLUSIVE" and changed and not urgent
    assert "possible aiming pose at 00:03.1" in note


def test_unwatched_weapons_and_missing_rules_change_nothing():
    with_knife = floor_verdict("BENIGN", description="tin").model_copy(update={"threats": [gun(kind="knife")]})
    assert apply_threat_rule(with_knife, [rule()])[0].verdict == "BENIGN"  # firearm rule, knife seen
    assert apply_threat_rule(with_knife, [])[0].verdict == "BENIGN"  # no threat rule at all
    any_weapon = rule(FIREARM.model_copy(update={"threat_of": "any_weapon"}))
    assert apply_threat_rule(with_knife, [any_weapon])[0].verdict == "RULE_BREACH"


# ---------- end to end ----------
def test_an_investigation_with_a_threat_rule_asks_gemini_and_marks_the_incident_urgent(api):
    api.repo.save_rule(rule())
    answer = floor_verdict("BENIGN", description="tin").model_copy(update={"threats": [gun()]})
    main.app.state.gateway = FakeGateway([text(answer.model_dump_json())])
    hint = {"t": "00:04.0", "kind": "THREAT", "score": 0.9, "detail": "Arm held out straight", "trigger": "threat"}

    res = api.post("/api/investigate", files=[("clip", ("clip.webm", b"threat-clip", "video/webm"))],
                   headers={"x-shrinksight-meta": meta_header(camera_id="cam-aisle-4", origin="edge",
                                                              tier1_events=[hint])})

    incident = sse_events(res.text)[-1]["incident"]
    assert incident["urgent"] is True and incident["verdict"]["verdict"] == "RULE_BREACH"
    assert incident["status"] == "NEEDS_REVIEW"
    assert incident["verdict"]["threats"][0]["type"] == "firearm"
    prompt = main.app.state.gateway.calls[0][1][0].parts[-1].text
    assert "Store threat rules" in prompt and "Alert if anyone points a gun" in prompt


def test_a_disabled_threat_rule_is_not_sent_to_gemini(api):
    api.repo.save_rule(rule(enabled=False))
    main.app.state.gateway = FakeGateway([text(floor_verdict("BENIGN", description="tin").model_dump_json())])

    res = api.post("/api/investigate", files=[("clip", ("clip.webm", b"quiet-clip", "video/webm"))],
                   headers={"x-shrinksight-meta": meta_header(camera_id="cam-aisle-4")})

    assert sse_events(res.text)[-1]["incident"]["urgent"] is False
    assert "Store threat rules" not in main.app.state.gateway.calls[0][1][0].parts[-1].text
