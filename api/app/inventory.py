"""Item-pile inventory: one image-only Gemini call that lists every separate object before the video is watched.

The browser sends up to three views of the item pile in ONE request: the whole pile, plus overlapping left and
right halves at higher zoom (to catch small, dark or flat objects). Gemini returns each object once, with a box in
the coordinates of view 1. Overlapping duplicates are merged here. It runs on its own model (settings.inventory_model)
so it doesn't use the main model's daily quota, and results are cached by image, so re-runs are free.
"""

import hashlib
import json
import time

from pydantic import ValidationError

from .config import Settings
from .gemini import Gateway, add_usage, call_with_fallback, model_chain, thinking_config
from .models import Camera, InventoryItem, InventoryOut

INVENTORY_PROMPT_VERSION = "2026-10-08.1"
MAX_ITEMS = 30
VIEW_TEXT = {
    "pile": "View 1: the whole item pile. Give every box in THIS view's coordinates.",
    "left": "View 2: the left part of the pile, zoomed in (overlaps view 3).",
    "right": "View 3: the right part of the pile, zoomed in (overlaps view 2).",
}

SYSTEM = """You list the objects waiting to be scanned at a self-checkout, from images of the item pile.
- List every separate object exactly once, with a box [ymin, xmin, ymax, xmax] normalised to 0-1000 in VIEW 1.
- Use the zoomed views only to find small, dark, flat or partly hidden objects; never list an object twice.
- Count carefully: thin, small, flat or soft objects are items (cloth or paper flowers, cards, napkins, stickers,
  sachets, pens, cables). A flat item lying on another item can look like a pattern printed on it; list it.
  Objects resting on, inside or next to another object are separate items. A dark item on a dark surface is still
  an item.
- description: a few words on what it looks like (colour, shape, material), never brand guesses.
- Ignore hands, people, the counter, the scanner and the bag themselves. Describe objects only, never people."""


def iou(a: list[int], b: list[int]) -> float:
    if len(a) != 4 or len(b) != 4:
        return 0.0
    y1, x1 = max(a[0], b[0]), max(a[1], b[1])
    y2, x2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, y2 - y1) * max(0, x2 - x1)
    area = lambda box: max(0, box[2] - box[0]) * max(0, box[3] - box[1])  # noqa: E731
    union = area(a) + area(b) - inter
    return inter / union if union else 0.0


def clean_items(items: list[InventoryItem]) -> list[InventoryItem]:
    """Valid boxes only, overlapping duplicates merged (first wins), capped."""
    kept: list[InventoryItem] = []
    for item in items:
        box = item.box_2d
        valid = len(box) == 4 and all(0 <= n <= 1000 for n in box) and box[2] > box[0] and box[3] > box[1]
        candidate = item if valid else item.model_copy(update={"box_2d": []})
        if candidate.box_2d and any(iou(candidate.box_2d, k.box_2d) > 0.5 for k in kept):
            continue
        if candidate.description.strip():
            kept.append(candidate)
        if len(kept) >= MAX_ITEMS:
            break
    return kept


def take_inventory(
    views: list[tuple[str, bytes]], camera: Camera, gateway: Gateway, settings: Settings, repo
) -> tuple[list[InventoryItem], str, bool, dict[str, int]]:
    """Returns (items, model that answered, cached, tokens used; empty when cached)."""
    from google.genai import types

    key_source = json.dumps([camera.id, settings.inventory_model, INVENTORY_PROMPT_VERSION]).encode()
    digest = hashlib.sha256(key_source)
    for label, data in views:
        digest.update(label.encode())
        digest.update(data)
    key = "inventory:" + digest.hexdigest()
    cached = repo.cache_get(key)
    if cached:
        return [InventoryItem(**i) for i in cached["items"]], cached.get("model", ""), True, {}

    parts: list = []
    for label, data in views:
        parts.append(types.Part.from_text(text=VIEW_TEXT.get(label, label)))
        parts.append(types.Part(
            inline_data=types.Blob(data=data, mime_type="image/jpeg"),
            media_resolution=types.PartMediaResolution(level=types.PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH),
        ))
    parts.append(types.Part.from_text(text=f"Camera: {camera.name}. List every object in the item pile."))

    def config(model: str):
        return types.GenerateContentConfig(
            system_instruction=SYSTEM,
            response_mime_type="application/json",
            response_schema=InventoryOut,
            temperature=0,
            seed=settings.gemini_seed or None,
            thinking_config=thinking_config(types, model, settings.thinking_level),
        )

    models = model_chain(settings.inventory_model, settings.fallback_models)
    result, model = call_with_fallback(
        gateway, models, [types.Content(role="user", parts=parts)], config,
        deadline=time.monotonic() + settings.inventory_deadline_s, retries=1,
    )
    try:
        items = clean_items(InventoryOut.model_validate_json(result.text).items)
    except ValidationError:
        items = []
    if items:
        repo.cache_put(key, {"items": [i.model_dump() for i in items], "model": model})
    return items, model, False, add_usage({}, result.usage)
