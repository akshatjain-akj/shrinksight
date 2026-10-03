# ShrinkSight — Implementation Plan

> *"Sees what the till missed."*

> **Hackathon:** Google Cloud AI Builder Cup 2026 · **Theme:** Retail & Commerce: Intelligent Customer and Business Experiences
> **Status:** Plan approved; setup in progress (no code written yet) · **Submission deadline:** 18 Oct 2026 (target 17 Oct)
> **Constraints source:** `AI_BUILDER_CUP_CLAUDE_CONTEXT.md` · **Architecture & flows:** `ARCHITECTURE.md` · **Setup & deployment:** `SETUP_AND_DEPLOYMENT.md`
> **Budget:** USD 0 (free tiers and free-trial credits only)

---

## 1. Product

**Users:** a store loss-prevention (LP) lead, and a self-checkout attendant who watches 6–8 lanes at once.

**The problem:** current camera analytics raise too many false alarms, so staff start ignoring them. Self-checkout
"missed scans" are hard to prove with classical computer vision. Today someone has to scrub through footage by hand
and check it against the till records.

**The core idea (only Gemini makes this possible):**
A cheap detector runs **in the browser** and flags suspicious moments. A **Gemini agent then investigates each one.**
It watches the clip, calls tools (POS transaction log, zone rules, product catalogue), cross-checks what it saw
against what was scanned, and returns a **structured incident report**: verdict, timestamps, bounding boxes, and an
estimated loss value. Or it rejects the alert as a false alarm.

**What sets it apart:**
- **Hero feature: self-checkout video checked against the till log.** Gemini counts the items handled on camera,
  calls `get_pos_transaction()`, and reports which items never reached the receipt.
- **Store rules written in plain English:** "alert if anyone stays at the liquor shelf for more than 45 seconds
  after 9pm" → Gemini turns it into a structured rule → the browser detector enforces it.
- **A false-alarm funnel, shown live:** "Tier-1 flagged 47 → Gemini confirmed 3".
- **Privacy on the device:** faces are blurred in the browser before anything is uploaded, so raw video never leaves the device.

**Risk of looking like a common entry:** a judge may think "CCTV detector" at first glance. The till cross-check and
the agent's visible investigation steps are what separate us, so the video must open with them.

---

## 2. Changes from the original PDF architecture

| Original (PDF) | Replacement | Reason |
|---|---|---|
| Qwen2.5-VL on vLLM | **Gemini Flash** (Developer API) | §2.1 compliance; video understanding, structured output, function calling |
| Jetson / DeepStream edge box | **The judge's browser acts as the edge device** (MediaPipe Tasks Vision, WebGPU/WASM) | Free compute, no GPU bill, works from a public URL, Google tech (Apache-2.0) |
| YOLO / Ultralytics | MediaPipe Pose / Object / Hand / Face | Avoids AGPL licensing, stays all-Google |
| SlowFast / RWF-2000 / UCF-Crime | Movement and timing rules on body landmarks, Gemini as the judge | No model training; avoids research-only datasets that show real people |
| Redis / MinIO | Firestore / Cloud Storage | Managed, free quotas |
| FastAPI on a GPU box | **FastAPI on Cloud Run** (CPU only, small image) | §2.2 |
| COCO 17-point skeleton | MediaPipe 33-point skeleton | Native to MediaPipe |

---

## 3. Key design decisions

- **All Gemini work runs inside the request, and progress streams back over SSE.** Cloud Run throttles CPU after the
  response is sent, so there's no "fire and forget" background work. Stateless, and no Pub/Sub needed.
- **Clips are sent inline** (kept under ~3 MB), so the Files API isn't needed.
- **We set the video sampling rate** (~5 fps around the event) and use low media resolution, so a quick swipe past
  the scanner isn't missed and tokens stay low.
- **Fallback if Gemini can't count items reliably:** Tier 1 marks each hand-crossing moment, and Gemini gets one
  targeted question per item crossing ("was this item scanned?").
- **The agent loop is capped at 4 tool calls.** Every call has a timeout, exponential backoff on 429/5xx, and a
  schema-validated response.
- **Responsible AI:** judge **actions only, never appearance or demographics**. Output is framed as "needs review",
  never as an accusation; a human always makes the final decision.

---

## 4. Running at zero cost

**Two caveats:** Cloud Run requires a billing account (card on file). A Gemini API key from a billing-enabled project
is billed at paid rates.

1. **Project A, `shrinksight-app`:** a new Google Cloud **free-trial** account with $300 in credits. Free-trial
   accounts **can't charge the card unless manually upgraded**. The 90-day trial covers Demo Day (4 Dec). Hosts
   Cloud Run, Firestore, GCS, Secret Manager and Firebase Hosting, all inside always-free quotas.
2. **Project B, `shrinksight-ai`:** **no billing.** The AI Studio Gemini key is created here, so it stays on the free
   tier. The key is stored in Project A's Secret Manager.
3. **Contingency:** if free-tier rate limits hurt during judging, move the key to the paid tier in Project A
   (spends trial credits, not money).

**Free quotas (re-check exact numbers on day 1):**

| Service | Free quota | Expected use |
|---|---|---|
| Cloud Run | ~2M requests, 180k vCPU-seconds, 360k GiB-seconds per month | Tiny |
| Firestore | 1 GiB, 50k reads / 20k writes per day | Hundreds per day |
| Cloud Storage (US region) | 5 GB | ~50 MB of seed clips |
| Firebase Hosting | 10 GB storage, ~360 MB/day transfer | App bundle only; MediaPipe models load from Google's CDN |
| Secret Manager / Artifact Registry | 6 secret versions / 0.5 GB | 1 secret / one image under 300 MB with a cleanup policy |
| GitHub Actions | Free for public repos | CI/CD |
| Gemini API free tier | Per-model requests-per-minute and per-day limits | Cache plus throttling |

**Guardrails:** budget alert at $1 · Cloud Run max-instances 2, min-instances 0, concurrency 20 · region `us-central1`.

**Never turn on:** GPUs, Vertex AI endpoints, Cloud SQL, Memorystore, load balancers.

**Protecting the public URL:**
- Firebase App Check (reCAPTCHA v3) and anonymous Firebase Auth.
- A per-user rate limit and a global daily cap, both tracked in Firestore.
- Seeded clips have **pre-computed cached verdicts**, plus a "re-run live" button that calls Gemini for real.
- If the quota runs out, the UI shows a "cached analysis" label instead of breaking.

**Free-tier data note:** Google may use free-tier inputs to improve its products. All footage is staged by the team
with signed consent, and the consent form says so.

---

## 5. Performance targets

| Metric | Target | How |
|---|---|---|
| Tier-1 frame rate (mid-range laptop) | ≥15 fps | Web Worker + WebGPU; each model runs at its own rate; lite models; tracker fills gaps between detections |
| Low-end / mobile device | Stays usable | Adaptive frame skipping; **pre-computed Tier-1 tracks (JSON)** for seeded clips |
| Gemini verdict, median | <6 s, with streamed progress | Short clips, low media resolution, Flash tier, SSE progress steps |
| Cold start | <3 s | Slim image, no OpenCV/ffmpeg on the server, lazy imports, warm-up ping on page load |
| First page load | LCP <2.5 s | Static export on the Hosting CDN; models lazy-load after first paint |
| Upload size | ≤3 MB | Blurred 480p WebM via MediaRecorder |

---

## 6. MVP scope (each feature tied to a moment in the video)

| # | Feature | In video at | Priority |
|---|---|---|---|
| 1 | Self-checkout video vs. till cross-check (hero) | 0:20–1:10 | Must |
| 2 | Shop-floor concealment: one real case confirmed, one benign case rejected | 1:10–1:45 | Must |
| 3 | Incident console: live feed, evidence frames with Gemini's boxes, report, estimated loss | Throughout | Must |
| 4 | Rule builder: plain-English rule plus a zone drawn on screen, then a loitering alert | 1:45–2:15 | Must |
| 5 | Face blur on the device, privacy panel | 2:15–2:35 | Must |
| 6 | Measured results and architecture | 2:35–3:00 | Must |
| 7 | Webcam "try it yourself" mode | Not in video; for judges | Must |
| 8 | Natural-language search over incidents, end-of-day LP summary | — | Stretch (likely cut) |

**Cut on purpose:** weapons, fire, PPE, crowd panic, camera tampering.

---

## 7. Evaluation

- Labelled set of ~30–40 staged clips: real thefts, missed scans, and tricky benign cases (phone into pocket,
  putting a basket down, scratching).
- Script in `eval/` compares **Tier 1 alone vs. Tier 1 + Gemini** on precision, recall, false-alarm reduction and latency.
- The real numbers go into the README, the deck and the last 20 seconds of the video.

---

## 8. Repo and engineering practice

```
/web     Next.js (static export) + TS + Tailwind + MediaPipe Tasks Vision
/api     FastAPI + google-genai SDK + Pydantic schemas
/infra   deploy scripts, firebase.json, firestore.rules, GCS lifecycle, budget setup
/seed    synthetic POS logs, SKU catalogue, zone configs, cached verdicts
/eval    labelled clip manifest + evaluation script
/docs    architecture diagram, consent template, deck assets
```

- Repo created fresh inside the hackathon window, with an honest commit history.
- **CI/CD:** GitHub Actions runs lint, type-check, unit tests (rule engine, schemas, tools) and a smoke test against
  a mocked Gemini. Merging to `main` deploys automatically. GitHub authenticates to Google Cloud via Workload
  Identity Federation, so no service-account keys exist anywhere.
- Secrets live in Secret Manager. Commit `.env.example`; `.env` is gitignored. Only synthetic data or footage
  staged by the team with consent; no real PII.
- `main` is always deployable. Short-lived branches, PR reviews, and the deployed URL is checked after every merge.
- Accessibility: semantic HTML, keyboard navigation, AA colour contrast, visible loading/empty/error states.

---

## 9. Timeline

| Dates | Work |
|---|---|
| **2–3 Oct** | Both projects, budget alert, AI Studio key, repo. Hello-world end to end (Hosting → Cloud Run → Gemini). **Spikes:** (a) can Gemini count items on 5 phone-recorded checkout clips (go/no-go on the hero feature); (b) MediaPipe frame rate in the browser |
| **4–5 Oct** | Script and record staged footage (consent forms); synthetic POS data and SKU catalogue |
| **6–8 Oct** | **Thin slice deployed by 8 Oct:** seeded clip → Tier-1 candidate → Gemini verdict → live incident in the console |
| **9–13 Oct** | Depth: agent tool calls for the till cross-check, rule builder, face blur, caching and rate limits, evaluation harness, UX polish. **Early submission ~12 Oct** |
| **14–15 Oct** | **Feature freeze 15 Oct.** Run evaluation; harden the deployment; test cold starts, incognito and mobile |
| **15–17 Oct** | Video, deck (PDF), README. **Final submission 17 Oct** |

**Roles (team of 2 developers):** **Dev A, the builder** (with Claude) builds each feature end to end, browser and backend. **Dev B, the hardener** follows one feature behind: reviews, tests on real hardware, improves, and owns the evaluation harness and deployment checks. Footage, video and deck are shared. Details in `SETUP_AND_DEPLOYMENT.md` Part E.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Gemini can't count checkout items reliably | Day-1 spike; fall back to one question per item crossing |
| Free-tier rate limits during judging | Cached verdicts, throttling, graceful degradation; trial credits as backup |
| Detection is slow on a judge's device | Pre-computed tracks for seeded clips |
| Free-tier quotas or model names change | Check on day 1; model ID kept in config |
| Ethics concerns about surveillance | Judge actions not appearance, blur on device, human in the loop, 24-hour retention |
| Employer IP (§7) | Personal machine, personal accounts, no employer data or code |

---

## 11. Decisions

| # | Decision | Outcome |
|---|---|---|
| 1 | Billing | **Free-trial Google Cloud account** on a dedicated, long-term personal Gmail (no dummy account, no later move) |
| 2 | Hero feature | **Self-checkout till cross-check** approved, pending the day-1 Gemini counting test |
| 3 | Team & language | **2 developers** (builder + hardener). **Python (FastAPI)** backend, **TypeScript (Next.js)** web app |
| 4 | Webcam mode | **Must** (promoted from Should) |
| 5 | Product name | **ShrinkSight**, tagline *"Sees what the till missed."* |
