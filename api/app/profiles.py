"""Sessions for the users collection.

Each person is one Firestore document (email, role, password hash). The signing secret
stays in the environment. A token is an HMAC over the email, role, and expiry.
Roster members can also sign in with Google; the Firebase ID token is checked in main.py.
"""

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from typing import Literal

from .config import Settings
from .models import UserAccount

Role = Literal["manager", "user"]
TOKEN_TTL_S = 12 * 60 * 60
# "Remember me" on the login page asks for a longer token
REMEMBER_TTL_S = 30 * 24 * 60 * 60
PBKDF2_ROUNDS = 120_000
# Failed password sign-ins per email per fixed window, then /api/session answers 429 until the window ends
LOGIN_FAILS_MAX = 10
LOGIN_WINDOW_S = 15 * 60
# Hashed against when the email is unknown, so a miss costs the same time as a wrong password
_DUMMY_SALT = "shrinksight-no-such-user"


@dataclass(frozen=True)
class Principal:
    email: str
    role: Role


def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), PBKDF2_ROUNDS).hex()


def _password_ok(password: str, user: UserAccount | None) -> bool:
    # Always hash once, so unknown and disabled accounts answer as slowly as a wrong password
    digest = hash_password(password, user.password_salt if user else _DUMMY_SALT)
    if user is None or not password or not user.enabled:
        return False
    return hmac.compare_digest(digest, user.password_hash)


def failed_login_key(email: str, now: float | None = None) -> tuple[str, int]:
    """Counter key for this email's current window, and seconds until that window ends."""
    moment = time.time() if now is None else now
    window = int(moment // LOGIN_WINDOW_S)
    # Hashed so the counter id holds no email and no characters Firestore rejects
    who = hashlib.sha256(email.strip().lower().encode()).hexdigest()[:24]
    return f"login-fail-{who}-{window}", int((window + 1) * LOGIN_WINDOW_S - moment) + 1


def _sign(secret: str, body: str) -> str:
    return hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()


def issue_session(settings: Settings, repo, email: str, password: str, remember: bool = False) -> dict | None:
    user = repo.get_user_by_email(email)
    if not _password_ok(password, user):
        return None
    return _mint(settings, user, remember)


def issue_google_session(settings: Settings, repo, claims: dict, remember: bool = False) -> dict | None:
    """Google sign-in for people already on the roster. Unknown emails are not created."""
    email = claims.get("email")
    provider = (claims.get("firebase") or {}).get("sign_in_provider")
    if not email or claims.get("email_verified") is not True or provider != "google.com":
        return None
    user = repo.get_user_by_email(str(email))
    if user is None or not user.enabled:
        return None
    return _mint(settings, user, remember)


def _mint(settings: Settings, user: UserAccount, remember: bool) -> dict:
    role = user.role
    normalised = user.email
    exp = int(time.time()) + (REMEMBER_TTL_S if remember else TOKEN_TTL_S)
    payload = {"email": normalised, "role": role, "exp": exp}
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":")).encode()).decode().rstrip("=")
    return {"email": normalised, "role": role, "exp": exp, "token": f"{body}.{_sign(settings.auth_secret, body)}"}


def principal_from_header(settings: Settings, header: str | None, repo) -> Principal | None:
    if not header or not header.lower().startswith("bearer "):
        return None
    token = header.split(" ", 1)[1].strip()
    body, dot, sig = token.partition(".")
    if not body or not dot or not hmac.compare_digest(_sign(settings.auth_secret, body), sig):
        return None
    padded = body + "=" * (-len(body) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(padded))
        email = str(payload["email"])
        role = payload["role"]
        exp = int(payload["exp"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None
    if role not in ("manager", "user") or exp < int(time.time()):
        return None
    user = repo.get_user_by_email(email)
    if user is None or not user.enabled or user.role != role:
        return None
    return Principal(email=user.email, role=user.role)
