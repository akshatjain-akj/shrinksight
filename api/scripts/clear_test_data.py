"""Deletes your test data from Firestore and keeps the seed (demo) data.

Usage (from api/):

    uv run python scripts/clear_test_data.py            # dry run: lists what would be deleted
    uv run python scripts/clear_test_data.py --yes      # deletes it
    uv run python scripts/clear_test_data.py --yes --reset-seed   # ...and restores the seed data as shipped
    uv run python scripts/clear_test_data.py --yes --demo         # ...and the demo-clip results (clips stay)

Deletes live incidents, receipts typed on Investigate, the cache pointers to investigations, manager feedback that
isn't part of the seed, every camera's auto-tuned edge gate, and cameras, zones and rules added on the site (for
example by judges in the demo store). Never deletes inc-seed-*, TXN-L1-*/TXN-L2-*, seed cameras, zones or rules.
--reset-seed also makes the API rewrite the seed documents (example incidents un-reviewed again, seed roles restored)
the next time an instance starts.
Needs Google credentials for the project: `gcloud auth application-default login`, or GOOGLE_APPLICATION_CREDENTIALS
pointing at a service-account key. Clips are never stored, so there is no video to delete.
"""

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.cleanup import select_test_data  # noqa: E402

COLLECTIONS = ("incidents", "transactions", "cache", "feedback", "edge_config", "cameras", "zones", "rules")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default=os.environ.get("GCP_PROJECT", "shrinksight-app"))
    parser.add_argument("--yes", action="store_true", help="really delete (default is a dry run)")
    parser.add_argument("--demo", action="store_true",
                        help="also delete the analysed results of demo clips (the clips stay in storage)")
    parser.add_argument("--reset-seed", action="store_true",
                        help="also restore the seed documents as shipped (on the next API start)")
    args = parser.parse_args()

    from google.cloud import firestore

    db = firestore.Client(project=args.project)
    docs = {name: {d.id: d.to_dict() or {} for d in db.collection(name).stream()} for name in COLLECTIONS}
    doomed = select_test_data(docs, include_demo=args.demo)

    total = sum(len(ids) for ids in doomed.values())
    for name, ids in doomed.items():
        kept = len(docs[name]) - len(ids)
        print(f"{name:13} delete {len(ids):4}  keep {kept:4}")
    if args.reset_seed:
        print("reset seed    the API rewrites the seed documents on its next start")
    if not total and not args.reset_seed:
        print("Nothing to delete.")
        return
    if not args.yes:
        print(f"\nDry run: {total} documents would be deleted. Re-run with --yes to do it.")
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
    if args.reset_seed:
        # The API re-seeds when meta/seed is missing or out of date; a new instance picks this up on start.
        db.collection("meta").document("seed").delete()
        print("Seed marker cleared: the next API instance restores the seed data "
              "(redeploy, or wait for scale-to-zero).")


if __name__ == "__main__":
    main()
