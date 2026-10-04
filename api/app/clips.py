"""Short-lived read URLs for demo clips stored in Cloud Storage.

The browser never receives the service-account key. Only camera ids in SEED_CLIPS can be signed.
"""

import os
from datetime import timedelta
from pathlib import Path

from google.auth.transport.requests import Request as AuthRequest
from google.cloud import storage
from google.oauth2 import service_account

from .config import Settings

# Floor cameras have stored demo clips. Checkout lanes stay as painted scenes.
SEED_CLIPS: dict[str, str] = {
    "cam-aisle-4": "seed/desktop-demo.mov",
    "cam-aisle-2": "seed/test1-theft.mov",
}

SIGNED_URL_MINUTES = 15
_REPO_ROOT = Path(__file__).resolve().parents[2]


def object_for(camera_id: str) -> str | None:
    return SEED_CLIPS.get(camera_id)


def key_path(settings: Settings) -> str | None:
    configured = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS", "").strip()
    if configured and Path(configured).is_file():
        return configured
    bundled = _REPO_ROOT / ".secrets" / "firebase-adminsdk.json"
    if bundled.is_file():
        return str(bundled)
    return None


def _client(settings: Settings) -> storage.Client:
    path = key_path(settings)
    project = settings.gcp_project or None
    if path:
        creds = service_account.Credentials.from_service_account_file(path)
        return storage.Client(project=project or creds.project_id, credentials=creds)
    return storage.Client(project=project)


def sign_seed_clip(settings: Settings, camera_id: str, minutes: int = SIGNED_URL_MINUTES) -> str:
    """Returns an HTTPS GET URL. Raises if this camera has no clip or signing is unavailable."""
    object_name = object_for(camera_id)
    if object_name is None:
        raise KeyError(camera_id)
    if not settings.evidence_bucket:
        raise RuntimeError("EVIDENCE_BUCKET is not set")
    blob = _client(settings).bucket(settings.evidence_bucket).blob(object_name)
    try:
        return blob.generate_signed_url(version="v4", expiration=timedelta(minutes=minutes), method="GET")
    except (AttributeError, ValueError):
        # Cloud Run's runtime account has no private key on disk. IAM signBlob does the signing.
        import google.auth

        credentials, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/cloud-platform"])
        credentials.refresh(AuthRequest())
        email = getattr(credentials, "service_account_email", None)
        if not email or email == "default":
            raise RuntimeError("Clip signing needs a service account key locally, or signBlob on Cloud Run") from None
        return blob.generate_signed_url(
            version="v4",
            expiration=timedelta(minutes=minutes),
            method="GET",
            service_account_email=email,
            access_token=credentials.token,
        )
