"""Deletes your test data from Firestore and keeps the seed (demo) data.

Usage (from api/):

    uv run python scripts/clear_test_data.py            # dry run: lists what would be deleted
    uv run python scripts/clear_test_data.py --yes      # deletes it

Deletes live incidents, receipts typed on Investigate, the cache pointers to investigations, manager feedback on
live incidents and every camera's auto-tuned edge gate. Never deletes inc-seed-*, TXN-L1-*/TXN-L2-* or seed feedback.
Needs Google credentials for the project: `gcloud auth application-default login`, or GOOGLE_APPLICATION_CREDENTIALS
pointing at a service-account key. Clips are never stored, so there is no video to delete.
"""

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.cleanup import select_test_data  # noqa: E402

COLLECTIONS = ("incidents", "transactions", "cache", "feedback", "edge_config")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default=os.environ.get("GCP_PROJECT", "shrinksight-app"))
    parser.add_argument("--yes", action="store_true", help="really delete (default is a dry run)")
    args = parser.parse_args()

    from google.cloud import firestore

    db = firestore.Client(project=args.project)
    docs = {name: {d.id: d.to_dict() or {} for d in db.collection(name).stream()} for name in COLLECTIONS}
    doomed = select_test_data(docs)

    total = sum(len(ids) for ids in doomed.values())
    for name, ids in doomed.items():
        kept = len(docs[name]) - len(ids)
        print(f"{name:13} delete {len(ids):4}  keep {kept:4}")
    if not total:
        print("Nothing to delete.")
        return
    if not args.yes:
        print(f"\nDry run: {total} documents would be deleted. Re-run with --yes to delete them.")
        return

    batch, pending = db.batch(), 0
    for name, ids in doomed.items():
        for doc_id in ids:
            batch.delete(db.collection(name).document(doc_id))
            pending += 1
            if pending == 400:  # Firestore allows 500 writes per batch
                batch.commit()
                batch, pending = db.batch(), 0
    if pending:
        batch.commit()
    print(f"\nDeleted {total} documents. Seed data was kept.")


if __name__ == "__main__":
    main()
