# ShrinkSight

> *Sees what the till missed.*

**Theme:** Retail & Commerce: Intelligent Customer and Business Experiences · Google Cloud AI Builder Cup 2026

ShrinkSight is a two-tier loss-prevention system. On-device vision (MediaPipe, in the browser) flags suspicious
moments. A Gemini agent then investigates each one: it watches the clip, cross-checks it against the till log
through tool calls, and returns a structured, evidence-backed incident, or rejects the false alarm.

- **Live URL:** https://shrinksight-app.web.app

### What you can try (prototype v0.2)
| Page | What it does |
|---|---|
| **Monitor** (`/`) | Live incident feed (Firestore real-time), false-alarm funnel, camera tiles |
| **Incident** (`/incident?id=…`) | Gemini's verdict, agent steps, *seen on camera vs. till receipt*, estimated loss in ₹, human Confirm / Dismiss |
| **Investigate a clip** (`/investigate`) | Upload or record a clip → Gemini agent (video understanding + tool calls + structured output) → new incident, with live progress |
| **Rules** (`/rules`) | Plain-English rule → Gemini structured rule → validated → saved and toggleable |
| **Setup check** (`/setup`) | Verifies Cloud Run, Firestore, Storage, Auth and Gemini |
- **Plan:** [`docs/PLAN.md`](docs/PLAN.md) · **Architecture:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
  **Setup & deployment:** [`docs/SETUP_AND_DEPLOYMENT.md`](docs/SETUP_AND_DEPLOYMENT.md) ·
  **New teammate?** [`docs/TEAMMATE_SETUP.md`](docs/TEAMMATE_SETUP.md)

## Google AI & Cloud services
| Service | Used for |
|---|---|
| Gemini API (AI Studio) | Tier-2 investigation agent (video understanding, function calling, structured output) |
| MediaPipe Tasks Vision | Tier-1 on-device detection *(coming)* |
| Cloud Run | FastAPI investigation API |
| Firebase Hosting | Static web app + `/api/**` rewrite to Cloud Run |
| Firestore · Cloud Storage · Secret Manager | Incidents & cache · evidence clips (24 h) · Gemini key |
| Firebase Auth | Anonymous sessions |

## Repository layout
```
api/     FastAPI service (Python 3.12, uv) → Cloud Run
web/     Next.js static export (TypeScript) → Firebase Hosting
infra/   one-time Google Cloud setup script (Cloud Shell)
docs/    plan, architecture, setup & deployment guides
.github/ CI/CD (tests on every PR, keyless deploy on merge to main)
```

## Local development
**API**
```bash
cd api
uv sync                       # installs deps from uv.lock
uv run pytest -q              # tests (no cloud access needed)
uv run ruff check .
cp ../.env.example .env       # then type your own Gemini key into api/.env
set -a; . ./.env; set +a
# REPO_BACKEND=memory runs without Google credentials (seed data in memory, resets on restart)
REPO_BACKEND=memory CORS_ORIGINS=http://localhost:3000 uv run uvicorn app.main:app --reload --port 8080
```

**Web**
```bash
cd web
npm install
NEXT_PUBLIC_API_BASE=http://localhost:8080 npm run dev   # http://localhost:3000
```

**Environment variables (API)**

| Name | Purpose |
|---|---|
| `GEMINI_API_KEY` | Gemini key (Secret Manager in production; your own `.env` locally) |
| `GEMINI_MODEL` | Optional model override (default in `api/app/config.py`) |
| `GCP_PROJECT` | Google Cloud project (`shrinksight-app`) |
| `EVIDENCE_BUCKET` | Evidence bucket (`shrinksight-app-evidence`) |
| `GEMINI_INVESTIGATOR_MODEL` | Optional model for clip investigations (defaults to `GEMINI_MODEL`) |
| `REPO_BACKEND` | `firestore` (default) or `memory` for local runs |
| `CORS_ORIGINS` | Local dev (`http://localhost:3000`), or the Hosting origin if streaming goes direct to Cloud Run |

## Deployment
Merging to `main` makes GitHub Actions run the tests, build the API image, deploy it to Cloud Run, deploy the
web app and Firestore rules to Firebase Hosting, and smoke-test the live URL. Authentication is keyless
(Workload Identity Federation); the repo holds no secrets. See `docs/SETUP_AND_DEPLOYMENT.md` Part D.

## Data & licences
All data is synthetic or footage staged by the team with signed consent. No real customer data or PII.
