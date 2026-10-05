"""Camera zone helpers: describing marked zones to Gemini, and asking Gemini to suggest zones from a frame."""

import hashlib
import json
import time

from pydantic import ValidationError

from .gemini import Gateway, call_with_fallback, model_chain
from .models import Camera, Zone, ZoneHint, ZonePoint, ZoneSuggestion, ZoneSuggestionsOut

SUGGEST_PROMPT_VERSION = "2026-10-05.1"

KIND_GUIDE = {
    "pickup": "where items wait before scanning (a basket, a pile, or the near end of the counter)",
    "scanner": "where items are scanned at a self-checkout. In staged setups this may be a sheet of paper, "
    "a taped square, a box or a phone, not a real scanner",
    "bagging": "where items are put after scanning (a bag, box, tray or the far end of the counter)",
    "shelf": "the shelf or display area merchandise is taken from",
    "exit": "the doorway or exit area",
}

SUGGEST_SYSTEM = """You locate fixed areas in a still frame from a store camera.
Return one entry per requested zone id. Use [ymin, xmin, ymax, xmax] normalised to 0-1000.
Set found=false (and leave box_2d empty) if the area is not visible; never guess a box for something you can't see.
description: a few words on what marks the area visually, e.g. "white paper square on the counter".
Describe objects and places only, never people."""


def zones_context(hints: list[ZoneHint], zones: list[Zone]) -> str:
    """Text block telling Gemini exactly where each marked zone is in the picture."""
    if not hints:
        return ""
    names = {z.id: z.name for z in zones}
    lines = []
    for hint in hints:
        box = ", ".join(str(n) for n in hint.box_2d())
        described = f" · looks like: {hint.description}" if hint.description else ""
        lines.append(f"- {hint.zone_id} {names.get(hint.zone_id, hint.zone_id)} ({hint.kind}): [{box}]{described}")
    return (
        "Marked zones ([ymin, xmin, ymax, xmax] on a 0-1000 grid; the same zones are outlined on any attached "
        "stills: ITEMS in pink, SCANNER in amber, BAGGING in blue):\n" + "\n".join(lines)
    )


def box_to_polygon(box: list[int]) -> list[ZonePoint]:
    ymin, xmin, ymax, xmax = (max(0, min(1000, n)) / 1000 for n in box)
    return [ZonePoint(x=xmin, y=ymin), ZonePoint(x=xmax, y=ymin), ZonePoint(x=xmax, y=ymax), ZonePoint(x=xmin, y=ymax)]


def _clean(suggestion: ZoneSuggestion, allowed: set[str]) -> ZoneSuggestion | None:
    if suggestion.zone_id not in allowed:
        return None
    box = suggestion.box_2d
    valid = len(box) == 4 and all(0 <= n <= 1000 for n in box) and box[2] - box[0] >= 10 and box[3] - box[1] >= 10
    if suggestion.found and not valid:
        return suggestion.model_copy(update={"found": False, "box_2d": []})
    return suggestion if suggestion.found else suggestion.model_copy(update={"box_2d": []})


def suggest_zones(
    image: bytes,
    mime: str,
    camera: Camera,
    zones: list[Zone],
    gateway: Gateway,
    model: str,
    repo,
    fallbacks: tuple[str, ...] = (),
) -> tuple[list[ZoneSuggestion], bool]:
    """Returns (suggestions, cached). One entry per zone of this camera."""
    from google.genai import types

    camera_zones = [z for z in zones if z.id in camera.zone_ids]
    key = "zones:" + hashlib.sha256(
        image + json.dumps([camera.id, model, SUGGEST_PROMPT_VERSION]).encode()
    ).hexdigest()
    cached = repo.cache_get(key)
    if cached:
        return [ZoneSuggestion(**s) for s in cached["suggestions"]], True

    wanted = "\n".join(f"- {z.id}: {z.name} — {KIND_GUIDE.get(z.kind, z.kind)}" for z in camera_zones)
    prompt = f"Camera: {camera.name} ({camera.kind}).\nFind these zones:\n{wanted}"
    config = types.GenerateContentConfig(
        system_instruction=SUGGEST_SYSTEM,
        response_mime_type="application/json",
        response_schema=ZoneSuggestionsOut,
        temperature=0,
    )
    result, _ = call_with_fallback(
        gateway,
        model_chain(model, fallbacks),
        [types.Part.from_bytes(data=image, mime_type=mime), prompt],
        lambda _model: config,
        deadline=time.monotonic() + 25,
    )
    allowed = {z.id for z in camera_zones}
    try:
        parsed = ZoneSuggestionsOut.model_validate_json(result.text)
    except ValidationError:
        parsed = ZoneSuggestionsOut(zones=[])
    cleaned = {s.zone_id: s for s in (_clean(s, allowed) for s in parsed.zones) if s is not None}
    suggestions = [cleaned.get(z.id, ZoneSuggestion(zone_id=z.id, found=False)) for z in camera_zones]
    if parsed.zones:
        repo.cache_put(key, {"suggestions": [s.model_dump() for s in suggestions]})
    return suggestions, False
