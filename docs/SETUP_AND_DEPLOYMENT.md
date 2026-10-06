# Setup, Collaboration & Deployment Guide

> Companion to `PLAN.md` (what we build) and `ARCHITECTURE.md` (how it works).
> This file covers **what to set up, where, in what order**, **how the two of us collaborate**, and
> **how code on GitHub ends up running on Google Cloud**.
>
> **Product: ShrinkSight.** Names used below: projects `shrinksight-app` / `shrinksight-ai`, repo `<you>/shrinksight`,
> Cloud Run service `shrinksight-api`, Hosting site `shrinksight` → `https://shrinksight.web.app`.
> Project IDs are permanent; if one is taken, add a short suffix and tell Claude.
>
> **Budget: USD 0.** Free tiers and free-trial credits only. **Never click "Upgrade" on the free trial.**

---

## 0. Which machine does what

| Machine | Used for | Installs needed |
|---|---|---|
| **Windows laptop (personal)** | All account and console work in a browser: Google accounts, Google Cloud, Firebase, AI Studio, GitHub settings, **Cloud Shell** for one-off cloud commands | None (browser only) |
| **Coding machine (this one, WSL)** | Writing code with Claude Code, running tests and local emulators, `git commit` / `git push`, opening PRs | git, Node LTS, Python 3.12 (uv), Java, firebase-tools, gh |
| **GitHub Actions** | Building, testing and deploying to Google Cloud | Nothing (configured in the repo) |

> ⚠️ **Employer IP reminder (context §7):** if the coding machine is an employer device, code written on it may
> fall under your employment agreement. Check your contract or outside-activity policy. Your call; noted for the record.

---

## PART A — Windows laptop (browser only)

### A1. Accounts (both members, ~15 min)
- [ ] A **personal Gmail** each. Never the work email.
- [ ] Owner: pick **one dedicated, long-term personal Gmail** (e.g. `yourname.builds@gmail.com`) to own Google Cloud,
  Firebase and AI Studio. Not throwaway: it's used from day 1 through Demo Day (see Part H).
- [ ] A **personal GitHub account** each, with **2FA turned on** (github.com/settings/security).
- [ ] Register as a **team of 2** on Hack2skill via https://aibuildercup.com **before 11 Oct 2026**.
  Both must be working professionals (not students), 21+, in the JAPAC region.
- [ ] Read the **Initiative Terms & Conditions** (link in `AI_BUILDER_CUP_CLAUDE_CONTEXT.md` §7), especially the
  IP / right-of-first-refusal clause. Decide the repo licence (MIT or Apache-2.0 suggested) **after** reading it.

### A2. Google Cloud — Project A, the app (owner, ~30 min)
Go to https://console.cloud.google.com and sign in with the **personal Gmail**.

1. [ ] **Activate the free trial** ($300 credits, 90 days, which covers Demo Day on 4 Dec).
   - Add a card for identity verification. Some countries show a small temporary hold that is refunded.
   - A free-trial account **can't charge the card** unless you manually upgrade. **Never click "Upgrade".**
2. [ ] **Create project.** Name `shrinksight-app`. **The project ID is permanent**; add a suffix if taken (e.g. `shrinksight-app-7k2`).
3. [ ] **Budget alert:** Billing → Budgets & alerts → Create budget
   - Scope: all projects · Amount: **$1** · Alerts at **50%, 90%, 100%** · Email: both members.
4. [ ] **Add teammate:** IAM & Admin → IAM → **Grant access** → teammate's personal Gmail → role **Owner**.
   They accept the email invite.
5. [ ] **Firestore:** Firestore → Create database
   - Mode: **Native** · Database ID: `(default)` · Location: **`us-central1`** (permanent) · Rules: **Production mode**.
6. [ ] **Turn on the APIs.** Open **Cloud Shell** (the `>_` icon at the top right) and paste:
   ```bash
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
     secretmanager.googleapis.com firestore.googleapis.com storage.googleapis.com \
     iamcredentials.googleapis.com sts.googleapis.com firebase.googleapis.com \
     firebasehosting.googleapis.com identitytoolkit.googleapis.com firebaseappcheck.googleapis.com \
     --project shrinksight-app
   ```

### A3. Firebase on the same project (owner, ~15 min)
Go to https://console.firebase.google.com

1. [ ] **Add project** → choose the **existing** `shrinksight-app`, so you don't create a second project.
   - Google Analytics: **off**.
   - The plan shows **Blaze** because billing is linked. That's expected, and the no-cost quotas still apply.
2. [ ] Project settings → Your apps → **Web** (`</>`) → nickname `web` → **don't** tick Firebase Hosting →
   copy the `firebaseConfig` block. It's public, not secret.
3. [ ] Build → Authentication → Get started → Sign-in method → **Anonymous** → Enable.
4. [ ] (Later, during the build) App Check + reCAPTCHA v3. Claude will guide this step.

### A4. Gemini key — Project B, no billing (owner, ~10 min)
1. [ ] In the Cloud console, create project **`shrinksight-ai`**. If it asks for a billing account, choose **none**.
   Check Billing for this project: *"This project has no billing account."*
2. [ ] Go to https://aistudio.google.com → **Get API key** → **Create API key** → choose (or import) `shrinksight-ai`.
3. [ ] Confirm the key shows the **Free** tier. Note the available **Flash** and **Flash-Lite** model names and
   their rate limits (RPM / RPD).
4. [ ] Save the key in a **password manager**. Never paste it into chat, issues, PRs, commits or any file
   (except your own gitignored `.env`, see B4).

> **Why two projects:** a Gemini key from a billing-enabled project is billed at paid rates. A key from a project
> with no billing stays on the free tier.

### A5. GitHub repository (owner, ~15 min)
1. [ ] **New repository:** public, name **`shrinksight`**.
   **Completely empty**: no README, no .gitignore, no licence.
2. [ ] Settings → **Collaborators** → add your teammate.
3. [ ] Settings → Rules → **New branch ruleset** → target `main`:
   - [x] Require a pull request before merging (**1 approval**)
   - [x] Block force pushes · [x] Restrict deletions
   - Bypass list: repository admins (emergencies only)
   - *Require status checks:* added after CI's first run (Claude will tell you the check name).
4. [ ] Settings → Advanced Security → **Secret scanning + Push protection** on · **Dependabot alerts** on.
5. [ ] Settings → Actions → General → Actions **allowed**.
6. [ ] (Optional) Projects → New project (Board) → columns: Backlog · Today · In progress · In review · Done.

### A6. Day-1 test footage (both, ~30 min)
- [ ] Record **5 phone clips**, 10–20 s each, of a fake self-checkout:
  - Phone up high and angled down, like CCTV. A table as the counter, a **taped square as the "scanner zone"**.
  - 3–5 household items per clip, preferably without prominent logos. In some clips, **one item goes around the
    scanner** instead of over it.
  - No bystanders, no visible personal info.
- [ ] Note the ground truth per clip, e.g. `clip3: 4 items, item 3 skipped at ~0:08`.
- [ ] Upload the clips and notes to your **personal Google Drive** so you can download them on the coding machine.

---

## PART B — Coding machine (WSL)

### B1. Install tools
No `gcloud` is needed here: cloud commands run in Cloud Shell, and deploys run in GitHub Actions.
```bash
sudo apt-get update && sudo apt-get install -y git curl build-essential gh openjdk-21-jre-headless

# Node LTS via nvm (install nvm from https://github.com/nvm-sh/nvm first)
nvm install --lts
npm i -g firebase-tools

# Python 3.12 via uv
curl -LsSf https://astral.sh/uv/install.sh | sh
uv python install 3.12
```
Java is required by the **Firebase emulators** (local Firestore + Auth, no cloud login needed).

### B2. Connect to GitHub for pushing
```bash
gh auth login        # GitHub.com → HTTPS → Login with a web browser
gh auth setup-git    # lets plain `git push` use the gh login
git config --global user.name  "Your Name"
git config --global user.email "<id>+<username>@users.noreply.github.com"
```
- `gh auth login` shows a one-time code. You can finish it in the **Windows laptop's browser**.
- Use your GitHub **noreply** email (github.com/settings/emails) so your personal email isn't public in commits.

### B3. Clone the repo where Claude can work on it
```bash
cd /home/claudeuser/ht
gh repo clone <you>/shrinksight
mkdir -p /home/claudeuser/ht/spike-clips   # put the 5 Drive clips + notes here (never committed)
```

### B4. Local Gemini key (only when Claude asks, on day 1)
After the repo skeleton exists, copy `.env.example` to `.env` (gitignored) and **type the key in yourself**.
Claude never sees or handles the key.

---

## PART C — What to send Claude when Parts A and B are done (nothing secret)
1. Both project IDs + confirmation that Firestore is in `us-central1`.
2. The `firebaseConfig` block.
3. The repo URL + confirmation it's cloned under `/home/claudeuser/ht/`.
4. Your teammate's GitHub username.
5. The Gemini model names + rate limits seen in AI Studio, and confirmation the key exists (**not the key**).
6. Confirmation that the clips + notes are in `/home/claudeuser/ht/spike-clips/`.

---

## PART D — How GitHub code gets hosted on Google

### D1. The idea
**GitHub stores the code and runs the build robot (Actions). Google runs the app.** Every merge to `main` makes
GitHub Actions build the code and push it to Google Cloud. Judges only ever open the Google-hosted URL.
GitHub Pages, Vercel and similar platforms are **not** used (context §2.2).

```
                    YOU (coding machine)
                         │ git push / PR
                         ▼
┌──────────────────────── GitHub ────────────────────────┐
│  Repo (public)                                          │
│  GitHub Actions (free for public repos)                 │
│   1. lint · type-check · tests                          │
│   2. build web  → static files (HTML/JS/CSS)            │
│   3. build API  → Docker image                          │
│   4. log in to Google WITHOUT a stored key (WIF)        │
└───────────┬───────────────────────────┬────────────────┘
            │ firebase deploy           │ docker push + gcloud run deploy
            ▼                           ▼
┌──────────────────── Google Cloud: Project A ───────────────────────┐
│  Firebase Hosting (global CDN)     Artifact Registry               │
│   https://shrinksight.web.app       stores image :<git-sha>        │
│   serves the web app                       │                       │
│   /api/** ── forwards to ──────────► Cloud Run: shrinksight-api    │
│                                       (FastAPI container)          │
│                                       ├─ Gemini key from Secret Mgr│
│                                       ├─ Firestore                 │
│                                       └─ Cloud Storage             │
└────────────────────────────────────────────────────────────────────┘
                         ▲
                 Judge opens https://shrinksight.web.app
```

### D2. The two deploy targets

**Web app → Firebase Hosting**
- Next.js is built as a **static export** (`output: 'export'`): plain HTML, JS and CSS in `web/out/`.
- Served from Google's global CDN: fast, no cold start, free within quota.
- All heavy computer vision (MediaPipe) runs in the visitor's browser, so the frontend needs no server.
- MediaPipe models load from Google's CDN, so they don't count against our Hosting transfer quota.

**API → Cloud Run**
- `api/Dockerfile` (python:3.12-slim + FastAPI + google-genai). Image kept under 300 MB.
- Actions builds the image → tags it with the commit SHA → pushes to **Artifact Registry**
  (`us-central1-docker.pkg.dev/shrinksight-app/shrinksight/api:<sha>`) → runs `gcloud run deploy` with:
  - `--min-instances 0` (no cost when idle) · `--max-instances 2` (hard cost cap) · `--concurrency 20`
  - `--set-secrets GEMINI_API_KEY=gemini-api-key:latest,AUTH_SECRET=auth-secret:latest`: injected at startup from **Secret Manager**,
    never in GitHub or the image
  - `--service-account api-runtime@…` with minimal permissions (Firestore user, one bucket, two secrets)

**One URL for everything**
`firebase.json` has a rewrite: `/api/**` → Cloud Run service `shrinksight-api` (`us-central1`).
The browser only talks to one address: no CORS, one clean URL for judges.

### D3. Keyless login from GitHub to Google (Workload Identity Federation)
1. Once, in Cloud Shell, we tell Google: *"Trust GitHub's identity tokens, but **only** from repo `<you>/shrinksight`."*
2. On each run, Actions gets a short-lived token from GitHub. Google checks it and lends the **`deployer`**
   service account for about an hour.
3. `deployer` can only deploy (Cloud Run, Artifact Registry writes, Firebase Hosting). It can't read the
   Gemini secret or delete anything important.

**Result: zero stored secrets in GitHub.** Forks of the public repo can't deploy, because the trust rule names our exact repo.

### D4. Pipeline per event

| Event | What happens | Result |
|---|---|---|
| **PR opened/updated** | Lint, type-check, tests, build. Web → **Firebase preview channel**. API → **tagged Cloud Run revision with no live traffic**. | Two preview URLs posted on the PR for review. Production untouched. |
| **Merge to `main`** | Build → deploy API revision + Hosting release → **smoke test** (`/api/healthz` + one cached investigation). | Live site updated in about 3–5 min. |
| **Smoke test fails** | Cloud Run traffic moves back to the previous revision. Hosting rollback with one click or command. | Live URL keeps working. |
| **Tag `v1.0-submission`** | Same as a merge, marked as the submitted version. | You can always point to exactly what judges saw. |

### D5. One-time cloud setup (day 1, ~15 min; Claude writes the commands, you paste into Cloud Shell)
1. Artifact Registry repo `shrinksight` in `us-central1`, with a **cleanup policy** keeping the last ~5 images
   (free limit 0.5 GB).
2. Service accounts: **`deployer`** (CI) and **`api-runtime`** (the running app), each with minimal permissions.
3. WIF pool + GitHub provider, restricted to `<you>/shrinksight`.
4. Gemini key → **Secret Manager** (`gemini-api-key`), typed by you with hidden input. Access granted only to `api-runtime`.
5. Cloud Storage bucket (`us-central1`) for seed and evidence clips, with a **24 h lifecycle** on evidence.
6. Non-secret IDs saved as GitHub **variables** (not secrets): project ID, WIF provider, deployer service account email.

### D6. Things to verify on day 1
| Check | If it fails |
|---|---|
| Firebase Hosting **streams** SSE from Cloud Run without buffering | The browser calls the Cloud Run URL directly for `/api/investigate` only, with CORS limited to our domain |
| Hosting → Cloud Run **~60 s request limit** | Not expected to matter: investigations are designed to finish in under 25 s |
| `firebase-tools` deploys with **WIF credentials** | Deploy Hosting via Cloud Build (still keyless). A stored key is the last resort, and only with your approval |

### D7. Why this design
- **Not Firebase App Hosting:** it runs Next.js on a server (Cloud Run underneath), which means more moving parts,
  frontend cold starts and more quota use. We don't need server rendering.
- **GitHub Actions over Cloud Build triggers:** free with unlimited minutes for public repos, and judges see green CI checks.
- **Not GitHub Pages / Vercel / Netlify:** a non-Google platform on the critical path breaks context §2.2.

### D8. Cost check ($0)
| Service | Free allowance | Our use |
|---|---|---|
| Firebase Hosting | 10 GB storage, ~360 MB/day transfer | Small static bundle |
| Cloud Run | ~2M requests, 180k vCPU-seconds, 360k GiB-seconds per month | Tiny; scales to zero |
| Artifact Registry | 0.5 GB | ≤5 images with cleanup policy |
| Secret Manager | 6 secret versions, 10k accesses | 1 secret |
| Firestore / Cloud Storage | 1 GiB + 50k reads/day / 5 GB (US region) | Small |
| GitHub Actions | Unlimited for public repos | CI/CD |
| Gemini API | Free tier (Project B, no billing) | Cached + rate limited |

*(Re-check the exact quota numbers on day 1; Google changes them occasionally.)*

---

## PART E — How the two of us collaborate

### E1. Roles
| | **Dev A, the builder (with Claude)** | **Dev B, the hardener** |
|---|---|---|
| Main job | Builds each feature end to end (browser + backend) | Follows **one feature behind**: reviews every PR, pulls and tests it locally and on preview URLs, then improves it (refactors, edge cases, tests, UX polish, performance) |
| Also owns | Architecture choices, demo script | Evaluation harness + labelled data, CI health, checking the deployment (incognito, mobile, cold start) |
| Shared | Recording footage, demo video, deck | Same |

Swap roles any time someone is blocked.

### E2. Daily workflow
```
 1. Pick an issue from the board          → e.g. "#14 Scanner-bypass rule"
 2. Branch from main                      → feat/14-scanner-bypass
 3. Commit small and often                → "feat(tier1): add scanner-bypass path rule"
 4. Push + open PR                        → CI: lint · type-check · tests · build
 5. Preview environments auto-deploy:
      Web → https://shrinksight--pr-14-xxxx.web.app   (Firebase preview channel, expires in 7 days)
      API → https://pr-14---shrinksight-api-xxxx.run.app   (tagged Cloud Run revision, no live traffic)
 6. Dev B reviews + tests previews        → approves, or pushes fix commits to the same branch
 7. Squash-merge to main                  → CI deploys to production
 8. Post-deploy smoke test                → auto rollback if it fails
```

### E3. Who runs what (coding machine vs. laptop)
| Task | Where | Who |
|---|---|---|
| Write code, tests, local emulators, `git commit` | Coding machine | Claude + Dev A |
| `git push`, `gh pr create` | Coding machine | **Dev A**. Claude's sandbox can't read your GitHub login, so run them in your terminal or with `! git push` in Claude Code |
| Build / test / deploy | GitHub Actions | Automatic |
| One-off cloud setup (WIF, secrets, bucket) | Cloud Shell (laptop) | Claude writes the commands, you paste them |
| Gemini key → Secret Manager | Cloud Shell (laptop) | You (hidden input) |
| PR review, preview testing, improvements | Anywhere | Dev B |

### E4. Ground rules
- **`main` is always deployable.** Never leave it broken overnight. Tag stable evenings `v0.1`, `v0.2`, …;
  the submitted version gets `v1.0-submission`.
- **Small PRs** (roughly 400 lines or fewer), each linked to an issue. The PR template asks: *Which demo-video
  moment does this support? Tests? Screenshot or GIF?*
- **Commit prefixes:** `feat`, `fix`, `chore`, `docs`, `test`.
- **Secrets:** the Gemini key lives only in Secret Manager + each dev's own gitignored `.env`. GitHub holds
  **no secrets**, only non-secret variables.
- **Honest history:** team members make every commit themselves; no prior code is imported.
- **Shared AI context:** `CLAUDE.md` (the context rules) lives in the repo, so both devs' Claude Code sessions follow the same rules.
- **Data:** only synthetic records and footage staged by the team with signed consent. No real PII anywhere.

### E5. Milestones
| Milestone | Date | Definition of done |
|---|---|---|
| **M0** Setup + tests | 4 Oct | Parts A–B done; hello-world deployed through CI; Gemini counting test result known |
| **M1** Thin slice live | 8 Oct | Seeded clip → Tier 1 → Gemini → live incident, on production |
| **M2** Depth | 13 Oct | Tool calls, rule builder, face blur, **webcam mode**, eval harness; early submission |
| **M3** Feature freeze | 15 Oct | Bug fixes and hardening only |
| **M4** Submitted | 17 Oct | Video (<3 min), deck PDF, README, final submission (a day before the 18 Oct deadline) |

**Sync:** 10 minutes at the start of the day (plan) and at the end (demo whatever's on production).

---

## PART F — Day-1 agenda (after Part C is sent)
1. Repo skeleton: `web/`, `api/`, `infra/`, `seed/`, `eval/`, `docs/`, plus `CLAUDE.md`, `PLAN.md`,
   `ARCHITECTURE.md`, this file, `.env.example`, `.gitignore`, PR template.
2. CI/CD workflows (PR checks + previews, deploy on merge, smoke test + rollback).
3. Cloud Shell commands for D5 → you run them → hello-world deployed end to end.
4. Gemini counting test on the 5 clips → **go/no-go on the hero feature** (or switch to the per-crossing fallback).

---

## PART G — Testing strategy

**Summary:** no installs are needed on the Windows laptop. Every PR gets automatic checks in GitHub Actions plus
two live preview URLs. The laptop (Chrome + phone) tests those URLs on real hardware.

### G1. Test layers

| Layer | What it catches | Where it runs | Who |
|---|---|---|---|
| **1. Unit tests** | Logic bugs | Coding machine before each commit + CI | Claude (automated) |
| **2. Integration tests** | API + database wiring | Coding machine + CI, using local Firebase emulators | Claude (automated) |
| **3. End-to-end browser tests** | "Does the real site work?" | CI, against the PR's preview URL | Automated |
| **4. Manual check on real hardware** | Real GPU speed, webcam, mobile, UX feel | **Windows laptop + phone**, using preview URLs | Dev B (or Dev A) |
| **5. Post-deploy smoke test** | A broken production deploy | CI, after merging to `main` | Automated, with rollback |
| **6. Live Gemini evaluation** | AI quality (accuracy, false alarms) | Coding machine, on demand, with the local `.env` key | Claude + Dev A |

### G2. Layers 1–2: what Claude runs before every commit
- **Web (Vitest):** Tier-1 rule engine, tracker, scoring and frame persistence, ring buffer.
  - **Design rule:** detection logic is plain TypeScript (landmark data in → scores out), kept separate from
    MediaPipe. It's tested with recorded landmark sequences ("concealment", "scanner bypass", "phone in pocket")
    and needs no browser or GPU.
- **API (pytest):** schema validation, upload limits, rate limiter, verdict cache, tool functions, retries on errors.
  - The **agent loop runs against a fake Gemini** that replays recorded responses, including simulated rate-limit
    (429) errors and broken JSON. Same result every time, zero quota.
- **Integration:** FastAPI test client + **Firestore/Auth emulators**, including the streamed (SSE) progress events.
- **Contract check:** API response types are generated from the Pydantic models and used by the frontend.
  A backend field change fails the frontend type-check instead of breaking the demo.
- **Static checks:** ruff + mypy (Python), eslint + tsc (TypeScript).
- Claude shows the actual test output before each commit and reports any failure plainly.

### G3. Layer 3: automatic checks on every PR (GitHub Actions)
1. Lint, type-check, unit and integration tests for **web** and **API** run in parallel.
2. Preview deploys: web → Firebase preview channel; API → tagged Cloud Run revision with no live traffic.
3. **Playwright** (headless browser) opens the preview URL and checks:
   - the page loads and seeded incidents appear;
   - a seeded clip plays in **pre-computed tracks mode** (deterministic, no GPU needed);
   - a cached investigation shows the incident card with its evidence box;
   - the rule builder flow works with a cached rule; error and empty states display correctly.
4. **Lighthouse CI** on the preview checks performance and accessibility budgets (LCP < 2.5 s, accessibility score threshold).
5. A bot comments both preview URLs on the PR.

**Merge gate (branch ruleset):** `web-ci`, `api-ci` and `e2e-preview` must pass, plus **1 approval**.

**CI never calls the real Gemini.** GitHub holds no secrets, so CI uses no quota and can't leak a key.
Real AI quality is covered by layer 6.

### G4. Layer 4: manual check on the Windows laptop (browser only)
Open the preview URL from the PR comment and work through the checklist in the PR template:
- [ ] **Chrome, real GPU:** play the store clips; the on-screen frame counter shows **≥ 15 fps**.
- [ ] **Webcam mode:** act out putting an item in a pocket and taking out a phone. Faces are blurred; an incident
  appears or is rejected. This **can only be tested on a real device** (not in CI or Claude's sandbox).
- [ ] **Live Gemini run:** click "re-run live" once and watch the progress steps (uses a little real quota).
- [ ] **Incognito window:** first load works and cold start is acceptable.
- [ ] **Phone:** open the preview URL via QR code; check the layout and that it's usable.
- [ ] **Keyboard only:** you can tab through the console and rule builder.
- [ ] Comment on the PR with an approval, or with issues and screenshots.

### G5. Layer 5: after merging
CI runs a smoke test on production (`/api/healthz` + one cached investigation). If it fails, Cloud Run traffic
**rolls back automatically** to the previous working revision.

### G6. Layer 6: AI quality evaluation (on demand, not on every PR)
- `eval/` runs the labelled staged-clip set through **Tier 1 alone vs. Tier 1 + Gemini** using the local `.env` key.
- It reports **precision, recall, false-alarm reduction, and latency (median and p95)**. These numbers go into the
  README, deck and video.
- Run it after prompt or model changes, and once more at feature freeze (15 Oct).

### G7. Known limits of Claude's environment
- **No GPU or webcam in Claude's sandbox:** real-device speed and webcam behaviour are verified only in layer 4.
  Claude will always say when something has only been tested in the sandbox and not on a real device.
- **Network goes through a filtering proxy:** if npm, PyPI or the Gemini API are blocked, Claude reports the blocked
  host. You either allow it or run that command yourself.

---

## PART H — Cost & account strategy

### H1. Expected cost
| Item | Real money | Free-trial credits ($300) |
|---|---|---|
| Firebase Hosting, Cloud Run, Firestore, Secret Manager, Cloud Storage | $0 (within free quotas) | ~$0 |
| Artifact Registry / Cloud Build | $0 | A few cents at most |
| Gemini API (Project B, no billing) | $0 (free tier) | $0 |
| Contingency: Gemini paid tier during judging | $0 | ~$1–10 |
| GitHub + Actions | $0 | — |
| **Total** | **$0** | **Likely under $10** |

- A free-trial billing account **can't charge the card** unless someone clicks **"Upgrade to paid"**. Never click it.
- The trial ends after 90 days (around early January 2027, after Demo Day on 4 Dec). Resources then stop; no
  invoice is sent. Any decision to upgrade happens after the hackathon.

### H2. One long-term account, not a dummy one
- **No dummy account followed by a move later.** Reasons:
  - Free trials are **one per person/card**. A dummy account using your card uses up your trial eligibility.
    Creating extra accounts for more trials breaks Google's terms.
  - Moving mid-hackathon means a new public URL, redoing keyless CI auth, re-creating the secret, moving Firestore
    data and re-pointing CI. Too risky near the deadline.
  - It adds no safety: the free trial already guarantees no charges.
- **Use one dedicated, long-term personal Gmail** as the owner from day 1. Add the teammate as **Owner** so either
  of you can keep deploying.
- Judges only see the URL, never which Google account hosts it.

### H3. Fallbacks and notes
- **No card at all:** the Firebase-only setup (Hosting + Firestore + Firebase AI Logic calling Gemini) is possible,
  but weakens server-side security and the Cloud Run story. Not recommended.
- `[UNVERIFIED]` If organisers hand out Google Cloud credit coupons, they go on the same billing account. Some need an
  upgraded account, so check the fine print and **don't upgrade just to claim credits** without discussing it first.

## Clearing test data
Playback, Monitor and the incident pages all read the same Firestore incidents. To remove your test runs but keep the
demo (seed) data:
```bash
cd api
gcloud auth application-default login           # once, with the project owner account
uv run python scripts/clear_test_data.py        # dry run: shows what would be deleted
uv run python scripts/clear_test_data.py --yes  # deletes it
```
It deletes live incidents, receipts typed on Investigate, the cache pointers to investigations, manager feedback on
live incidents and every camera's auto-tuned edge gate. It never touches `inc-seed-*`, `TXN-L1-*`/`TXN-L2-*` or seed
feedback.

