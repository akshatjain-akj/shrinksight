"""'Ask about this incident': a small Gemini agent that answers a manager's question using tools.

Gemini decides which tools to call (incident details, recent incidents, receipts, zone policy, prices); we run
them against the store data and feed the results back, up to a few calls, then it answers in plain words.
Text only, so it is fast; every tool call is returned as a visible step.
"""

import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from .config import Settings
from .gemini import Gateway, call_with_fallback, model_chain, seconds_left, thinking_config
from .investigator import ToolBox
from .models import Incident
from .repo import Repo

SYSTEM_PROMPT = """You answer a store manager's question about a loss-prevention incident, using the tools.
- State only facts that come from tool results; if the tools can't answer it, say so plainly.
- Describe actions and items only, never people's appearance, age, gender or ethnicity.
- Be brief: two to four short sentences, with concrete numbers (counts, ₹ amounts, times).
- Times are UTC unless the data says otherwise. Money is in Indian rupees (₹)."""

STEP_TEXT = {
    "get_incident_details": "Read this incident",
    "list_incidents": "Searched recent incidents",
    "get_pos_transaction": "Checked a till receipt",
    "get_zone_policy": "Checked the zone policy",
    "get_sku_price": "Looked up an item price",
}


@dataclass
class AskResult:
    answer: str
    steps: list[dict[str, Any]] = field(default_factory=list)
    model: str = ""


def _summary(incident: Incident) -> dict[str, Any]:
    return {
        "id": incident.id,
        "camera_id": incident.camera_id,
        "camera": incident.camera_name,
        "time": incident.created_at,
        "verdict": incident.verdict.verdict,
        "status": incident.status,
        "est_loss_inr": incident.est_loss_inr,
        "unscanned_items": [u.description for u in incident.unscanned_items],
        "reason": incident.verdict.reason,
    }


class AgentTools:
    def __init__(self, repo: Repo, incident: Incident):
        self.repo = repo
        self.incident = incident
        camera = next((c for c in repo.cameras() if c.id == incident.camera_id), None)
        self.toolbox = ToolBox(repo, camera, None) if camera else None

    def run(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "get_incident_details":
            details = _summary(self.incident)
            details.update({
                "items_seen": [
                    {"item": s.description, "t": s.t, "on_receipt": s.scanned, "where": s.location}
                    for s in self.incident.verdict.seen_items
                ],
                "receipt": [line.model_dump() for line in self.incident.receipt],
                "transaction_id": self.incident.transaction_id,
            })
            return details
        if name == "list_incidents":
            hours = float(args.get("hours") or 24)
            since = (datetime.now(UTC) - timedelta(hours=min(max(hours, 1), 24 * 30))).strftime("%Y-%m-%dT%H:%M:%SZ")
            camera_id = args.get("camera_id")
            verdict = args.get("verdict")
            items = [
                _summary(i) for i in self.repo.incidents(100)
                if i.created_at >= since
                and (not camera_id or i.camera_id == camera_id)
                and (not verdict or i.verdict.verdict == verdict)
            ]
            return {"count": len(items), "total_est_loss_inr": round(sum(i["est_loss_inr"] for i in items), 2),
                    "incidents": items[:20]}
        if name == "get_pos_transaction":
            txn_id = args.get("transaction_id") or self.incident.transaction_id
            txn = self.repo.get_transaction(txn_id) if txn_id else None
            if txn is None:
                return {"found": False}
            return {"found": True, "id": txn.id, "lane_id": txn.lane_id, "time": txn.started_at,
                    "lines": [line.model_dump() for line in txn.lines], "total_inr": txn.total_inr}
        if name in ("get_zone_policy", "get_sku_price") and self.toolbox is not None:
            return self.toolbox.run(name, args)
        return {"error": f"unknown tool {name}"}


def _declarations(types) -> list:
    def decl(name: str, description: str, properties: dict, required: list[str] | None = None):
        return types.FunctionDeclaration(
            name=name,
            description=description,
            parameters_json_schema={"type": "object", "properties": properties, "required": required or []},
        )

    return [
        decl("get_incident_details", "Full details of the incident being asked about: items, receipt, verdict.", {}),
        decl(
            "list_incidents",
            "Recent incidents, optionally filtered. Returns a count, total estimated loss and summaries.",
            {
                "camera_id": {"type": "string", "description": "e.g. cam-sco-1; omit for all cameras"},
                "verdict": {"type": "string", "enum": ["SCAN_AVOIDANCE", "CONCEALMENT", "RULE_BREACH", "BENIGN",
                                                       "INCONCLUSIVE"]},
                "hours": {"type": "number", "description": "How far back to look (default 24)"},
            },
        ),
        decl("get_pos_transaction", "A till receipt by id (defaults to this incident's receipt).",
             {"transaction_id": {"type": "string"}}),
        decl("get_zone_policy", "Policy and active rules for a zone.", {"zone_id": {"type": "string"}}, ["zone_id"]),
        decl("get_sku_price", "Catalogue price for an item description.", {"description": {"type": "string"}},
             ["description"]),
    ]


def ask(question: str, incident: Incident, repo: Repo, gateway: Gateway, settings: Settings) -> AskResult:
    from google.genai import types

    deadline = time.monotonic() + settings.ask_deadline_s
    models = model_chain(settings.gemini_model, settings.fallback_models)
    tools = AgentTools(repo, incident)
    declarations = [types.Tool(function_declarations=_declarations(types))]

    def config(model: str, final: bool = False):
        return types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            tools=declarations,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(mode="NONE" if final else "AUTO")
            ),
            temperature=0,
            thinking_config=thinking_config(types, model, settings.thinking_level),
        )

    now = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    opening = (
        f"Incident {incident.id} on {incident.camera_name} ({incident.camera_id}) at {incident.created_at}. "
        f"Current time {now}.\n\nQuestion: {question}"
    )
    contents: list = [types.Content(role="user", parts=[types.Part.from_text(text=opening)])]
    steps: list[dict[str, Any]] = []
    model = models[0]
    for round_no in range(settings.agent_max_tool_calls + 1):
        final = round_no == settings.agent_max_tool_calls or seconds_left(deadline) < 8
        result, model = call_with_fallback(
            gateway, models if round_no == 0 else [model], contents, lambda m, f=final: config(m, f),
            deadline=deadline, retries=1,
        )
        if not result.function_calls or final:
            answer = (result.text or "").strip() or "I couldn't find an answer in the store data."
            return AskResult(answer=answer, steps=steps, model=model)
        if result.content is not None:
            contents.append(result.content)
        responses = []
        for call in result.function_calls[: settings.agent_max_tool_calls - len(steps)]:
            output = tools.run(call.name, call.args)
            steps.append({"tool": call.name, "label": STEP_TEXT.get(call.name, call.name), "args": call.args})
            responses.append(types.Part.from_function_response(name=call.name, response=output))
        contents.append(types.Content(role="user", parts=responses))
    return AskResult(answer="I couldn't finish answering in time.", steps=steps, model=model)
