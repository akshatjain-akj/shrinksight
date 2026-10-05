import time

import pytest
from conftest import FakeGateway, call, text
from google.genai import errors, types

from app import gemini, main
from app.agent import ask
from app.gemini import GeminiGateway, GeminiUnavailable, call_with_fallback, model_chain, thinking_config


# ---------- "Ask about this incident" agent ----------
def test_agent_calls_tools_then_answers(repo, settings):
    gateway = FakeGateway([
        call("list_incidents", camera_id="cam-sco-1", verdict="SCAN_AVOIDANCE", hours=48),
        text("Lane 1 had 1 other missed scan (razor cartridges, ₹650)."),
    ])
    incident = repo.get_incident("inc-seed-004")

    result = ask("Has this lane had other missed scans?", incident, repo, gateway, settings)

    assert result.answer.startswith("Lane 1 had 1 other missed scan")
    assert [s["tool"] for s in result.steps] == ["list_incidents"]
    tool_reply = gateway.calls[1][1][-1].parts[0].function_response
    assert tool_reply.name == "list_incidents" and "count" in tool_reply.response


def test_agent_tools_read_real_store_data(repo):
    from app.agent import AgentTools

    tools = AgentTools(repo, repo.get_incident("inc-seed-001"))

    details = tools.run("get_incident_details", {})
    receipt = tools.run("get_pos_transaction", {})
    price = tools.run("get_sku_price", {"description": "red wine bottle"})

    assert details["unscanned_items"] == ["green glass wine bottle"] and len(details["receipt"]) == 3
    assert receipt["id"] == "TXN-L2-2041" and receipt["total_inr"] == 168
    assert price["price_inr"] == 1850
    assert tools.run("nope", {}) == {"error": "unknown tool nope"}


def test_agent_answers_without_more_tools_when_the_budget_is_used(repo, settings):
    from dataclasses import replace

    gateway = FakeGateway([call("get_incident_details"), call("get_incident_details"), text("Final answer.")])

    result = ask("What happened?", repo.get_incident("inc-seed-001"), repo, gateway,
                 replace(settings, agent_max_tool_calls=2))

    assert result.answer == "Final answer." and len(result.steps) == 2
    final_config = gateway.calls[-1][2]
    assert final_config.tool_config.function_calling_config.mode.name == "NONE"


def test_ask_endpoint(api):
    main.app.state.gateway = FakeGateway([text("This incident has 1 item not on the receipt.")])

    res = api.post("/api/incidents/inc-seed-001/ask", json={"question": "What was missed?"})

    assert res.status_code == 200 and res.json()["answer"].startswith("This incident")
    assert api.post("/api/incidents/nope/ask", json={"question": "Anything?"}).status_code == 404
    assert api.post("/api/incidents/inc-seed-001/ask", json={"question": "x"}).status_code == 422


# ---------- gateway: budget, retries, fallback, thinking ----------
class FakeModels:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.timeouts = []

    def generate_content(self, model, contents, config):
        self.timeouts.append(config.http_options.timeout)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeClient:
    def __init__(self, models):
        self.models = models


def gateway_with(outcomes, monkeypatch):
    # Built without a real SDK client: these tests exercise the retry/budget logic only, with no network.
    gw = GeminiGateway.__new__(GeminiGateway)
    gw._types = types
    gw._timeout_ms = 25_000
    gw._max_retries = 2
    fake = FakeModels(outcomes)
    gw._client = FakeClient(fake)
    sleeps = []
    monkeypatch.setattr(gemini.time, "sleep", lambda s: sleeps.append(s))
    return gw, fake, sleeps


def overloaded(delay=None):
    details = {"error": {"code": 503, "message": "overloaded", "status": "UNAVAILABLE"}}
    if delay:
        details["error"]["details"] = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": delay}]
    return errors.ServerError(503, details)


def ok_response():
    return types.GenerateContentResponse(candidates=[types.Candidate(content=types.Content(
        role="model", parts=[types.Part.from_text(text="{}")]))])


def test_retry_honours_gemini_retry_delay(monkeypatch):
    gw, fake, sleeps = gateway_with([overloaded("2s"), ok_response()], monkeypatch)

    result = gw.generate("m", ["hi"], types.GenerateContentConfig())

    assert result.text == "{}" and sleeps == [2.0]


def test_per_call_timeout_is_capped_by_the_deadline(monkeypatch):
    gw, fake, _ = gateway_with([ok_response()], monkeypatch)

    gw.generate("m", ["hi"], types.GenerateContentConfig(), deadline=time.monotonic() + 20)

    assert 17_000 < fake.timeouts[0] <= 19_000


def test_never_sends_a_request_deadline_under_10_seconds(monkeypatch):
    gw, fake, _ = gateway_with([ok_response()], monkeypatch)

    gw.generate("m", ["hi"], types.GenerateContentConfig(), timeout_ms=4_000)

    assert fake.timeouts[0] == 10_000, "the Gemini API rejects deadlines below 10 s"


def test_too_little_time_left_stops_before_calling(monkeypatch):
    gw, fake, _ = gateway_with([ok_response()], monkeypatch)

    with pytest.raises(GeminiUnavailable) as err:
        gw.generate("m", ["hi"], types.GenerateContentConfig(), deadline=time.monotonic() + 11)

    assert err.value.code == 408 and fake.timeouts == []


def test_no_waiting_when_the_retry_cannot_finish_in_time(monkeypatch):
    gw, _, sleeps = gateway_with([overloaded("30s")], monkeypatch)

    with pytest.raises(GeminiUnavailable) as err:
        gw.generate("m", ["hi"], types.GenerateContentConfig(), deadline=time.monotonic() + 20)

    assert err.value.code == 503 and sleeps == []


def test_out_of_time_before_calling(monkeypatch):
    gw, fake, _ = gateway_with([ok_response()], monkeypatch)

    with pytest.raises(GeminiUnavailable) as err:
        gw.generate("m", ["hi"], types.GenerateContentConfig(), deadline=time.monotonic() + 1)

    assert err.value.code == 408 and fake.timeouts == []


def test_call_with_fallback_moves_on_only_for_capacity_errors():
    busy_then_ok = FakeGateway([GeminiUnavailable("busy", 503), text("ok")])
    result, used = call_with_fallback(busy_then_ok, ["a", "b"], ["q"], lambda m: None)
    assert (result.text, used) == ("ok", "b")

    forbidden = FakeGateway([GeminiUnavailable("bad key", 403)])
    with pytest.raises(GeminiUnavailable):
        call_with_fallback(forbidden, ["a", "b"], ["q"], lambda m: None)
    assert len(forbidden.calls) == 1


def test_model_chain_and_thinking_config():
    assert model_chain("a", ("b", "a", "", "c")) == ["a", "b", "c"]
    assert thinking_config(types, "gemini-3.5-flash-lite", "low").thinking_level.name == "LOW"
    assert thinking_config(types, "gemini-2.5-flash-lite", "low") is None
    assert thinking_config(types, "gemma-4-31b", "low") is None
    assert thinking_config(types, "gemini-3.5-flash", "DEFAULT") is None
