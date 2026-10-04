"""Tier-2 investigator: Gemini watches a clip, uses tools, and returns a structured verdict.

Flow (each step is streamed to the browser as a progress event):
  1. Agent pass: video + store context + tool declarations. Gemini may call up to N tools
     (till receipt, zone policy, item price); we execute them and feed results back.
  2. Verdict pass: a fresh request with the video, the tool results and the agent's notes,
     forced into the VerdictOut JSON schema. Kept separate from the tool pass because
     "tools + forced JSON" in one call isn't reliable across models.
  3. Validate, price unscanned items deterministically, save the incident, cache the result.
"""

import hashlib
import json
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

from pydantic import ValidationError

from .config import Settings
from .gemini import Gateway, GeminiUnavailable, GenResult
from .models import (
    POSITIVE_VERDICTS,
    Camera,
    Incident,
    ToolCallLog,
    Transaction,
    UnscannedItem,
    VerdictOut,
    status_for,
)
from .repo import Repo, match_sku

ALLOWED_MIME = {"video/mp4": "video/mp4", "video/webm": "video/webm", "video/quicktime": "video/mov",
                "video/mov": "video/mov", "video/3gpp": "video/3gpp"}

TOOL_LABELS = {
    "get_pos_transaction": "Checking the till receipt",
    "get_zone_policy": "Checking the zone policy",
    "get_sku_price": "Looking up the item price",
}

SYSTEM_PROMPT = """You are a retail loss-prevention investigator reviewing a short CCTV clip.

Principles:
- Judge ACTIONS only. Never describe or infer appearance, clothing as identity, age, gender or ethnicity.
- Be conservative: if the footage doesn't clearly show it, say INCONCLUSIVE rather than guessing.
- Your output is reviewed by a human; you flag events, you never accuse anyone.

Verdicts:
- SCAN_AVOIDANCE: at a self-checkout, an item went to the bag/bagging area without passing over the scanner
  zone, or was hidden under another item while scanning, so it is missing from the till receipt.
- CONCEALMENT: on the shop floor, merchandise was placed into clothing or a personal bag instead of a basket/cart.
- RULE_BREACH: a store rule for the zone was clearly broken (see zone policy).
- BENIGN: the activity has an innocent explanation (e.g. taking out a phone, rescanning, putting items back).
- INCONCLUSIVE: footage is unclear or too short to decide.

Method:
- Self-checkout: list EVERY item handled, in order, with the clip timestamp and whether it clearly passed over
  the scanner zone. Call get_pos_transaction to compare against what was actually scanned. For each item that
  wasn't scanned, call get_sku_price with a short description.
- Shop floor: watch where picked-up items go. Call get_zone_policy for the zone involved.
- Timestamps are relative to the clip start, formatted mm:ss.s. Bounding boxes use [ymin, xmin, ymax, xmax]
  normalised to 0-1000.
"""

VERDICT_INSTRUCTION = """Give your final verdict as JSON matching the schema.
List every item you saw handled in seen_items (scanned=true only if it clearly passed over the scanner zone).
items_seen and items_scanned must match seen_items. reason: one or two plain sentences, actions only."""


def _tool_declarations(types, camera: Camera) -> list:
    decls = [
        types.FunctionDeclaration(
            name="get_zone_policy",
            description="Store policy and active rules for a zone (high-value flag, loitering limits).",
            parameters_json_schema={
                "type": "object",
                "properties": {"zone_id": {"type": "string", "description": "Zone id from the store context"}},
                "required": ["zone_id"],
            },
        ),
        types.FunctionDeclaration(
            name="get_sku_price",
            description="Look up an item in the store catalogue by a short visual description; returns price.",
            parameters_json_schema={
                "type": "object",
                "properties": {"description": {"type": "string", "description": "e.g. 'green wine bottle'"}},
                "required": ["description"],
            },
        ),
    ]
    if camera.kind == "checkout":
        decls.insert(0, types.FunctionDeclaration(
            name="get_pos_transaction",
            description="The till receipt (items actually scanned) for this self-checkout lane and visit.",
            parameters_json_schema={
                "type": "object",
                "properties": {"lane_id": {"type": "string", "description": "Lane id, e.g. 'L2'"}},
                "required": ["lane_id"],
            },
        ))
    return decls


class ToolBox:
    """Executes tool calls against the repo. Results are small JSON-friendly dicts."""

    def __init__(self, repo: Repo, camera: Camera, transaction: Transaction | None):
        self.repo = repo
        self.camera = camera
        self.transaction = transaction
        self._skus = None

    def _catalogue(self):
        if self._skus is None:
            self._skus = self.repo.skus()
        return self._skus

    def run(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "get_pos_transaction":
            txn = self.transaction
            if txn is None:
                lane = str(args.get("lane_id") or self.camera.lane_id or "")
                matches = self.repo.transactions(lane_id=lane)
                txn = matches[0] if matches else None
            if txn is None:
                return {"found": False}
            return {
                "found": True,
                "transaction_id": txn.id,
                "item_count": len(txn.lines),
                "lines": [{"name": line.name, "price_inr": line.price_inr} for line in txn.lines],
                "total_inr": txn.total_inr,
            }
        if name == "get_zone_policy":
            zone_id = str(args.get("zone_id", ""))
            zone = next((z for z in self.repo.zones() if z.id == zone_id), None)
            if zone is None:
                return {"found": False, "known_zones": self.camera.zone_ids}
            rules = [r.spec.summary for r in self.repo.rules() if r.enabled and r.spec.zone_id == zone_id]
            return {"found": True, "zone": zone.model_dump(), "active_rules": rules}
        if name == "get_sku_price":
            sku = match_sku(str(args.get("description", "")), self._catalogue())
            if sku is None:
                return {"found": False}
            return {"found": True, "sku": sku.sku, "name": sku.name, "price_inr": sku.price_inr}
        return {"error": f"unknown tool {name}"}


def normalise_mime(mime: str) -> str | None:
    return ALLOWED_MIME.get(mime.split(";")[0].strip().lower())


def cache_key(clip: bytes, camera: Camera, transaction: Transaction | None, model: str) -> str:
    h = hashlib.sha256(clip)
    h.update(json.dumps([camera.id, transaction.model_dump() if transaction else None, model]).encode())
    return "inv:" + h.hexdigest()


def _context_text(camera: Camera, repo: Repo) -> str:
    zones = [z for z in repo.zones() if z.id in camera.zone_ids]
    zone_lines = "\n".join(f"- {z.id}: {z.name} ({z.kind})" for z in zones)
    lane = f"Lane id: {camera.lane_id}\n" if camera.lane_id else ""
    return f"Camera: {camera.name} ({camera.kind})\n{lane}Zones in view:\n{zone_lines}"


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _progress(step: str, label: str, **extra) -> dict:
    return {"type": "progress", "step": step, "label": label, **extra}


def investigate(
    clip: bytes,
    mime: str,
    camera: Camera,
    transaction: Transaction | None,
    repo: Repo,
    gateway: Gateway,
    settings: Settings,
) -> Iterator[dict]:
    """Yields progress events, then exactly one `result` or `error` event."""
    started = time.monotonic()
    model = settings.investigator_model
    key = cache_key(clip, camera, transaction, model)

    cached = repo.cache_get(key)
    if cached and (incident := repo.get_incident(cached["incident_id"])):
        yield _progress("cached", "Found an earlier analysis of this exact clip")
        yield {"type": "result", "incident": incident.model_dump(), "cached": True}
        return

    try:
        from google.genai import types

        video = types.Part(
            inline_data=types.Blob(data=clip, mime_type=mime),
            video_metadata=types.VideoMetadata(fps=settings.clip_fps),
        )
        context = _context_text(camera, repo)
        toolbox = ToolBox(repo, camera, transaction)
        tool_log: list[ToolCallLog] = []
        tool_results: list[dict] = []

        # ---- 1. Agent pass with tools ----
        yield _progress("watching", "Watching the clip")
        agent_config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            tools=[types.Tool(function_declarations=_tool_declarations(types, camera))],
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            media_resolution=types.MediaResolution.MEDIA_RESOLUTION_LOW,
            temperature=0,
        )
        contents: list = [types.Content(role="user", parts=[video, types.Part.from_text(text=context)])]
        notes = ""
        while True:
            _check_deadline(started, settings)
            result: GenResult = gateway.generate(model, contents, agent_config)
            notes = result.text or notes
            budget = settings.agent_max_tool_calls - len(tool_log)
            if not result.function_calls or budget <= 0:
                break
            if result.content is not None:
                contents.append(result.content)
            responses = []
            for call in result.function_calls[:budget]:
                yield _progress("tool", TOOL_LABELS.get(call.name, call.name), tool=call.name, args=call.args)
                output = toolbox.run(call.name, call.args)
                tool_log.append(ToolCallLog(name=call.name, args=call.args))
                tool_results.append({"tool": call.name, "args": call.args, "result": output})
                responses.append(types.Part.from_function_response(name=call.name, response=output))
            contents.append(types.Content(role="user", parts=responses))

        # A self-checkout verdict is meaningless without the receipt; fetch it if the model didn't.
        if camera.kind == "checkout" and not any(t["tool"] == "get_pos_transaction" for t in tool_results):
            args = {"lane_id": camera.lane_id or ""}
            yield _progress("tool", TOOL_LABELS["get_pos_transaction"], tool="get_pos_transaction", args=args)
            tool_log.append(ToolCallLog(name="get_pos_transaction", args=args))
            tool_results.append({"tool": "get_pos_transaction", "args": args,
                                 "result": toolbox.run("get_pos_transaction", args)})

        # ---- 2. Verdict pass with forced JSON ----
        yield _progress("report", "Writing the incident report")
        verdict = _verdict_pass(types, gateway, model, video, context, tool_results, notes, started, settings)

        # ---- 3. Price, save, cache ----
        incident = _build_incident(verdict, camera, transaction, tool_results, tool_log, toolbox, model, started)
        repo.save_incident(incident)
        repo.cache_put(key, {"incident_id": incident.id})
        yield {"type": "result", "incident": incident.model_dump(), "cached": False}
    except GeminiUnavailable as exc:
        yield {"type": "error", "message": str(exc)}
    except TimeoutError:
        yield {"type": "error", "message": "The investigation took too long. Try a shorter clip."}


def _check_deadline(started: float, settings: Settings) -> None:
    if time.monotonic() - started > settings.agent_deadline_s:
        raise TimeoutError


def _verdict_pass(types, gateway, model, video, context, tool_results, notes, started, settings) -> VerdictOut:
    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_PROMPT,
        response_mime_type="application/json",
        response_schema=VerdictOut,
        media_resolution=types.MediaResolution.MEDIA_RESOLUTION_LOW,
        temperature=0,
    )
    briefing = (
        f"{context}\n\nTool results:\n{json.dumps(tool_results, ensure_ascii=False)}\n\n"
        f"Your investigation notes:\n{notes or '(none)'}\n\n{VERDICT_INSTRUCTION}"
    )
    contents: list = [types.Content(role="user", parts=[video, types.Part.from_text(text=briefing)])]
    last_error = ""
    for _ in range(2):  # one re-ask if the JSON doesn't validate
        _check_deadline(started, settings)
        result = gateway.generate(model, contents, config)
        try:
            return VerdictOut.model_validate_json(result.text)
        except ValidationError as exc:
            last_error = str(exc)[:500]
            contents.append(types.Content(role="user", parts=[types.Part.from_text(
                text=f"That JSON was invalid: {last_error}\nReturn corrected JSON only.")]))
    return VerdictOut(verdict="INCONCLUSIVE", confidence=0, items_seen=0, items_scanned=0,
                      reason="The model's answer could not be validated, so this needs a human look.")


def _build_incident(verdict, camera, transaction, tool_results, tool_log, toolbox, model, started) -> Incident:
    receipt_result = next((t["result"] for t in tool_results if t["tool"] == "get_pos_transaction"), None)
    receipt_txn = transaction
    if receipt_txn is None and receipt_result and receipt_result.get("found"):
        receipt_txn = toolbox.repo.get_transaction(receipt_result["transaction_id"])

    unscanned: list[UnscannedItem] = []
    if verdict.verdict in POSITIVE_VERDICTS:
        for item in verdict.seen_items:
            if item.scanned:
                continue
            sku = match_sku(item.description, toolbox._catalogue())
            unscanned.append(UnscannedItem(t=item.t, description=item.description,
                                           price_inr=sku.price_inr if sku else None,
                                           matched_sku=sku.sku if sku else None))
    return Incident(
        id=f"inc-{uuid.uuid4().hex[:10]}",
        created_at=_now_iso(),
        camera_id=camera.id,
        camera_name=camera.name,
        camera_kind=camera.kind,
        status=status_for(verdict.verdict),
        verdict=verdict,
        receipt=receipt_txn.lines if receipt_txn else [],
        transaction_id=receipt_txn.id if receipt_txn else None,
        unscanned_items=unscanned,
        est_loss_inr=round(sum(u.price_inr or 0 for u in unscanned), 2),
        model=model,
        source="live",
        latency_ms=round((time.monotonic() - started) * 1000),
        tool_calls=tool_log,
    )
