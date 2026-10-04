"""Persistence: one interface, two implementations.

FirestoreRepo is used on Cloud Run. MemoryRepo backs the tests and local runs without credentials.
Documents are stored as plain JSON-friendly dicts so the browser can read them directly.
"""

import re
import threading
import time
from typing import Any, Protocol

from . import seed
from .models import Camera, Incident, Rule, Sku, Transaction, Zone


class Repo(Protocol):
    def ensure_seeded(self) -> None: ...
    def cameras(self) -> list[Camera]: ...
    def zones(self) -> list[Zone]: ...
    def skus(self) -> list[Sku]: ...
    def transactions(self, lane_id: str | None = None) -> list[Transaction]: ...
    def get_transaction(self, txn_id: str) -> Transaction | None: ...
    def save_transaction(self, txn: Transaction) -> None: ...
    def incidents(self, limit: int = 50) -> list[Incident]: ...
    def get_incident(self, incident_id: str) -> Incident | None: ...
    def save_incident(self, incident: Incident) -> None: ...
    def rules(self) -> list[Rule]: ...
    def get_rule(self, rule_id: str) -> Rule | None: ...
    def save_rule(self, rule: Rule) -> None: ...
    def cache_get(self, key: str) -> dict | None: ...
    def cache_put(self, key: str, value: dict) -> None: ...
    def incr(self, key: str, ttl_s: int) -> int: ...


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
    }


class MemoryRepo:
    def __init__(self, seeded: bool = True):
        self._data: dict[str, dict[str, dict]] = {}
        self._lock = threading.Lock()
        if seeded:
            self.ensure_seeded()

    def ensure_seeded(self) -> None:
        with self._lock:
            for collection, docs in _seed_documents().items():
                self._data.setdefault(collection, {}).update(docs)

    def _all(self, collection: str) -> list[dict]:
        return list(self._data.get(collection, {}).values())

    def _get(self, collection: str, doc_id: str) -> dict | None:
        return self._data.get(collection, {}).get(doc_id)

    def _put(self, collection: str, doc_id: str, doc: dict) -> None:
        with self._lock:
            self._data.setdefault(collection, {})[doc_id] = doc

    def cameras(self) -> list[Camera]:
        return [Camera(**d) for d in self._all("cameras")]

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
        items = sorted(self._all("incidents"), key=lambda d: d["created_at"], reverse=True)
        return [Incident(**d) for d in items[:limit]]

    def get_incident(self, incident_id: str) -> Incident | None:
        doc = self._get("incidents", incident_id)
        return Incident(**doc) if doc else None

    def save_incident(self, incident: Incident) -> None:
        self._put("incidents", incident.id, incident.model_dump())

    def rules(self) -> list[Rule]:
        return sorted((Rule(**d) for d in self._all("rules")), key=lambda r: r.created_at, reverse=True)

    def get_rule(self, rule_id: str) -> Rule | None:
        doc = self._get("rules", rule_id)
        return Rule(**doc) if doc else None

    def save_rule(self, rule: Rule) -> None:
        self._put("rules", rule.id, rule.model_dump())

    def cache_get(self, key: str) -> dict | None:
        return self._get("cache", key)

    def cache_put(self, key: str, value: dict) -> None:
        self._put("cache", key, value)

    def incr(self, key: str, ttl_s: int) -> int:
        with self._lock:
            counters = self._data.setdefault("counters", {})
            counters[key] = {"n": counters.get(key, {}).get("n", 0) + 1}
            return counters[key]["n"]


class FirestoreRepo:
    def __init__(self, project: str | None = None):
        from google.cloud import firestore  # lazy: keeps cold start fast

        self._fs = firestore
        self._db = firestore.Client(project=project or None)
        self._seeded = False

    def ensure_seeded(self) -> None:
        """Writes seed documents once per seed version. Cheap after the first call per instance."""
        if self._seeded:
            return
        meta = self._db.collection("meta").document("seed")
        snapshot = meta.get()
        if not snapshot.exists or (snapshot.to_dict() or {}).get("version") != seed.SEED_VERSION:
            batch = self._db.batch()
            for collection, docs in _seed_documents().items():
                for doc_id, doc in docs.items():
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
        query = (
            self._db.collection("incidents")
            .order_by("created_at", direction=self._fs.Query.DESCENDING)
            .limit(limit)
        )
        return [Incident(**d.to_dict()) for d in query.stream()]

    def get_incident(self, incident_id: str) -> Incident | None:
        doc = self._get("incidents", incident_id)
        return Incident(**doc) if doc else None

    def save_incident(self, incident: Incident) -> None:
        self._put("incidents", incident.id, incident.model_dump())

    def rules(self) -> list[Rule]:
        return sorted((Rule(**d) for d in self._all("rules")), key=lambda r: r.created_at, reverse=True)

    def get_rule(self, rule_id: str) -> Rule | None:
        doc = self._get("rules", rule_id)
        return Rule(**doc) if doc else None

    def save_rule(self, rule: Rule) -> None:
        self._put("rules", rule.id, rule.model_dump())

    def cache_get(self, key: str) -> dict | None:
        return self._get("cache", key)

    def cache_put(self, key: str, value: dict) -> None:
        self._put("cache", key, value)

    def incr(self, key: str, ttl_s: int) -> int:
        """Atomic counter. `expire_at` lets a Firestore TTL policy clean old counters up."""
        ref = self._db.collection("counters").document(key)
        ref.set({"n": self._fs.Increment(1), "expire_at": time.time() + ttl_s}, merge=True)
        return int((ref.get().to_dict() or {}).get("n", 1))
