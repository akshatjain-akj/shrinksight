"""Tier-2 investigator: Gemini watches a clip once and returns a structured, receipt-checked verdict.

Flow (each step is streamed to the browser as a progress event):
  1. Server-side lookups: the till receipt (self-checkout) or the zone policy (shop floor). We know what is
     needed, so there is no tool round trip and the video is not re-sent for it.
  2. One Gemini call: marked stills + zone close-ups + the clip + receipt/zone context, forced into the
     VerdictOut JSON schema. Thinking is kept low; overloaded models fall back to backup models.
  3. Receipt-first reconciliation. Only if the answer contradicts the receipt (or isn't valid JSON) and time
     allows, Gemini is asked once more. A remaining contradiction becomes INCONCLUSIVE, never a false alarm.
  4. Prices are added deterministically, the incident is saved and cached.
Everything runs inside a hard time budget (settings.agent_deadline_s) so it ends before Firebase Hosting's
60 s limit; if time runs out after Gemini has answered, that answer is still used.
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
from .gemini import FALLBACK_CODES, Gateway, GeminiUnavailable, model_chain, seconds_left, thinking_config
from .models import (
    POSITIVE_VERDICTS,
    Camera,
    Incident,
    InventoryItem,
    ReceiptLine,
    ToolCallLog,
    Transaction,
    UnscannedItem,
    VerdictOut,
    ZoneHint,
    status_for,
)
from .reconcile import confirmed_list_text, receipt_lines_text, reconcile
from .repo import Repo, match_sku
from .zones import zones_context

# Part of every cache key: changing the prompts below must produce fresh analyses, not old cached ones.
PROMPT_VERSION = "2026-10-08.confirmed-list"
CLOSE_UP_LABELS = {"pickup_start", "scanner_mid", "bagging_end"}

ALLOWED_MIME = {"video/mp4": "video/mp4", "video/webm": "video/webm", "video/quicktime": "video/mov",
                "video/mov": "video/mov", "video/3gpp": "video/3gpp"}

TOOL_LABELS = {
    "get_pos_transaction": "Checking the till receipt",
    "get_zone_policy": "Checking the zone policy",
    "get_sku_price": "Looking up the item price",
}

STILL_TEXT = {
    "before": "Still: before",
    "reach": "Still: reach",
    "hold": "Still: hold",
    "after": "Still: after",
    "pickup_start": "Close-up: the item pile at the start (count every item here)",
    "scanner_mid": "Close-up: the scanner zone mid-clip",
    "bagging_end": "Close-up: the bagging area at the end (what ended up in the bag)",
}

SYSTEM_PROMPT = """You are a retail loss-prevention investigator reviewing a short CCTV clip.

Principles:
- Judge ACTIONS only. Never describe or infer appearance, clothing as identity, age, gender or ethnicity.
- Be conservative: if the footage doesn't clearly show it, say INCONCLUSIVE rather than guessing.
- Your output is reviewed by a human; you flag events, you never accuse anyone.

Verdicts:
- SCAN_AVOIDANCE: at a self-checkout, an item was handled and bagged but is missing from the till receipt
  (e.g. it went around the scanner, or was hidden under another item while scanning).
- CONCEALMENT: on the shop floor, merchandise was placed into clothing or a personal bag instead of a basket/cart.
- RULE_BREACH: a store rule for the zone was clearly broken (see zone policy).
- BENIGN: the activity has an innocent explanation (e.g. taking out a phone, rescanning, putting items back).
- INCONCLUSIVE: footage is unclear or too short to decide.

Method for a self-checkout (receipt first):
1. Inventory: list in inventory every separate item in the item pile / pickup area at the start, each with its
   box, using the high-detail item-pile close-up. Count carefully:
   - Thin, small, flat or soft objects are items: cloth or paper flowers, cards, napkins, stickers, sachets,
     pens, cables. A flat item lying on another item can look like a pattern printed on it; list it separately.
     Held edge-on, a flat item may look like a thin line.
   - Objects resting on, inside, or carried together with another object are separate items. List each one.
2. Follow every item, in order, with its clip timestamp. Match each one to the till receipt line it corresponds
   to by what it looks like (each line matches at most one item). An item is unscanned ONLY if no receipt line
   matches it. The receipt is the truth about what was scanned.
3. Note where each item went relative to the scanner zone; this is supporting evidence, not the deciding factor.
   The scanner may be a real scanner or a marked area (paper, tape, a box); use the marked zones when given.

Method for the shop floor: watch where picked-up items go, using the zone policy provided.
- A person lying flat on the floor is a health hazard, not a theft. Use RULE_BREACH and say they are down.
  Bending or reaching toward a shelf is not a fall.

Format: timestamps are relative to the clip start, mm:ss.s. Bounding boxes use [ymin, xmin, ymax, xmax]
normalised to 0-1000. Stills, when attached, come first: time-ordered stills, then close-ups at higher detail.
Labelled outlines mark the zones (ITEMS in pink, SCANNER in amber, BAGGING in blue); a red rectangle marks the
person when present. Judge the stills and the video together.
"""

VERDICT_INSTRUCTION = """Return the verdict as JSON matching the schema.
inventory: every separate item in the item pile at the start, each with a box (self-checkout), else empty. If a
confirmed item list is given, you may leave inventory empty: set inventory_id on each seen item instead.
Leave starting_items empty.
seen_items: every item you saw handled. For each: receipt_line = the number of the receipt line it matches (each
line used at most once), or null if no line matches; scanned = true exactly when receipt_line is set; location =
where it went relative to the scanner zone. items_seen and items_scanned must match seen_items.
reason: one or two plain sentences, actions only."""


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
                "lines": [
                    {"line": i, "name": line.name, "price_inr": line.price_inr}
                    for i, line in enumerate(txn.lines, start=1)
                ],
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


def cache_key(
    clip: bytes,
    camera: Camera,
    transaction: Transaction | None,
    model: str,
    stills: list[tuple[str, bytes]] | None = None,
    zones: list[ZoneHint] | None = None,
) -> str:
    h = hashlib.sha256(clip)
    h.update(json.dumps([
        camera.id,
        transaction.model_dump() if transaction else None,
        model,
        PROMPT_VERSION,
        [z.model_dump() for z in zones or []],
    ]).encode())
    for label, data in stills or []:
        h.update(label.encode())
        h.update(data)
    return "inv:" + h.hexdigest()


def _context_text(
    camera: Camera, repo: Repo, tier1_events: list[dict] | None = None, hints: list[ZoneHint] | None = None
) -> str:
    all_zones = repo.zones()
    zones = [z for z in all_zones if z.id in camera.zone_ids]
    zone_lines = "\n".join(f"- {z.id}: {z.name} ({z.kind})" for z in zones)
    lane = f"Lane id: {camera.lane_id}\n" if camera.lane_id else ""
    text = f"Camera: {camera.name} ({camera.kind})\n{lane}Zones in view:\n{zone_lines}"
    marked = zones_context(hints or [], all_zones)
    if marked:
        text += "\n\n" + marked
    if not tier1_events:
        return text
    hints = "\n".join(_hint_line(e) for e in tier1_events[:12])
    return text + "\n\nOn-device Tier-1 hints (verify on the clip; they are not proof):\n" + hints


def _hint_line(event: dict) -> str:
    score = float(event.get("score", 0))
    trigger = event.get("trigger") or "unspecified"
    confidence = event.get("confidence")
    confidence_txt = f" confidence {float(confidence):.2f}" if confidence is not None else ""
    camera = event.get("camera_id")
    camera_txt = f" camera {camera}" if camera else ""
    box = event.get("box")
    box_txt = ""
    if isinstance(box, list) and len(box) == 4:
        box_txt = " box [" + ", ".join(str(int(n)) for n in box) + "]"
    detail = event.get("detail", "")
    return (
        f"- {event.get('t', '?')} {event.get('kind', 'event')} trigger {trigger}"
        f"{confidence_txt} score {score:.2f}{camera_txt}{box_txt}: {detail}"
    )


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _progress(step: str, label: str, **extra) -> dict:
    return {"type": "progress", "step": step, "label": label, **extra}


def _resolution(types, level: str, plain: bool):
    """Per-image detail: close-ups high, other stills medium, video low. Plain mode drops it for older models."""
    if plain:
        return None
    return types.PartMediaResolution(level=getattr(types.PartMediaResolutionLevel, f"MEDIA_RESOLUTION_{level}"))


def _still_parts(types, stills: list[tuple[str, bytes]], plain: bool = False) -> list:
    if not stills:
        return []
    labels = ", ".join(label.replace("_", " ") for label, _ in stills)
    parts = [types.Part.from_text(
        text=f"Stills ({labels}): time-ordered stills first, then close-ups. Outlines mark the zones; a red "
        "rectangle marks the person when present. The video follows."
    )]
    for label, data in stills:
        parts.append(types.Part.from_text(text=STILL_TEXT.get(label, f"Still: {label.replace('_', ' ')}")))
        level = "HIGH" if label in CLOSE_UP_LABELS else "MEDIUM"
        parts.append(types.Part(
            inline_data=types.Blob(data=data, mime_type="image/jpeg"),
            media_resolution=_resolution(types, level, plain),
        ))
    return parts


def _lookups(camera: Camera) -> list[tuple[str, dict[str, Any]]]:
    """What the investigation always needs, fetched by the server instead of a Gemini tool round trip."""
    if camera.kind == "checkout":
        return [("get_pos_transaction", {"lane_id": camera.lane_id or ""})]
    return [("get_zone_policy", {"zone_id": zone_id}) for zone_id in camera.zone_ids]


def _briefing(
    context: str,
    receipt: list[ReceiptLine],
    tool_results: list[dict],
    camera: Camera,
    confirmed: list[InventoryItem] | None = None,
) -> str:
    parts = [context]
    if confirmed:
        parts.append(confirmed_list_text(confirmed))
    if camera.kind == "checkout":
        parts.append(receipt_lines_text(receipt))
        if receipt:
            parts.append(
                f"The receipt has {len(receipt)} lines, so at least {len(receipt)} items were handled "
                "(more if any were not scanned)."
            )
    else:
        policies = [t["result"] for t in tool_results if t["tool"] == "get_zone_policy"]
        parts.append("Zone policy:\n" + json.dumps(policies, ensure_ascii=False))
    parts.append(VERDICT_INSTRUCTION)
    return "\n\n".join(parts)


def _ms(since: float) -> int:
    return round((time.monotonic() - since) * 1000)


def _watch(gateway: Gateway, models: list[str], contents_for, config_for, deadline: float, timeout_ms: int):
    """One Gemini call with backup models. A generator so it can stream progress; returns (result, model, plain)."""
    for index, model in enumerate(models):
        plain = False
        while True:
            try:
                result = gateway.generate(
                    model, contents_for(plain), config_for(model, plain), deadline=deadline, retries=1,
                    timeout_ms=timeout_ms,
                )
                return result, model, plain
            except GeminiUnavailable as exc:
                if exc.code == 400 and not plain:
                    # Some models reject fps / media resolution / thinking settings on a browser WebM.
                    plain = True
                    yield _progress("watching", "Retrying the clip without video settings")
                    continue
                has_backup = index < len(models) - 1
                if exc.code in FALLBACK_CODES and has_backup and seconds_left(deadline) > 12:
                    backup = models[index + 1]
                    why = {408: "is slow", 404: "isn't available", 429: "is rate limited"}.get(exc.code, "is busy")
                    yield _progress("fallback", f"{model} {why} · switching to backup model {backup}", model=backup)
                    break
                raise
    raise GeminiUnavailable("No Gemini model is configured.")


def _parse(text: str, receipt: list[ReceiptLine], confirmed: list[InventoryItem] | None = None):
    """Returns (verdict | None, hard problems, soft problems, json error)."""
    try:
        parsed = VerdictOut.model_validate_json(text)
    except ValidationError as exc:
        return None, [], [], str(exc)[:400]
    checked, hard, soft = reconcile(parsed, receipt, confirmed)
    return checked, hard, soft, None


def _inconclusive(reason: str, base: VerdictOut | None = None) -> VerdictOut:
    if base is not None:
        return base.model_copy(update={"verdict": "INCONCLUSIVE", "reason": reason})
    return VerdictOut(verdict="INCONCLUSIVE", confidence=0, items_seen=0, items_scanned=0, reason=reason)


def investigate(
    clip: bytes,
    mime: str,
    camera: Camera,
    transaction: Transaction | None,
    repo: Repo,
    gateway: Gateway,
    settings: Settings,
    tier1_events: list[dict] | None = None,
    stills: list[tuple[str, bytes]] | None = None,
    zones: list[ZoneHint] | None = None,
    clip_seconds: float | None = None,
    inventory: list[InventoryItem] | None = None,
) -> Iterator[dict]:
    """Yields progress events, then exactly one `result` or `error` event."""
    started = time.monotonic()
    deadline = started + settings.agent_deadline_s
    models = model_chain(settings.investigator_model, settings.fallback_models)
    zones = zones or []
    long_clip = clip_seconds is not None and clip_seconds > settings.long_clip_seconds
    fps = settings.long_clip_fps if long_clip else settings.clip_fps
    confirmed = inventory or []
    variant = f"{settings.investigator_model}@{fps}fps|" + json.dumps([i.description for i in confirmed])
    key = cache_key(clip, camera, transaction, variant, stills, zones)

    cached = repo.cache_get(key)
    if cached and (incident := repo.get_incident(cached["incident_id"])):
        yield _progress("cached", "Found an earlier analysis of this exact clip")
        yield {"type": "result", "incident": incident.model_dump(), "cached": True}
        return

    timings: dict[str, int] = {}
    uploaded = None
    stage = "preparing"
    try:
        from google.genai import types

        # ---- 1. Server-side lookups (instant; no Gemini round trip) ----
        step = time.monotonic()
        toolbox = ToolBox(repo, camera, transaction)
        tool_log: list[ToolCallLog] = []
        tool_results: list[dict] = []
        for name, args in _lookups(camera):
            if not tool_log or name != tool_log[-1].name:
                yield _progress("tool", TOOL_LABELS[name], tool=name, args=args)
            tool_log.append(ToolCallLog(name=name, args=args))
            tool_results.append({"tool": name, "args": args, "result": toolbox.run(name, args)})
        receipt = _receipt_lines(transaction, tool_results) if camera.kind == "checkout" else []
        context = _context_text(camera, repo, tier1_events, zones)
        marked = _still_parts(types, stills or [])
        marked_plain = _still_parts(types, stills or [], plain=True)
        timings["lookup_ms"] = _ms(step)

        # ---- 2. The clip: inline bytes, or the Files API for big clips ----
        step = time.monotonic()
        if len(clip) > settings.inline_clip_bytes:
            stage = "uploading the clip to Gemini"
            yield _progress("upload", "Uploading the clip to Gemini")
            uploaded = gateway.upload_video(clip, mime, timeout_s=max(5.0, min(25.0, seconds_left(deadline) - 20)))
            source = {"file_data": types.FileData(file_uri=uploaded.uri, mime_type=uploaded.mime_type)}
        else:
            source = {"inline_data": types.Blob(data=clip, mime_type=mime)}
        plain_video = types.Part(**source)
        video = types.Part(
            **source,
            video_metadata=types.VideoMetadata(fps=fps),
            media_resolution=_resolution(types, "LOW", plain=False),
        )
        timings["upload_ms"] = _ms(step)

        briefing = _briefing(context, receipt, tool_results, camera, confirmed)

        def contents_for(plain: bool) -> list:
            clip_part = plain_video if plain else video
            stills_part = marked_plain if plain else marked
            return [types.Content(role="user", parts=[*stills_part, clip_part, types.Part.from_text(text=briefing)])]

        def config_for(model: str, plain: bool):
            return types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                response_mime_type="application/json",
                response_schema=VerdictOut,
                temperature=0,
                seed=settings.gemini_seed or None,
                # Resolution is set per part (video low, stills medium, close-ups high), not for the whole request.
                thinking_config=None if plain else thinking_config(types, model, settings.thinking_level),
            )

        # ---- 3. Watch once ----
        step = time.monotonic()
        stage = "watching the clip"
        yield _progress("watching", "Watching the clip and the marked stills" if marked else "Watching the clip")
        result, model, plain = yield from _watch(
            gateway, models, contents_for, config_for, deadline, settings.watch_timeout_ms
        )
        timings["watch_ms"] = _ms(step)
        first, hard, soft, json_error = _parse(result.text, receipt, confirmed)
        chosen, chosen_hard = (first, hard) if first is not None else (None, [])

        # ---- 4. One re-check, only if the answer doesn't add up and there's time ----
        if (json_error or hard or soft) and seconds_left(deadline) > 12:
            step = time.monotonic()
            stage = "double-checking"
            yield _progress("recheck", "Double-checking against the till receipt" if receipt else "Double-checking")
            problem = (
                f"That JSON was invalid: {json_error}\nReturn corrected JSON only." if json_error else
                "Your answer doesn't add up against the till receipt and the item list:\n- " + "\n- ".join(hard + soft)
                + "\nWatch again and return corrected JSON only."
            )
            follow_up = contents_for(plain)
            if result.content is not None:
                follow_up.append(result.content)
            follow_up.append(types.Content(role="user", parts=[types.Part.from_text(text=problem)]))
            try:
                again = gateway.generate(
                    model, follow_up, config_for(model, plain), deadline=deadline, retries=0,
                    timeout_ms=settings.watch_timeout_ms,
                )
                second, hard2, _, _ = _parse(again.text, receipt, confirmed)
                if second is not None and (not hard2 or chosen is None or chosen_hard):
                    chosen, chosen_hard = second, hard2
            except GeminiUnavailable:
                pass  # out of time or busy: keep the first answer
            timings["recheck_ms"] = _ms(step)

        if chosen is None:
            verdict = _inconclusive("Gemini's answer could not be validated, so this needs a human look.")
        elif chosen_hard:
            verdict = _inconclusive(
                "Gemini's item list contradicted the till receipt, so this needs a human look. "
                + " ".join(chosen_hard),
                chosen,
            )
        else:
            verdict = chosen

        # ---- 5. Price, save, cache ----
        incident = _build_incident(verdict, camera, transaction, tool_results, tool_log, toolbox, model, started)
        incident.zones_used = zones
        timings["total_ms"] = _ms(started)
        incident.timings = timings
        repo.save_incident(incident)
        repo.cache_put(key, {"incident_id": incident.id})
        yield {"type": "result", "incident": incident.model_dump(), "cached": False}
    except GeminiUnavailable as exc:
        elapsed = time.monotonic() - started
        yield {
            "type": "error",
            "message": f"{exc} (while {stage}, after {elapsed:.0f} s)",
            "stage": stage,
            "code": exc.code,
            "elapsed_s": round(elapsed, 1),
        }
    finally:
        if uploaded is not None:
            gateway.delete_file(uploaded.name)  # clips are analysed, never kept


def _receipt_lines(transaction: Transaction | None, tool_results: list[dict]) -> list[ReceiptLine]:
    if transaction is not None:
        return list(transaction.lines)
    result = next((t["result"] for t in tool_results if t["tool"] == "get_pos_transaction"), None)
    if not result or not result.get("found"):
        return []
    return [ReceiptLine(name=line["name"], price_inr=line["price_inr"]) for line in result.get("lines", [])]


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
