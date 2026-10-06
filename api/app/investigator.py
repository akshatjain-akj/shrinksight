"""Tier-2 investigator: Gemini watches a clip once and returns a structured, receipt-checked verdict.

Flow (each step is streamed to the browser as a progress event):
  1. Server-side lookups: the till receipt (self-checkout) or the zone policy (shop floor). We know what is
     needed, so there is no tool round trip and the video is not re-sent for it.
  2. One Gemini call: marked stills + zone close-ups + the clip + receipt/zone context, forced into the
     VerdictOut JSON schema. Thinking is kept low; overloaded models fall back to backup models.
  3. Receipt-first reconciliation. Only if the answer contradicts the receipt (or isn't valid JSON) and time
     allows, Gemini is asked once more. A remaining contradiction becomes INCONCLUSIVE, never a false alarm.
  4. Prices are added deterministically, the incident is saved and cached.
Two optional extras ride along in the same request (no extra Gemini calls): the camera's memory (the manager's
latest confirm/dismiss decisions, as text) and a reference photo of this store's scanning device.
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

from . import memory as camera_memory
from .config import Settings
from .gemini import FALLBACK_CODES, Gateway, GeminiUnavailable, add_usage, model_chain, seconds_left, thinking_config
from .models import (
    LEFT_BEHIND,
    POSITIVE_VERDICTS,
    Camera,
    Feedback,
    Incident,
    InventoryItem,
    ReceiptLine,
    TokenUsage,
    ToolCallLog,
    Transaction,
    UnscannedItem,
    VerdictOut,
    ZoneHint,
    status_for,
)
from .reconcile import (
    apply_floor_rule,
    apply_receipt_rule,
    confirmed_list_text,
    floor_problems,
    receipt_lines_text,
    reconcile,
)
from .repo import Repo, match_sku
from .zones import from_crop, zones_context

# A backup model only helps if it can still watch the whole clip; re-checks need a little less.
BACKUP_MIN_SECONDS = 20
RECHECK_MIN_SECONDS = 15

# Part of every cache key: changing the prompts below must produce fresh analyses, not old cached ones.
PROMPT_VERSION = "2026-10-06.item-moment"
CLOSE_UP_LABELS = {"pickup_start", "scanner_mid", "bagging_end", "hand_reach", "hand_hold"}

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
    "hand_reach": "Close-up: the hands when the on-device check saw a reach",
    "hand_hold": "Close-up: the hands when the on-device check saw a possible hide",
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
   - Bundled items (taped, rubber-banded, or in one tray) are listed separately, unless the receipt sells them as
     one line (e.g. "biscuits 3-pack"), in which case they are one item.
2. Follow every item, in order, with its clip timestamp. Match each one to the till receipt line it corresponds
   to by what it looks like (each line matches at most one item). An item is unscanned ONLY if no receipt line
   matches it. The receipt is the truth about what was scanned.
3. For each item record where it FINISHED (ended_in): bag, in_hand (kept by the shopper, visibly), concealed
   (pocket, clothing or a personal bag), pile (never moved), put_back, or unclear. Also note its path relative
   to the scanner zone (location); "never_near_scanner" means the item moved to the bag or the shopper WITHOUT
   passing the scanner, not that it stayed still.
   The scanner may be a real scanner or a marked area (paper, tape, a box); use the marked zones when given.
4. Chain of custody: for each item give picked_up_at, scanner_at (null if it never reached the scanner) and
   ended_at, as clip timestamps. Base every conclusion on these observed moments.
5. Never answer BENIGN if an item that is not on the receipt ended in the bag or with the shopper; that is
   SCAN_AVOIDANCE. BENIGN means every item matched the receipt, or stayed in the pile, or was put back.

Object provenance (decides personal vs. store items):
- An object that comes out of the shopper's own clothing or bag and goes back there is a personal item (phone,
  wallet, keys): BENIGN.
- An object that comes from a store shelf, the item pile or the counter and goes into clothing or a personal bag
  without being paid is a store item: CONCEALMENT or SCAN_AVOIDANCE.
Benign look-alikes (not theft): sliding a phone into a back pocket; rotating an item and scanning it again after
a failed read; pulling stuck plastic bags apart at the bagging area; reading a label near a pocket and putting the
item back; putting down a personal bag brought into the store.

Method for the shop floor (zone policy provided):
1. List every item the person handled in seen_items, including small, thin or flat ones; they are easy to miss, so
   watch the hands closely and use the hand close-ups. scanned is always false on the shop floor.
2. came_from: shelf (the shelf zone, or any surface or object in or under it, such as a chair, box or ledge),
   own_clothing_or_bag (it came out of the person's own pocket, clothing or bag first), or unclear.
3. ended_in: in_hand (still visibly held or carried), concealed (put into a pocket, clothing, a sleeve, the
   waistband or a personal bag, even briefly or partly), put_back, or unclear. Give picked_up_at and ended_at.
4. A store item (came_from shelf) that ended concealed is CONCEALMENT, however small the item and however quick the
   movement. Carrying an item openly in the hand, or putting it into a store basket or cart, is BENIGN, unless the
   person crosses a marked exit zone with it (RULE_BREACH: left with an unpaid item).
5. An object that came out of the person's own clothing or bag and went back there is a personal item: BENIGN.
- A person lying flat on the floor is a health hazard, not a theft. Use RULE_BREACH and say they are down.
  Bending or reaching toward a shelf is not a fall.

Format: timestamps are relative to the clip start, mm:ss.s. Bounding boxes use [ymin, xmin, ymax, xmax]
normalised to 0-1000. For each seen item, t is the moment it is most clearly visible in the hand (for an item that
gets hidden, just before it is hidden), and box_2d is drawn tightly around the item itself at exactly that moment.
Stills, when attached, come first: time-ordered stills, then close-ups at higher detail.
Labelled outlines mark the zones (ITEMS in pink, SCANNER in amber, BAGGING in blue); a red rectangle marks the
person when present. Judge the stills and the video together.
"""

VERDICT_INSTRUCTION = """Return the verdict as JSON matching the schema.
inventory: every separate item in the item pile at the start, each with a box (self-checkout), else empty. If a
confirmed item list is given, you may leave inventory empty: set inventory_id on each seen item instead.
Leave starting_items empty.
seen_items: every item you saw handled. For each: receipt_line = the number of the receipt line it matches (each
line used at most once), or null if no line matches; scanned = true exactly when receipt_line is set; location =
its path relative to the scanner zone; ended_in = where it finished (bag, in_hand, concealed, pile, put_back,
unclear); came_from = where it was first picked up.
items_seen and items_scanned must match seen_items.
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
    camera: Camera,
    repo: Repo,
    tier1_events: list[dict] | None = None,
    hints: list[ZoneHint] | None = None,
    crop: list[int] | None = None,
) -> str:
    all_zones = repo.zones()
    zones = [z for z in all_zones if z.id in camera.zone_ids]
    zone_lines = "\n".join(f"- {z.id}: {z.name} ({z.kind})" for z in zones)
    lane = f"Lane id: {camera.lane_id}\n" if camera.lane_id else ""
    text = f"Camera: {camera.name} ({camera.kind})\n{lane}Zones in view:\n{zone_lines}"
    marked = zones_context(hints or [], all_zones, crop)
    if marked:
        text += "\n\n" + marked
    if not tier1_events:
        return text
    hints = "\n".join(_hint_line(e) for e in tier1_events[:12])
    header = "On-device Tier-1 hints (times are from the start of this clip; verify on the clip, they are not proof):"
    return f"{text}\n\n{header}\n{hints}"


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
        # Only the item-pile close-up needs full detail (it's where items are counted); the rest stay light so
        # Gemini answers faster.
        level = "HIGH" if label == "pickup_start" else "MEDIUM" if label in CLOSE_UP_LABELS else "LOW"
        parts.append(types.Part(
            inline_data=types.Blob(data=data, mime_type="image/jpeg"),
            media_resolution=_resolution(types, level, plain),
        ))
    return parts


SCANNER_REF_TEXT = (
    "Reference photo: this store's scanning device at this camera's checkout (it may be a real scanner or a marked "
    "stand-in, and the photo may be low quality). An item counts as scanned only if it passes over THIS device or its "
    "marked scanner zone. Passing an item over any other object (a phone, paper, the counter, an empty hand) is not a "
    "scan, and neither is a gesture that never brings the item to the device."
)


def _scanner_ref_parts(types, photo: bytes | None, plain: bool = False) -> list:
    if not photo:
        return []
    return [
        types.Part.from_text(text=SCANNER_REF_TEXT),
        types.Part(inline_data=types.Blob(data=photo, mime_type="image/jpeg"),
                   media_resolution=_resolution(types, "MEDIUM", plain)),
    ]


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
    memory: str = "",
) -> str:
    parts = [context]
    if memory:
        parts.append(memory)
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


def clip_fps(settings: Settings, clip_seconds: float | None) -> int:
    """Frames per second Gemini samples: denser for short clips, sparser for long ones, middle if unknown."""
    if clip_seconds is None:
        return settings.clip_fps
    if clip_seconds <= settings.short_clip_seconds:
        return settings.short_clip_fps
    if clip_seconds > settings.long_clip_seconds:
        return settings.long_clip_fps
    return settings.clip_fps


def _ms(since: float) -> int:
    return round((time.monotonic() - since) * 1000)


# How much of the video settings a call sends. A 400 steps down one level at a time, so a model that only rejects
# media resolution or thinking still gets the fps (at the default 1 fps a sub-second sweep can fall between frames).
FULL, FPS_ONLY, PLAIN = 0, 1, 2
RETRY_LABELS = {FPS_ONLY: "Retrying the clip with only the frame rate set",
                PLAIN: "Retrying the clip without video settings"}


def _watch(gateway: Gateway, models: list[str], contents_for, config_for, deadline: float):
    """One Gemini call with backup models. A generator so it can stream progress; returns (result, model, level)."""
    for index, model in enumerate(models):
        level = FULL
        while True:
            try:
                # The main call may use all the time left: a slow answer beats abandoning it.
                result = gateway.generate(
                    model, contents_for(level), config_for(model, level), deadline=deadline, retries=1
                )
                return result, model, level
            except GeminiUnavailable as exc:
                if exc.code == 400 and level < PLAIN:
                    # Some models reject fps / media resolution / thinking settings on a browser WebM.
                    level += 1
                    yield _progress("watching", RETRY_LABELS[level])
                    continue
                has_backup = index < len(models) - 1
                if exc.code in FALLBACK_CODES and has_backup and seconds_left(deadline) >= BACKUP_MIN_SECONDS:
                    backup = models[index + 1]
                    why = {404: "isn't available", 429: "is rate limited"}.get(exc.code, "is busy")
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
    video_crop: list[int] | None = None,
    memory: list[Feedback] | None = None,
    scanner_photo: bytes | None = None,
    scanner_photo_source: str | None = None,
    origin: str | None = None,
    edge_confidence: float | None = None,
    inventory_usage: TokenUsage | None = None,
) -> Iterator[dict]:
    """Yields progress events, then exactly one `result` or `error` event.

    `memory` is this camera's feedback (newest first); the latest few are added to the prompt. `scanner_photo` is a
    JPEG of the store's scanning device, from this upload or the camera's saved photo (`scanner_photo_source`).
    """
    started = time.monotonic()
    deadline = started + settings.agent_deadline_s
    models = model_chain(settings.investigator_model, settings.fallback_models)
    zones = zones or []
    fps = clip_fps(settings, clip_seconds)
    confirmed = inventory or []
    remembered = camera_memory.pick(memory or [], settings.memory_examples)
    photo_hash = hashlib.sha256(scanner_photo).hexdigest()[:16] if scanner_photo else ""
    variant = f"{settings.investigator_model}@{fps}fps|" + json.dumps(
        [[i.description for i in confirmed], video_crop, camera_memory.version(remembered), photo_hash]
    )
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
        context = _context_text(camera, repo, tier1_events, zones, video_crop)
        marked = _scanner_ref_parts(types, scanner_photo) + _still_parts(types, stills or [])
        marked_plain = [*_scanner_ref_parts(types, scanner_photo, plain=True),
                        *_still_parts(types, stills or [], plain=True)]
        if remembered:
            yield _progress("memory", f"Using {len(remembered)} past decision{'s' if len(remembered) != 1 else ''} "
                            "from this camera")
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
        clip_parts = {
            FULL: types.Part(
                **source,
                video_metadata=types.VideoMetadata(fps=fps),
                media_resolution=_resolution(types, "LOW", plain=False),
            ),
            FPS_ONLY: types.Part(**source, video_metadata=types.VideoMetadata(fps=fps)),
            PLAIN: types.Part(**source),
        }
        timings["upload_ms"] = _ms(step)

        briefing = _briefing(context, receipt, tool_results, camera, confirmed, camera_memory.memory_text(remembered))

        def contents_for(level: int) -> list:
            stills_part = marked if level == FULL else marked_plain
            parts = [*stills_part, clip_parts[level], types.Part.from_text(text=briefing)]
            return [types.Content(role="user", parts=parts)]

        def config_for(model: str, level: int):
            plain = level != FULL
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
        result, model, level = yield from _watch(gateway, models, contents_for, config_for, deadline)
        timings["watch_ms"] = _ms(step)
        usage = add_usage({}, result.usage)
        first, hard, soft, json_error = _parse(result.text, receipt, confirmed)
        if first is not None and camera.kind == "floor":
            soft = soft + floor_problems(first)
        chosen, chosen_hard = (first, hard) if first is not None else (None, [])

        # ---- 4. One re-check, only if the answer doesn't add up and there's time ----
        if (json_error or hard or soft) and seconds_left(deadline) >= RECHECK_MIN_SECONDS:
            step = time.monotonic()
            stage = "double-checking"
            yield _progress("recheck", "Double-checking against the till receipt" if receipt else "Double-checking")
            problem = (
                f"That JSON was invalid: {json_error}\nReturn corrected JSON only." if json_error else
                ("Your answer doesn't add up against the till receipt and the item list:\n- " if receipt else
                 "Your answer doesn't add up:\n- ") + "\n- ".join(hard + soft)
                + "\nWatch again and return corrected JSON only."
            )
            follow_up = contents_for(level)
            if result.content is not None:
                follow_up.append(result.content)
            follow_up.append(types.Content(role="user", parts=[types.Part.from_text(text=problem)]))
            try:
                again = gateway.generate(model, follow_up, config_for(model, level), deadline=deadline, retries=0)
                usage = add_usage(usage, again.usage)
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

        # Boxes Gemini drew on the cropped video, mapped back onto the full camera view for the evidence overlay.
        if video_crop:
            for item in verdict.seen_items:
                item.box_2d = from_crop(item.box_2d, video_crop)

        # ---- 5. Receipt-check safety rule: Gemini can clear an alert only when the receipt agrees ----
        receipt_note, overridden = None, False
        if camera.kind == "checkout" and receipt:
            verdict, receipt_note, overridden = apply_receipt_rule(verdict, receipt)
        elif camera.kind == "floor":
            verdict, receipt_note, overridden = apply_floor_rule(verdict)

        # ---- 6. Price, save, cache ----
        incident = _build_incident(verdict, camera, transaction, tool_results, tool_log, toolbox, model, started)
        incident.receipt_check = receipt_note
        incident.overridden = overridden
        incident.video_crop = video_crop
        incident.zones_used = zones
        incident.origin = origin
        incident.edge_confidence = edge_confidence
        incident.usage = TokenUsage(**usage) if usage else None
        incident.inventory_usage = inventory_usage
        incident.memory_used = camera_memory.refs(remembered)
        incident.scanner_photo = scanner_photo_source if scanner_photo else None
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


def _floor_loss(item, verdict_kind: str) -> bool:
    """On the shop floor an item openly in the hand is not a loss, unless it was carried past the exit (RULE_BREACH)."""
    if item.ended_in == "in_hand":
        return verdict_kind == "RULE_BREACH"
    return item.ended_in in ("concealed", "unclear")


def _build_incident(verdict, camera, transaction, tool_results, tool_log, toolbox, model, started) -> Incident:
    receipt_result = next((t["result"] for t in tool_results if t["tool"] == "get_pos_transaction"), None)
    receipt_txn = transaction
    if receipt_txn is None and receipt_result and receipt_result.get("found"):
        receipt_txn = toolbox.repo.get_transaction(receipt_result["transaction_id"])

    unscanned: list[UnscannedItem] = []
    if verdict.verdict in POSITIVE_VERDICTS:
        for item in verdict.seen_items:
            if item.scanned or item.ended_in in LEFT_BEHIND or item.came_from == "own_clothing_or_bag":
                continue  # paid for, never left the pile, or the person's own: not a loss
            if camera.kind == "floor" and not _floor_loss(item, verdict.verdict):
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
