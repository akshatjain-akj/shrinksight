"""Renames the old "admin" role to "manager" on every user in Firestore.

Usage (from api/):

    uv run python scripts/migrate_admin_to_manager.py            # dry run: lists who would change
    uv run python scripts/migrate_admin_to_manager.py --yes      # updates them

Run it right before or right after deploying the "manager" release: that code rejects role "admin", so anyone
still stored with it cannot sign in and the roster page fails to load. Safe to run more than once. Only the role
field is written; names, password hashes and the enabled flag stay as they are. Needs Google credentials for the
project: `gcloud auth application-default login`, or GOOGLE_APPLICATION_CREDENTIALS pointing at a service-account key.
"""

import argparse
import os

OLD, NEW = "admin", "manager"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project", default=os.environ.get("GCP_PROJECT", "shrinksight-app"))
    parser.add_argument("--yes", action="store_true", help="really update (default is a dry run)")
    args = parser.parse_args()

    from google.cloud import firestore

    db = firestore.Client(project=args.project)
    users = db.collection("users")
    stale = [d for d in users.stream() if (d.to_dict() or {}).get("role") == OLD]

    for doc in stale:
        print(f"{doc.id:24} {(doc.to_dict() or {}).get('email', '?'):40} {OLD} -> {NEW}")
    if not stale:
        print(f'No users with role "{OLD}". Nothing to do.')
        return
    if not args.yes:
        print(f"\nDry run: {len(stale)} users would change. Re-run with --yes to update them.")
        return

    batch = db.batch()
    for doc in stale:
        batch.update(users.document(doc.id), {"role": NEW})
    batch.commit()
    print(f'\nUpdated {len(stale)} users to "{NEW}". They need to sign in again.')


if __name__ == "__main__":
    main()
