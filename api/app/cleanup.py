"""Picks out test data to delete, never touching the seed data (used by scripts/clear_test_data.py).

Test data = live incidents and typed receipts, the cache pointers to investigations, manager feedback that isn't part
of the seed, every camera's auto-tuned edge gate, and cameras, zones and rules added on the site (for example by
judges in the demo store). Seed documents stay, so the demo store is never emptied.
"""

from . import seed

SEED_INCIDENT_PREFIX = "inc-seed-"


def select_test_data(docs: dict[str, dict[str, dict]], include_demo: bool = False) -> dict[str, list[str]]:
    """docs: {collection: {doc_id: document}}. Returns {collection: [doc ids to delete]}.

    Demo-clip results (source "demo") are kept unless include_demo; the clips themselves stay in storage either way.
    """
    def ids(collection: str, keep) -> list[str]:
        return sorted(doc_id for doc_id, doc in docs.get(collection, {}).items() if not keep(doc_id, doc))

    seed_cameras = {c.id for c in seed.CAMERAS}
    seed_zones = {z.id for z in seed.ZONES}
    seed_feedback = {f.incident_id for f in seed.FEEDBACK}
    return {
        "incidents": ids("incidents", lambda i, d: d.get("source") == "seed" or i.startswith(SEED_INCIDENT_PREFIX)
                         or (d.get("source") == "demo" and not include_demo)),
        "transactions": ids("transactions", lambda i, d: d.get("source", "seed") == "seed"),
        # Only the "same clip = instant result" pointers; inventory, rule and zone caches are harmless to keep.
        "cache": ids("cache", lambda i, d: not i.startswith("inv:") and not (include_demo and i.startswith("demo:"))),
        # Reviews on seed incidents beyond the seeded ones are test data too; re-seeding restores the seeded ones.
        "feedback": ids("feedback", lambda i, d: i in seed_feedback),
        "edge_config": ids("edge_config", lambda i, d: False),
        "cameras": ids("cameras", lambda i, d: i in seed_cameras),
        # Zones of added cameras go with them; zones added to a seed camera are that camera's setup and stay.
        "zones": ids("zones", lambda i, d: i in seed_zones or d.get("camera_id") in seed_cameras),
        "rules": ids("rules", lambda i, d: d.get("source") == "seed"),
    }
