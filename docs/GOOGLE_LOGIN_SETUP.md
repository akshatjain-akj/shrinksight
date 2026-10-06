# Google Login Setup

> Companion to `SETUP_AND_DEPLOYMENT.md`. Covers the one-time console steps that make **Sign in with Google** on
> `/login` work, locally and on the deployed site. The code is already in the repo; nothing here needs a code change.
>
> **Budget: USD 0.** Firebase Authentication with the Google provider is free at this scale.

---

## 1. How it works (30-second version)

1. The login page opens Google's account picker with Firebase Auth (`signInWithPopup`, `web/lib/firebase.ts`).
2. Firebase returns an **ID token**. The browser sends it to `POST /api/session/google` (`web/lib/api.ts`).
3. The API checks the token's signature, expiry and audience (`GCP_PROJECT`) with `google-auth`
   (`api/app/main.py`). It then requires all three:
   - the email is **verified** by Google,
   - the sign-in provider is **google.com**,
   - the email is **already on the roster** (Firestore `users` collection) and the account is enabled.
4. If all pass, the API issues the same session token as password login. Role (`manager` / `user`) and
   **Remember me** (30 days vs 12 hours) work the same way.

**Google login never creates accounts.** A Google account whose email is not on the roster gets
"This Google account is not on the store roster". To let someone in, add them to the roster first.

---

## 2. Console steps (owner, browser only, ~10 min)

All in the Firebase console for project **`shrinksight-app`**: https://console.firebase.google.com/project/shrinksight-app

### 2.1 Enable the Google provider
- [ ] **Build → Authentication → Sign-in method → Add new provider → Google**.
- [ ] Toggle **Enable**.
- [ ] **Project support email**: pick the owner's personal Gmail (it is shown on Google's consent screen).
- [ ] **Save**.

Leave **Anonymous** enabled. The app still uses anonymous sign-in for Firestore reads.

### 2.2 Authorised domains
- [ ] **Authentication → Settings → Authorized domains**. Make sure every domain the app is opened from is listed:

| Domain | Needed for | Usually present by default |
|---|---|---|
| `localhost` | local dev (`http://localhost:3000`) | Yes |
| `shrinksight-app.firebaseapp.com` | Firebase auth handler | Yes |
| `shrinksight-app.web.app` | deployed Hosting site | Yes |
| `shrinksight.web.app` (or any extra Hosting site) | if you created a second site | **No, add it** |
| Custom domain | if you connect one | **No, add it** |
| Raw Cloud Run URL (`*.run.app`) | only if judges open the API host directly | **No, add it** (not recommended) |

If a domain is missing, the popup fails with `auth/unauthorized-domain` (see section 5).

### 2.3 OAuth consent screen (check once)
Enabling the provider creates an OAuth client and consent screen in Google Cloud.
- [ ] Open https://console.cloud.google.com/apis/credentials/consent?project=shrinksight-app and check that the
  **app name** and **support email** look right (judges will see this screen).

`[UNVERIFIED]` I have not checked whether a Firebase-created consent screen starts in **Testing** mode for this
project. If it does, only listed test users can sign in. If a non-test roster account is refused on the Google
screen itself (before returning to the app), switch the publishing status to **In production**. The app asks only
for the basic `email` / `profile` scopes, so Google verification should not be required for that. Check
this before recording the demo.

---

## 3. API configuration

The API needs two values. They go in Cloud Run env (production) or `api/.env` (local). Never commit them.

| Variable | Value | Why |
|---|---|---|
| `GCP_PROJECT` | `shrinksight-app` | ID-token **audience**. Without it `/api/session/google` returns 503 "Google sign-in is not configured". |
| `AUTH_SECRET` | long random string (`openssl rand -hex 32`) | Signs session tokens. Without it **all** logins return 503 "Profiles are not configured". |

### 3.1 Production (Cloud Run)
- `GCP_PROJECT` is already set by the deploy workflow (`.github/workflows/ci-cd.yml`).
- `AUTH_SECRET` comes from Secret Manager secret **`auth-secret`**. The deploy step injects it with
  `--set-secrets GEMINI_API_KEY=gemini-api-key:latest,AUTH_SECRET=auth-secret:latest`. Do not set it by hand
  in the Cloud Run console: each deploy replaces the service's env vars and secrets.
- The secret must exist **before** the next deploy, or the deploy fails. `infra/setup-gcp.sh` (step 6) creates
  it and grants the runtime service account access. It is safe to re-run. To do only this step by hand
  (Cloud Shell):
  ```bash
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create auth-secret --replication-policy automatic \
    --data-file=- --project=shrinksight-app
  gcloud secrets add-iam-policy-binding auth-secret --project=shrinksight-app \
    --member "serviceAccount:<RUNTIME_SA>" --role roles/secretmanager.secretAccessor
  ```
  `<RUNTIME_SA>` is the GitHub variable `RUNTIME_SA` (the `api-runtime` service account).
- Rotating `AUTH_SECRET` signs everyone out (old tokens stop verifying). That is harmless.

### 3.2 Local
In `api/.env` (gitignored; template in `.env.example`):
```
GCP_PROJECT=shrinksight-app
AUTH_SECRET=<any long random string>
REPO_BACKEND=memory
```
- No Google credentials are needed for Google login itself. The API only downloads Google's public signing keys,
  so it needs internet access.
- With `REPO_BACKEND=memory`, the roster is the seed users in `api/app/seed.py`. Sign in with a Google account
  whose email is one of those, or add yours to the seed for local testing (do not commit real personal emails).
- Run the API with `--reload` so backend changes are picked up:
  ```bash
  cd api && .venv/bin/uvicorn app.main:app --port 8080 --reload
  ```
- Web: `NEXT_PUBLIC_API_BASE=http://localhost:8080` and `CORS_ORIGINS=http://localhost:3000` (already in
  `.env.example`).

---

## 4. Roster: who can sign in with Google

- The roster email must **exactly match** the Google account's email (compared lowercase).
  `name.surname@gmail.com` and `namesurname@gmail.com` are different strings to the app, even though Gmail treats
  them the same.
- Roles come from the roster, not from Google. A manager signing in with Google is still a manager.
- Disabled roster accounts (`enabled: false`) are refused on both login paths.
- **Judges:** they cannot use their own Google accounts unless you add those emails to the roster. For the
  scoring round, make sure the README's demo email + password works. Google login is a convenience for the team.

---

## 5. Verify (incognito window, ~2 min)

- [ ] Open `/login` → **Sign in with Google** → pick a roster account → lands on `/monitor`.
- [ ] Nav shows **Rules** and **Settings** only for a `manager` account.
- [ ] Tick **Remember me**, sign in with Google, close the browser, reopen → still signed in.
- [ ] Pick a Google account **not** on the roster → stays on `/login` with
  "This Google account is not on the store roster".
- [ ] Close the popup without choosing → nothing happens, no error.

---

## 6. Troubleshooting

| What you see | Cause | Fix |
|---|---|---|
| "Google sign-in failed." + console shows `auth/unauthorized-domain` | Current domain not authorised | Section 2.2 |
| "Google sign-in failed." + console shows `auth/operation-not-allowed` | Google provider not enabled | Section 2.1 |
| "Allow pop-ups for this site, then try again." | Browser blocked the popup | Allow pop-ups for the site |
| "This Google account is not on the store roster" | Email not in `users`, unverified, or disabled | Section 4 |
| "Google sign-in could not be verified" | Token audience/signature wrong: `GCP_PROJECT` doesn't match the Firebase project, or clock skew | Set `GCP_PROJECT=shrinksight-app`; check system clock |
| "Google sign-in is not configured" (503) | `GCP_PROJECT` missing on the API | Section 3 |
| "Profiles are not configured" (503) | `AUTH_SECRET` missing on the API | Section 3.1 |
| "Google sign-in is unavailable. Please try again." (503) | API couldn't download Google's signing keys | Check outbound internet from the API; retry |
| "Signed in, but this account's profile isn't supported by this version of the app." | API and web are on different releases (e.g. API still returns role `admin`) | Redeploy / restart the API; run `api/scripts/migrate_admin_to_manager.py` against Firestore |
| Google's own screen says the app is in testing / access blocked | Consent screen in Testing mode | Section 2.3 |

The exact Firebase error code is in the browser DevTools console. The page shows a generic message for codes
it doesn't handle specifically.
