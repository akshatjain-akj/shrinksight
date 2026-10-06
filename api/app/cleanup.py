"""Picks out test data to delete, never touching the seed data (used by scripts/clear_test_data.py).

Test data = live incidents and typed receipts, the cache pointers to investigations, manager feedback on live
incidents, and every camera's auto-tuned edge gate. Seed documents (inc-seed-*, TXN-L1-*, feedback on seed incidents)
stay, so the demo store is never emptied.
"""

SEED_INCIDENT_PREFIX = "inc-seed-"


def select_test_data(docs: dict[str, dict[str, dict]]) -> dict[str, list[str]]:
    """docs: {collection: {doc_id: document}}. Returns {collection: [doc ids to delete]}."""
    def ids(collection: str, keep) -> list[str]:
        return sorted(doc_id for doc_id, doc in docs.get(collection, {}).items() if not keep(doc_id, doc))

    return {
        "incidents": ids("incidents", lambda i, d: d.get("source") == "seed" or i.startswith(SEED_INCIDENT_PREFIX)),
        "transactions": ids("transactions", lambda i, d: d.get("source", "seed") == "seed"),
        # Only the "same clip = instant result" pointers; inventory, rule and zone caches are harmless to keep.
        "cache": ids("cache", lambda i, d: not i.startswith("inv:")),
        "feedback": ids("feedback", lambda i, d: i.startswith(SEED_INCIDENT_PREFIX)),
        "edge_config": ids("edge_config", lambda i, d: False),
    }
