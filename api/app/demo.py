"""Demo mode: clips in the bucket's demo/ folder play on the Monitor as if they were live cameras.

Layout: demo/checkout/<clip> and demo/floor/<clip>, each with an optional <clip>.json next to it holding the receipt,
the zones and the expected verdict. The folder is listed on demand (cached a few minutes), so clips uploaded from the
Cloud console or the terminal appear without any registration. Each camera is assigned one clip of its kind; each clip
is analysed once (through Investigate) and that incident is the clip's result, reused on every loop.
"""

import json
import re
import threading
import time
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Protocol

from .models import Camera

PREFIX = "demo/"
KINDS = ("checkout", "floor")
VIDEO_TYPES = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"}
LIST_TTL_S = 300
RESULT_KEY = "demo:"  # cache key prefix: demo:<object> -> {"incident_id": ...}
_SAFE = re.compile(r"[^a-z0-9._-]+")


@dataclass
class DemoClip:
    object: str
    kind: str
    size: int = 0
    updated: str = ""
    sidecar: dict = field(default_factory=dict)

    @property
    def name(self) -> str:
        return self.object.rsplit("/", 1)[-1]


def kind_of(object_name: str) -> str | None:
    """'demo/floor/x.mp4' -> 'floor'. None for anything outside demo/<kind>/ or not a video."""
    parts = object_name.split("/")
    if len(parts) != 3 or parts[0] + "/" != PREFIX or parts[1] not in KINDS or not parts[2]:
        return None
    if ".." in object_name or not any(parts[2].lower().endswith(ext) for ext in VIDEO_TYPES):
        return None
    return parts[1]


def object_name(kind: str, filename: str) -> str:
    """A safe object name for an upload: demo/<kind>/<lowercase name with only a-z 0-9 . _ ->."""
    stem, dot, ext = filename.lower().rpartition(".")
    if not dot or f".{ext}" not in VIDEO_TYPES:
        stem, ext = filename.lower(), "mp4"
    stem = _SAFE.sub("-", stem).strip("-.") or "clip"
    return f"{PREFIX}{kind}/{stem[:60]}.{ext}"


def sidecar_name(object_name: str) -> str:
    return f"{object_name}.json"


def assign(kind: str, clips: list[DemoClip], cameras: list[Camera]) -> str | None:
    """The least-used clip of this kind (ties broken by name), or None if there is none."""
    mine = sorted(c.object for c in clips if c.kind == kind)
    if not mine:
        return None
    uses = {name: 0 for name in mine}
    for camera in cameras:
        if camera.demo_clip in uses:
            uses[camera.demo_clip] += 1
    return min(mine, key=lambda name: (uses[name], name))


def fill(cameras: list[Camera], clips: list[DemoClip]) -> list[Camera]:
    """Gives every camera without a (still existing) clip one of its kind. Returns the cameras that changed."""
    existing = {c.object for c in clips}
    changed: list[Camera] = []
    for camera in sorted(cameras, key=lambda c: c.id):
        if camera.demo_clip in existing:
            continue
        pick = assign(camera.kind, clips, cameras)
        if pick != camera.demo_clip:
            camera.demo_clip = pick
            changed.append(camera)
    return changed


class DemoStore(Protocol):
    def list(self) -> list[DemoClip]: ...
    def save(self, object_name: str, data: bytes, mime: str, sidecar: dict) -> None: ...
    def delete(self, object_name: str) -> None: ...
    def sign(self, object_name: str, minutes: int) -> str: ...


class MemoryDemoStore:
    """Tests and local runs without a bucket."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str, dict]] = {}

    def list(self) -> list[DemoClip]:
        return [DemoClip(object=name, kind=kind_of(name) or "", size=len(data), sidecar=dict(meta))
                for name, (data, _mime, meta) in sorted(self.objects.items())]

    def save(self, object_name: str, data: bytes, mime: str, sidecar: dict) -> None:
        self.objects[object_name] = (data, mime, sidecar)

    def delete(self, object_name: str) -> None:
        self.objects.pop(object_name, None)

    def sign(self, object_name: str, minutes: int) -> str:
        return f"https://storage.test/{object_name}"


class GcsDemoStore:
    """The evidence bucket's demo/ folder. Signing uses the same key / signBlob path as the other clip URLs."""

    def __init__(self, client, bucket: str, signer) -> None:
        self._bucket = client.bucket(bucket)
        self._client = client
        self._bucket_name = bucket
        self._signer = signer

    def list(self) -> list[DemoClip]:
        blobs = list(self._client.list_blobs(self._bucket_name, prefix=PREFIX))
        sidecars = {b.name: b for b in blobs if b.name.endswith(".json")}
        clips: list[DemoClip] = []
        for blob in blobs:
            kind = kind_of(blob.name)
            if kind is None:
                continue
            meta: dict = {}
            side = sidecars.get(sidecar_name(blob.name))
            if side is not None:
                try:
                    meta = json.loads(side.download_as_bytes(timeout=10) or b"{}")
                except (ValueError, OSError):
                    meta = {}
            updated = blob.updated.isoformat() if getattr(blob, "updated", None) else ""
            clips.append(DemoClip(object=blob.name, kind=kind, size=int(blob.size or 0), updated=updated,
                                  sidecar=meta if isinstance(meta, dict) else {}))
        return clips

    def save(self, object_name: str, data: bytes, mime: str, sidecar: dict) -> None:
        self._bucket.blob(object_name).upload_from_string(data, content_type=mime, timeout=120)
        self._bucket.blob(sidecar_name(object_name)).upload_from_string(
            json.dumps(sidecar, ensure_ascii=False, indent=2), content_type="application/json", timeout=30)

    def delete(self, object_name: str) -> None:
        for name in (object_name, sidecar_name(object_name)):
            blob = self._bucket.blob(name)
            if blob.exists():
                blob.delete()

    def sign(self, object_name: str, minutes: int) -> str:
        return self._signer(self._bucket.blob(object_name), timedelta(minutes=minutes))


class CachedListing:
    """The bucket listing, cached per instance; saves and deletes refresh it at once."""

    def __init__(self, ttl_s: int = LIST_TTL_S) -> None:
        self._ttl = ttl_s
        self._at = 0.0
        self._clips: list[DemoClip] = []
        self._store: object | None = None
        self._lock = threading.Lock()

    def get(self, store: DemoStore) -> list[DemoClip]:
        with self._lock:
            if store is not self._store or time.monotonic() - self._at > self._ttl:
                self._clips = store.list()
                self._store = store
                self._at = time.monotonic()
            return list(self._clips)

    def invalidate(self) -> None:
        with self._lock:
            self._at = 0.0


def clean_sidecar(raw: dict) -> dict:
    """Only the fields we use, so a hand-written .json can't smuggle anything else into a prompt."""
    out: dict = {}
    receipt = raw.get("receipt")
    if isinstance(receipt, list):
        lines = []
        for line in receipt[:30]:
            if isinstance(line, dict) and str(line.get("name", "")).strip():
                try:
                    price = float(line.get("price_inr", 0))
                except (TypeError, ValueError):
                    price = 0.0
                lines.append({"name": str(line["name"]).strip()[:80], "price_inr": max(0.0, min(price, 1_000_000))})
        out["receipt"] = lines
    if isinstance(raw.get("zones"), list):
        out["zones"] = raw["zones"][:8]
    expected = raw.get("expected")
    if isinstance(expected, str) and expected.strip():
        out["expected"] = expected.strip().upper()[:24]
    return out
