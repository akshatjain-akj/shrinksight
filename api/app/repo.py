"""Persistence: one interface, two implementations.

FirestoreRepo is used on Cloud Run. MemoryRepo backs the tests and local runs without credentials.
Documents are stored as plain JSON-friendly dicts so the browser can read them directly.
"""

import re
import threading
import time
from typing import Any, Protocol

from . import seed
from .models import (
    Camera,
    CameraLayout,
    CameraPrefs,
    EdgeConfig,
    Feedback,
    Incident,
    Rule,
    Sku,
    Transaction,
    UserAccount,
    Zone,
)


class Repo(Protocol):
    def ensure_seeded(self) -> None: ...
    def cameras(self) -> list[Camera]: ...
    def save_camera(self, camera: Camera) -> None: ...
    def save_zone(self, zone: Zone) -> None: ...
    def delete_zone(self, zone_id: str) -> None: ...
    def delete_camera(self, camera_id: str) -> None: ...
    def zones(self) -> list[Zone]: ...
    def skus(self) -> list[Sku]: ...
    def transactions(self, lane_id: str | None = None) -> list[Transaction]: ...
    def get_transaction(self, txn_id: str) -> Transaction | None: ...
    def save_transaction(self, txn: Transaction) -> None: ...
    def incidents(self, limit: int = 50) -> list[Incident]: ...
    def get_incident(self, incident_id: str) -> Incident | None: ...
    def save_incident(self, incident: Incident) -> None: ...
    def delete_incident(self, incident_id: str) -> None: ...
    def purge_expired(self) -> int: ...
    def rules(self) -> list[Rule]: ...
    def get_user_by_email(self, email: str) -> UserAccount | None: ...
    def users(self) -> list[UserAccount]: ...
    def save_user(self, user: UserAccount) -> None: ...
    def get_rule(self, rule_id: str) -> Rule | None: ...
    def save_rule(self, rule: Rule) -> None: ...
    def cache_get(self, key: str) -> dict | None: ...
    def cache_put(self, key: str, value: dict) -> None: ...
    def incr(self, key: str, ttl_s: int) -> int: ...
    def count(self, key: str) -> int: ...
    def layouts(self) -> dict[str, CameraLayout]: ...
    def get_layout(self, camera_id: str) -> CameraLayout | None: ...
    def save_layout(self, layout: CameraLayout) -> None: ...
    def feedback(self, camera_id: str) -> list[Feedback]: ...
    def save_feedback(self, item: Feedback) -> None: ...
    def get_edge_config(self, camera_id: str) -> EdgeConfig | None: ...
    def save_edge_config(self, config: EdgeConfig) -> None: ...
    def get_camera_prefs(self, camera_id: str) -> CameraPrefs | None: ...
    def save_camera_prefs(self, prefs: CameraPrefs) -> None: ...
    def scanner_photos(self) -> dict[str, str]: ...
    def get_scanner_photo(self, camera_id: str) -> tuple[bytes, str] | None: ...
    def save_scanner_photo(self, camera_id: str, data: bytes, updated_at: str) -> None: ...
    def delete_scanner_photo(self, camera_id: str) -> None: ...


_WORD = re.compile(r"[a-z0-9]+")
_STOP = {"a", "an", "the", "of", "pack", "packet", "box", "bottle", "jar", "small", "large", "g", "kg", "ml", "l"}


def _tokens(text: str) -> set[str]:
    return {w for w in _WORD.findall(text.lower()) if w not in _STOP}


def match_sku(description: str, catalogue: list[Sku]) -> Sku | None:
    """Best catalogue match for a free-text item description (token overlap), or None."""
    wanted = _tokens(description)
    best, best_score = None, 0.0
    for sku in catalogue:
        have = _tokens(sku.name)
        if not have or not wanted:
            continue
        score = len(wanted & have) / len(have)
        if score > best_score:
            best, best_score = sku, score
    return best if best_score >= 0.5 else None


def _seed_documents() -> dict[str, dict[str, dict]]:
    return {
        "cameras": {c.id: c.model_dump() for c in seed.CAMERAS},
        "zones": {z.id: z.model_dump() for z in seed.ZONES},
        "skus": {s.sku: s.model_dump() for s in seed.SKUS},
        "transactions": {t.id: t.model_dump() for t in seed.TRANSACTIONS},
        "incidents": {i.id: i.model_dump() for i in seed.INCIDENTS},
        "rules": {r.id: r.model_dump() for r in seed.RULES},
        "feedback": {f.incident_id: f.model_dump() for f in seed.FEEDBACK},
        "users": {u.id: u.model_dump() for u in seed.USERS},
    }


def _seed_camera(doc: dict, zones: list[dict], gone: set[str]) -> dict:
    """A seed camera as re-seeding should write it: zones the store added stay attached, deleted ones stay gone."""
    ids = [zone_id for zone_id in doc.get("zone_ids") or [] if zone_id not in gone]
    ids += [z["id"] for z in zones if z.get("camera_id") == doc["id"] and z["id"] not in ids and z["id"] not in gone]
    return {**doc, "zone_ids": ids}


class MemoryRepo:
    def __init__(self, seeded: bool = True):
        self._data: dict[str, dict[str, dict]] = {}
        self._lock = threading.Lock()
        self._suppressed: set[tuple[str, str]] = set()
        self._purged_at = 0.0
        if seeded:
            self.ensure_seeded()

    def ensure_seeded(self) -> None:
        with self._lock:
            for collection, docs in _seed_documents().items():
                bucket = self._data.setdefault(collection, {})
                for doc_id, doc in docs.items():
                    if (collection, doc_id) in self._suppressed:
                        bucket.pop(doc_id, None)
                        continue
                    if collection == "users":
                        bucket.setdefault(doc_id, doc)
                    else:
                        bucket[doc_id] = doc
            # Zones are seeded before cameras are fixed up, so a seed camera keeps zones added to it.
            gone = {doc_id for collection, doc_id in self._suppressed if collection == "zones"}
            zones = list(self._data.get("zones", {}).values())
            cameras = self._data.get("cameras", {})
            for camera_id in [c.id for c in seed.CAMERAS if c.id in cameras]:
                cameras[camera_id] = _seed_camera(cameras[camera_id], zones, gone)

    def _all(self, collection: str) -> list[dict]:
        return list(self._data.get(collection, {}).values())

    def _get(self, collection: str, doc_id: str) -> dict | None:
        return self._data.get(collection, {}).get(doc_id)

    def _put(self, collection: str, doc_id: str, doc: dict) -> None:
        with self._lock:
            self._data.setdefault(collection, {})[doc_id] = doc

    def cameras(self) -> list[Camera]:
        return [Camera(**d) for d in self._all("cameras")]

    def save_camera(self, camera: Camera) -> None:
        self._put("cameras", camera.id, camera.model_dump())

    def save_zone(self, zone: Zone) -> None:
        self._put("zones", zone.id, zone.model_dump())

    def delete_zone(self, zone_id: str) -> None:
        with self._lock:
            self._data.get("zones", {}).pop(zone_id, None)
            self._suppressed.add(("zones", zone_id))
            for camera in self._data.get("cameras", {}).values():
                ids = camera.get("zone_ids") or []
                if zone_id in ids:
                    camera["zone_ids"] = [item for item in ids if item != zone_id]

    def delete_camera(self, camera_id: str) -> None:
        with self._lock:
            camera = self._data.get("cameras", {}).pop(camera_id, None)
            self._suppressed.add(("cameras", camera_id))
            zone_ids = set((camera or {}).get("zone_ids") or [])
            zones = self._data.get("zones", {})
            for zone_id, zone in list(zones.items()):
                if zone_id in zone_ids or zone.get("camera_id") == camera_id:
                    zones.pop(zone_id, None)
                    self._suppressed.add(("zones", zone_id))
            self._data.get("layouts", {}).pop(camera_id, None)
            self._data.get("edge_config", {}).pop(camera_id, None)
            self._data.get("camera_prefs", {}).pop(camera_id, None)
            self._suppressed.add(("camera_prefs", camera_id))

    def zones(self) -> list[Zone]:
        return [Zone(**d) for d in self._all("zones")]

    def skus(self) -> list[Sku]:
        return [Sku(**d) for d in self._all("skus")]

    def transactions(self, lane_id: str | None = None) -> list[Transaction]:
        txns = [Transaction(**d) for d in self._all("transactions")]
        txns = [t for t in txns if lane_id is None or t.lane_id == lane_id]
        return sorted(txns, key=lambda t: t.started_at, reverse=True)

    def get_transaction(self, txn_id: str) -> Transaction | None:
        doc = self._get("transactions", txn_id)
        return Transaction(**doc) if doc else None

    def save_transaction(self, txn: Transaction) -> None:
        self._put("transactions", txn.id, txn.model_dump())

    def incidents(self, limit: int = 50) -> list[Incident]:
        self.purge_expired()
        items = sorted(self._all("incidents"), key=lambda d: d["created_at"], reverse=True)
        return [Incident(**d) for d in items[:limit]]

    def get_incident(self, incident_id: str) -> Incident | None:
        doc = self._get("incidents", incident_id)
        if doc and self._drop_if_expired(doc):
            return None
        return Incident(**doc) if doc else None

    def save_incident(self, incident: Incident) -> None:
        self._put("incidents", incident.id, incident.model_dump())

    def delete_incident(self, incident_id: str) -> None:
        # Feedback stays: it is the camera memory, and it outlives the incident it came from
        with self._lock:
            self._data.get("incidents", {}).pop(incident_id, None)

    def purge_expired(self) -> int:
        from .retention import PURGE_EVERY_S, is_expired

        if time.time() - self._purged_at < PURGE_EVERY_S:
            return 0
        self._purged_at = time.time()
        gone = [doc["id"] for doc in self._all("incidents") if is_expired(doc)]
        for incident_id in gone:
            self.delete_incident(incident_id)
        return len(gone)

    def _drop_if_expired(self, doc: dict) -> bool:
        from .retention import is_expired

        if not is_expired(doc):
            return False
        self.delete_incident(str(doc.get("id") or ""))
        return True

    def rules(self) -> list[Rule]:
        return sorted((Rule(**d) for d in self._all("rules")), key=lambda r: r.created_at, reverse=True)

    def get_rule(self, rule_id: str) -> Rule | None:
        doc = self._get("rules", rule_id)
        return Rule(**doc) if doc else None

    def save_rule(self, rule: Rule) -> None:
        self._put("rules", rule.id, rule.model_dump())

    def get_user_by_email(self, email: str) -> UserAccount | None:
        key = email.strip().lower()
        for doc in self._all("users"):
            if doc.get("email") == key:
                return UserAccount(**doc)
        return None

    def users(self) -> list[UserAccount]:
        return sorted((UserAccount(**d) for d in self._all("users")), key=lambda u: (u.role != "manager", u.email))

    def save_user(self, user: UserAccount) -> None:
        self._put("users", user.id, user.model_dump())

    def cache_get(self, key: str) -> dict | None:
        return self._get("cache", key)

    def cache_put(self, key: str, value: dict) -> None:
        self._put("cache", key, value)

    def incr(self, key: str, ttl_s: int) -> int:
        with self._lock:
            counters = self._data.setdefault("counters", {})
            counters[key] = {"n": counters.get(key, {}).get("n", 0) + 1}
            return counters[key]["n"]

    def count(self, key: str) -> int:
        return int((self._get("counters", key) or {}).get("n", 0))

    def layouts(self) -> dict[str, CameraLayout]:
        return {d["camera_id"]: CameraLayout(**d) for d in self._all("layouts")}

    def get_layout(self, camera_id: str) -> CameraLayout | None:
        doc = self._get("layouts", camera_id)
        return CameraLayout(**doc) if doc else None

    def save_layout(self, layout: CameraLayout) -> None:
        self._put("layouts", layout.camera_id, layout.model_dump())

    # ---- manager feedback, edge gate, scanner photos ----
    def feedback(self, camera_id: str) -> list[Feedback]:
        items = [Feedback(**d) for d in self._all("feedback") if d.get("camera_id") == camera_id]
        return sorted(items, key=lambda f: f.reviewed_at, reverse=True)

    def save_feedback(self, item: Feedback) -> None:
        self._put("feedback", item.incident_id, item.model_dump())

    def get_edge_config(self, camera_id: str) -> EdgeConfig | None:
        doc = self._get("edge_config", camera_id)
        return EdgeConfig(**doc) if doc else None

    def save_edge_config(self, config: EdgeConfig) -> None:
        self._put("edge_config", config.camera_id, config.model_dump())

    def get_camera_prefs(self, camera_id: str) -> CameraPrefs | None:
        doc = self._get("camera_prefs", camera_id)
        return CameraPrefs(**doc) if doc else None

    def save_camera_prefs(self, prefs: CameraPrefs) -> None:
        self._put("camera_prefs", prefs.camera_id, prefs.model_dump())

    def scanner_photos(self) -> dict[str, str]:
        return {d["camera_id"]: d["updated_at"] for d in self._all("scanner_photos")}

    def get_scanner_photo(self, camera_id: str) -> tuple[bytes, str] | None:
        doc = self._get("scanner_photos", camera_id)
        return (bytes(doc["data"]), doc["updated_at"]) if doc else None

    def save_scanner_photo(self, camera_id: str, data: bytes, updated_at: str) -> None:
        self._put("scanner_photos", camera_id, {"camera_id": camera_id, "data": data, "updated_at": updated_at})

    def delete_scanner_photo(self, camera_id: str) -> None:
        with self._lock:
            self._data.get("scanner_photos", {}).pop(camera_id, None)


class FirestoreRepo:
    def __init__(self, project: str | None = None):
        from google.cloud import firestore  # lazy: keeps cold start fast

        self._fs = firestore
        self._db = firestore.Client(project=project or None)
        self._seeded = False
        self._purged_at = 0.0

    def ensure_seeded(self) -> None:
        """Writes seed documents once per seed version. Cheap after the first call per instance."""
        if self._seeded:
            return
        meta = self._db.collection("meta").document("seed")
        snapshot = meta.get()
        if not snapshot.exists or (snapshot.to_dict() or {}).get("version") != seed.SEED_VERSION:
            batch = self._db.batch()
            zones = self._all("zones")
            for collection, docs in _seed_documents().items():
                for doc_id, doc in docs.items():
                    if collection == "cameras":
                        doc = _seed_camera(doc, zones, set())
                    batch.set(self._db.collection(collection).document(doc_id), doc)
            batch.set(meta, {"version": seed.SEED_VERSION})
            batch.commit()
        self._seeded = True

    def _all(self, collection: str) -> list[dict]:
        return [d.to_dict() for d in self._db.collection(collection).stream()]

    def _get(self, collection: str, doc_id: str) -> dict | None:
        snapshot = self._db.collection(collection).document(doc_id).get()
        return snapshot.to_dict() if snapshot.exists else None

    def _put(self, collection: str, doc_id: str, doc: dict[str, Any]) -> None:
        self._db.collection(collection).document(doc_id).set(doc)

    def cameras(self) -> list[Camera]:
        return [Camera(**d) for d in self._all("cameras")]

    def save_camera(self, camera: Camera) -> None:
        self._put("cameras", camera.id, camera.model_dump())

    def save_zone(self, zone: Zone) -> None:
        self._put("zones", zone.id, zone.model_dump())

    def delete_zone(self, zone_id: str) -> None:
        zone = self._get("zones", zone_id)
        if zone:
            camera = self._get("cameras", zone.get("camera_id", ""))
            if camera:
                camera["zone_ids"] = [item for item in camera.get("zone_ids") or [] if item != zone_id]
                self._put("cameras", camera["id"], camera)
        self._db.collection("zones").document(zone_id).delete()

    def delete_camera(self, camera_id: str) -> None:
        camera = self._get("cameras", camera_id) or {}
        zone_ids = set(camera.get("zone_ids") or [])
        for zone in self._all("zones"):
            if zone.get("id") in zone_ids or zone.get("camera_id") == camera_id:
                self._db.collection("zones").document(zone["id"]).delete()
        self._db.collection("cameras").document(camera_id).delete()
        self._db.collection("layouts").document(camera_id).delete()
        self._db.collection("edge_config").document(camera_id).delete()
        self._db.collection("camera_prefs").document(camera_id).delete()

    def zones(self) -> list[Zone]:
        return [Zone(**d) for d in self._all("zones")]

    def skus(self) -> list[Sku]:
        return [Sku(**d) for d in self._all("skus")]

    def transactions(self, lane_id: str | None = None) -> list[Transaction]:
        query = self._db.collection("transactions")
        if lane_id:
            query = query.where(filter=self._fs.FieldFilter("lane_id", "==", lane_id))
        txns = [Transaction(**d.to_dict()) for d in query.stream()]
        return sorted(txns, key=lambda t: t.started_at, reverse=True)

    def get_transaction(self, txn_id: str) -> Transaction | None:
        doc = self._get("transactions", txn_id)
        return Transaction(**doc) if doc else None

    def save_transaction(self, txn: Transaction) -> None:
        self._put("transactions", txn.id, txn.model_dump())

    def incidents(self, limit: int = 50) -> list[Incident]:
        self.purge_expired()
        query = (
            self._db.collection("incidents")
            .order_by("created_at", direction=self._fs.Query.DESCENDING)
            .limit(limit)
        )
        return [Incident(**d.to_dict()) for d in query.stream()]

    def get_incident(self, incident_id: str) -> Incident | None:
        doc = self._get("incidents", incident_id)
        if doc and self._drop_if_expired(doc):
            return None
        return Incident(**doc) if doc else None

    def save_incident(self, incident: Incident) -> None:
        self._put("incidents", incident.id, incident.model_dump())

    def delete_incident(self, incident_id: str) -> None:
        # Feedback stays: it is the camera memory, and it outlives the incident it came from
        self._db.collection("incidents").document(incident_id).delete()

    def purge_expired(self) -> int:
        from .retention import PURGE_EVERY_S, is_expired, oldest_kept_iso

        if time.time() - self._purged_at < PURGE_EVERY_S:
            return 0
        self._purged_at = time.time()
        # Only incidents older than the shortest retention can be due, so younger ones are never read
        cutoff = self._fs.FieldFilter("created_at", "<", oldest_kept_iso())
        older = self._db.collection("incidents").where(filter=cutoff)
        gone = [snap.id for snap in older.stream() if is_expired({**(snap.to_dict() or {}), "id": snap.id})]
        for incident_id in gone:
            self.delete_incident(incident_id)
        return len(gone)

    def _drop_if_expired(self, doc: dict) -> bool:
        from .retention import is_expired

        if not is_expired(doc):
            return False
        self.delete_incident(str(doc.get("id") or ""))
        return True

    def rules(self) -> list[Rule]:
        return sorted((Rule(**d) for d in self._all("rules")), key=lambda r: r.created_at, reverse=True)

    def get_rule(self, rule_id: str) -> Rule | None:
        doc = self._get("rules", rule_id)
        return Rule(**doc) if doc else None

    def save_rule(self, rule: Rule) -> None:
        self._put("rules", rule.id, rule.model_dump())

    def get_user_by_email(self, email: str) -> UserAccount | None:
        key = email.strip().lower()
        query = self._db.collection("users").where(filter=self._fs.FieldFilter("email", "==", key)).limit(1)
        found = list(query.stream())
        return UserAccount(**found[0].to_dict()) if found else None

    def users(self) -> list[UserAccount]:
        return sorted((UserAccount(**d) for d in self._all("users")), key=lambda u: (u.role != "manager", u.email))

    def save_user(self, user: UserAccount) -> None:
        self._put("users", user.id, user.model_dump())

    def cache_get(self, key: str) -> dict | None:
        return self._get("cache", key)

    def cache_put(self, key: str, value: dict) -> None:
        self._put("cache", key, value)

    def incr(self, key: str, ttl_s: int) -> int:
        """Atomic counter. `expire_at` lets a Firestore TTL policy clean old counters up."""
        ref = self._db.collection("counters").document(key)
        ref.set({"n": self._fs.Increment(1), "expire_at": time.time() + ttl_s}, merge=True)
        return int((ref.get().to_dict() or {}).get("n", 1))

    def count(self, key: str) -> int:
        return int((self._get("counters", key) or {}).get("n", 0))

    def layouts(self) -> dict[str, CameraLayout]:
        return {d["camera_id"]: CameraLayout(**d) for d in self._all("layouts")}

    def get_layout(self, camera_id: str) -> CameraLayout | None:
        doc = self._get("layouts", camera_id)
        return CameraLayout(**doc) if doc else None

    def save_layout(self, layout: CameraLayout) -> None:
        self._put("layouts", layout.camera_id, layout.model_dump())

    # ---- manager feedback, edge gate, scanner photos ----
    def feedback(self, camera_id: str) -> list[Feedback]:
        # A single-field filter needs no composite index; there are only a few decisions per camera.
        query = self._db.collection("feedback").where(filter=self._fs.FieldFilter("camera_id", "==", camera_id))
        items = [Feedback(**d.to_dict()) for d in query.stream()]
        return sorted(items, key=lambda f: f.reviewed_at, reverse=True)

    def save_feedback(self, item: Feedback) -> None:
        self._put("feedback", item.incident_id, item.model_dump())

    def get_edge_config(self, camera_id: str) -> EdgeConfig | None:
        doc = self._get("edge_config", camera_id)
        return EdgeConfig(**doc) if doc else None

    def save_edge_config(self, config: EdgeConfig) -> None:
        self._put("edge_config", config.camera_id, config.model_dump())

    def get_camera_prefs(self, camera_id: str) -> CameraPrefs | None:
        doc = self._get("camera_prefs", camera_id)
        return CameraPrefs(**doc) if doc else None

    def save_camera_prefs(self, prefs: CameraPrefs) -> None:
        self._put("camera_prefs", prefs.camera_id, prefs.model_dump())

    def scanner_photos(self) -> dict[str, str]:
        # Only the timestamps: the photo bytes are read one camera at a time.
        docs = self._db.collection("scanner_photos").select(["camera_id", "updated_at"]).stream()
        return {d.get("camera_id"): d.get("updated_at") for d in docs}

    def get_scanner_photo(self, camera_id: str) -> tuple[bytes, str] | None:
        doc = self._get("scanner_photos", camera_id)
        return (bytes(doc["data"]), doc["updated_at"]) if doc else None

    def save_scanner_photo(self, camera_id: str, data: bytes, updated_at: str) -> None:
        self._put("scanner_photos", camera_id, {"camera_id": camera_id, "data": data, "updated_at": updated_at})

    def delete_scanner_photo(self, camera_id: str) -> None:
        self._db.collection("scanner_photos").document(camera_id).delete()
