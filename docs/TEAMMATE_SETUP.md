# Teammate Setup Guide (Dev B: reviewer & hardener)

> Welcome to **ShrinkSight**. This guide gets you from zero to reviewing and improving PRs, in about 60–90 minutes.
> Read [`PLAN.md`](PLAN.md) (what we build) and [`SETUP_AND_DEPLOYMENT.md`](SETUP_AND_DEPLOYMENT.md) Parts D, E
> and G (how deployment, collaboration and testing work) when you have time.
>
> **Golden rules:** personal accounts only (never work email or work devices) · never paste API keys into chat,
> GitHub, issues or files other than your own gitignored `.env` · only synthetic data, no real personal data.

---

## 1. Accounts (~15 min)

### 1.1 GitHub
1. Sign in to **github.com** with your **personal** account (`avni17`).
2. Turn on 2FA: avatar → **Settings → Password and authentication → Enable two-factor authentication**.
3. Accept the collaborator invite for **`akshatjain-akj/shrinksight`**: check your email, or open
   https://github.com/akshatjain-akj/shrinksight/invitations.
4. Note your **noreply email**: **Settings → Emails**, tick **"Keep my email addresses private"**, and copy the
   address that looks like `12345678+avni17@users.noreply.github.com`. You'll use it for commits.

### 1.2 Google Cloud & Firebase access
1. Send Akshat your **personal Gmail** address (not over a public channel if you prefer privacy).
2. Akshat adds you as **Owner** on project `shrinksight-app`. Accept the email invite.
3. Check: open https://console.cloud.google.com, pick **shrinksight-app** in the project picker, and confirm you
   can see **Cloud Run**, **Firestore** and **Billing → Budgets**.
4. Check: open https://console.firebase.google.com and confirm **shrinksight-app** is listed.
5. ⚠️ **Never click "Upgrade" / "Activate full account"** on the billing banner. We stay on the free trial (cost $0).

### 1.3 Your own Gemini key for local development (recommended)
Using your own key gives you **your own free-tier quota**, so local testing doesn't eat into the production quota.
1. In the Cloud console, create a project, e.g. `shrinksight-ai-avni`, with **no billing account**.
   Check: ☰ → Billing → *"This project has no billing account."*
2. Open https://aistudio.google.com → **Get API key → Create API key** → choose that project.
3. Confirm it shows the **Free** tier. Save the key in a **password manager**. You'll type it into `api/.env` in step 4.

### 1.4 Hackathon registration
Make sure you're on the team in Hack2skill (aibuildercup.com), and that you meet the rules: working professional
(not a student), 21+, JAPAC.

---

## 2. Install tools (~20–30 min)

**Windows:** use **WSL (Ubuntu)**. In PowerShell (admin), run `wsl --install`, restart, open "Ubuntu", then follow the
Linux steps. **macOS:** use Homebrew equivalents (`brew install git gh node uv openjdk`).

```bash
# Basics, GitHub CLI, Java (needed by Firebase emulators)
sudo apt-get update
sudo apt-get install -y git curl build-essential gh openjdk-21-jre-headless

# Node LTS via nvm: install nvm from https://github.com/nvm-sh/nvm, reopen the terminal, then:
nvm install --lts
npm install -g firebase-tools

# Python 3.12 via uv
curl -LsSf https://astral.sh/uv/install.sh | sh
# reopen the terminal, then:
uv python install 3.12
```

Check (each should print a version):
```bash
git --version && gh --version && java -version && node -v && npm -v && firebase --version && uv --version
```

> If you see `Permission denied` for `~/.config` (as happened on Akshat's machine), fix it with:
> `sudo chown -R $USER:$(id -gn) ~/.config`

---

## 3. Clone the repo and set your identity (~5 min)

```bash
gh auth login                 # GitHub.com → HTTPS → Yes → Login with a web browser (enter the one-time code)
gh auth setup-git

mkdir -p ~/code && cd ~/code
gh repo clone akshatjain-akj/shrinksight
cd shrinksight

# Commit identity for THIS repo: your noreply email from step 1.1
git config user.name  "Avni ..."
git config user.email "12345678+avni17@users.noreply.github.com"
```

---

## 4. Create your local `.env` (~5 min)

The repo contains **`.env.example`**: a template listing every variable, with **no real values**. You copy it to
**`api/.env`** (gitignored, never committed) and fill in your own key.

```bash
cd ~/code/shrinksight
cp .env.example api/.env
nano api/.env                 # or: code api/.env
```
Set the key, typing or pasting it yourself:
```
GEMINI_API_KEY=<your key from step 1.3>
```
Save (nano: `Ctrl+O`, `Enter`, `Ctrl+X`). Then confirm git ignores it:
```bash
git status --short            # api/.env must NOT appear in the list
git check-ignore -v api/.env  # should print the .gitignore rule that ignores it
```

> **Why `.env.example` exists:** it documents the variables for everyone without leaking secrets. If you add a new
> variable to the code, add it (empty) to `.env.example` in the same PR.

---

## 5. Run everything locally (~10 min)

**API tests + lint**
```bash
cd ~/code/shrinksight/api
uv sync                       # installs exact versions from uv.lock
uv run ruff check .
uv run pytest -q              # expect: 4 passed
```

**Run the API locally**
```bash
set -a; . ./.env; set +a      # load api/.env into this terminal
uv run uvicorn app.main:app --reload --port 8080
# open http://localhost:8080/api/healthz → {"ok":true,...}
```

**Web app** (second terminal)
```bash
cd ~/code/shrinksight/web
npm ci                        # installs exact versions from package-lock.json
npm run typecheck
NEXT_PUBLIC_API_BASE=http://localhost:8080 npm run dev
# open http://localhost:3000 → "Cloud Run API ✅" (served by your local API)
```
The local self-test's Firestore/Storage rows will show ❌ unless you've logged in with
`gcloud auth application-default login`. That's expected locally; production is what matters.

---

## 6. Your role: reviewer & hardener

You follow **one feature behind** the builder: review every PR, test it, then improve it.

### 6.1 Reviewing a PR
1. Open the PR on GitHub. Read the description and the **"Demo-video moment"** section.
2. Wait for CI: **`api-ci`** and **`web-ci`** must be green. Click into any red check to read the log.
3. Pull it locally to test:
   ```bash
   gh pr checkout <PR-number>
   cd api && uv sync && uv run pytest -q
   cd ../web && npm ci && npm run typecheck && npm run build
   ```
4. Work through the **manual checklist** in the PR template (Chrome desktop, incognito, phone, keyboard only).
   *(Once preview deployments are added, you'll test the preview URLs posted on the PR instead of running locally.)*
5. Leave review comments (Files changed → click a line → comment). Then **Approve** or **Request changes**.

### 6.2 Making improvements
- Small fix on someone's PR: push commits to the **same branch** (`gh pr checkout <n>`, commit, `git push`).
- Bigger improvement: create your own branch and PR:
  ```bash
  git checkout main && git pull
  git checkout -b fix/<issue-number>-<short-name>
  # ...edit, test...
  git add -A && git commit -m "fix(api): handle Gemini timeout in selftest"
  git push -u origin HEAD
  gh pr create --fill
  ```

### 6.3 Conventions
| Thing | Rule |
|---|---|
| Branches | `feat/…`, `fix/…`, `chore/…`, `docs/…`, `test/…` |
| Commits | Prefix: `feat`, `fix`, `chore`, `docs`, `test`; short, imperative |
| PR size | ~400 lines or fewer, linked to an issue |
| Merging | **Squash-merge** after CI is green + 1 approval. Merging to `main` **deploys to production** |
| `main` | Always deployable. Never leave it broken overnight |
| Secrets | Only in Secret Manager (production) and your own `api/.env` (local) |

### 6.4 What you also own
- **Evaluation harness** (`eval/`, coming): labelled clips, precision/recall numbers for the deck.
- **Deployment checks:** after each merge, open https://shrinksight-app.web.app in **incognito** and on your **phone**,
  click **Run cloud self-test**, and report anything that isn't ✅.
- **CI health:** if a check is flaky or slow, raise it.

---

## 7. Done checklist
- [ ] GitHub 2FA on, collaborator invite accepted, noreply email set in the repo
- [ ] Owner access to `shrinksight-app` (Cloud console + Firebase console)
- [ ] Own Gemini key in a **no-billing** project, saved in a password manager
- [ ] Tools installed; `uv run pytest -q` passes; web `npm run build` passes
- [ ] `api/.env` created and confirmed ignored by git
- [ ] Opened https://shrinksight-app.web.app and the self-test is all ✅ (after the first deploy)

Questions or blockers → message Akshat, or comment on the PR.
