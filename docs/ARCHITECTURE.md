# ShrinkSight — Architecture & Flows

> Companion to `PLAN.md`. Theme: **Retail & Commerce**. All diagrams are Mermaid (they render on GitHub) and can be
> exported straight into the deck. Status: **design, awaiting approval** — names, thresholds and quotas are
> starting points to be tuned during the day-1 spikes.

---

## 1. The idea in one picture

```
   ┌──────────────── STORE / JUDGE'S BROWSER ("the edge") ────────────────┐      ┌──────── GOOGLE CLOUD ────────┐
   │                                                                       │      │                              │
   │  Camera / seeded clip ──► TIER 1: MediaPipe (on device, 15–30 fps)    │      │  TIER 2: Gemini agent        │
   │                            • pose, objects, hands, faces              │      │  on Cloud Run                │
   │                            • faces BLURRED here                       │      │   • watches the clip         │
   │                            • cheap rules → suspicion score            │ clip │   • calls tools (POS, zones, │
   │                            • 95%+ of frames end here (free)          ─┼─────►│     prices)                  │
   │                                                                       │ ≤3MB │   • returns a structured     │
   │  Incident console ◄──── live updates (Firestore) ◄────────────────────┼──────┤     verdict + evidence       │
   │                                                                       │      │                              │
   └───────────────────────────────────────────────────────────────────────┘      └──────────────────────────────┘
```

**The rule of thumb:** Tier 1 is fast, free and says "this *might* be something." Tier 2 is smart, rate-limited and
answers "is it, what exactly happened, and what did it cost?" Only blurred, short, suspicious clips ever cross the line.

---

## 2. System context

```mermaid
flowchart LR
    LP["LP lead / store manager"]
    ATT["Self-checkout attendant"]
    JUDGE["Hackathon judge<br/>(no login, no setup)"]

    subgraph LL["ShrinkSight"]
        WEB["Web app<br/>(browser, Tier 1)"]
        API["Investigation API<br/>(Cloud Run, Tier 2)"]
    end

    GEM["Gemini API<br/>(Google AI Studio)"]
    POS["POS / till log<br/>(synthetic, Firestore)"]

    LP -- "writes rules, reviews incidents" --> WEB
    ATT -- "gets lane alerts" --> WEB
    JUDGE -- "opens public URL" --> WEB
    WEB -- "suspicious clip + context" --> API
    API -- "multimodal prompt + tools" --> GEM
    API -- "tool calls" --> POS
```

---

## 3. Components

```mermaid
flowchart TB
    subgraph BROWSER["Browser — Next.js static app on Firebase Hosting"]
        direction TB
        SRC["Video source<br/>seeded clips (GCS) | webcam"]
        subgraph WORKER["Web Worker (OffscreenCanvas, WebGPU/WASM)"]
            POSE["PoseLandmarker<br/>@15 fps"]
            OBJ["ObjectDetector<br/>@5 fps"]
            FACE["FaceDetector + blur<br/>@10 fps"]
            TRK["IoU tracker<br/>stable person IDs"]
            RULES["Rule engine<br/>zones · dwell · wrist→pocket ·<br/>scanner bypass · lane session"]
        end
        RING["Ring buffer<br/>last ~8 s of BLURRED frames"]
        CLIP["Clip cutter<br/>MediaRecorder → 480p WebM ≤3 MB"]
        UI["Console UI<br/>camera grid · incident feed ·<br/>evidence viewer · rule builder ·<br/>false-alarm funnel"]
        SDK["Firebase SDK<br/>Anonymous Auth · App Check · onSnapshot"]
    end

    subgraph RUN["Cloud Run — FastAPI (python:3.12-slim)"]
        direction TB
        GATE["Gatekeeper<br/>App Check verify · rate limit ·<br/>size/type validation"]
        CACHE["Verdict cache<br/>sha256(clip) → result"]
        AGENT["Investigator agent<br/>google-genai SDK · ≤4 tool calls ·<br/>timeout + retry/backoff"]
        TOOLS["Tools<br/>get_pos_transaction · get_zone_policy ·<br/>get_sku_price · raise_incident"]
        COMPILER["Rule compiler<br/>English → Rule JSON"]
        SSE["SSE progress stream"]
    end

    subgraph DATA["Managed data — Project A"]
        FS[("Firestore<br/>incidents · rules · pos_transactions ·<br/>skus · verdict_cache · quotas")]
        GCS[("Cloud Storage<br/>seed clips · evidence clips<br/>(24 h lifecycle)")]
        SM["Secret Manager<br/>GEMINI_API_KEY"]
    end

    GEM["Gemini Flash / Flash-Lite<br/>(Project B key, free tier)"]

    SRC --> POSE & OBJ & FACE
    POSE & OBJ --> TRK --> RULES
    FACE --> RING
    RULES -- "score ≥ threshold" --> CLIP
    RING --> CLIP
    CLIP -- "POST /api/investigate" --> GATE
    UI -- "POST /api/rules/compile" --> GATE
    GATE --> CACHE
    CACHE -- miss --> AGENT
    AGENT <--> GEM
    AGENT --> TOOLS
    TOOLS <--> FS
    GATE --> COMPILER
    COMPILER <--> GEM
    AGENT --> SSE --> UI
    TOOLS -- "write incident" --> FS
    AGENT -- "store evidence" --> GCS
    FS -- "realtime listener" --> SDK --> UI
    SM -.-> AGENT
    GCS -- "seed clips" --> SRC
```

| Component | Responsibility | Why it lives there |
|---|---|---|
| Web Worker + MediaPipe | All per-frame computer vision | Free compute on the judge's machine; keeps the UI thread smooth |
| Rule engine | Turns landmarks into a 0–1 suspicion score | Cheap, explainable, runs 15+ times per second |
| Ring buffer + clip cutter | Pre/post-event evidence (like the PDF's rolling buffer) | Only blurred frames are kept, so raw video never leaves the device |
| Gatekeeper | Abuse protection and input validation | Public URL + free key = must be defended |
| Verdict cache | Instant, quota-free answers for seeded clips | Judges always see a result, even with no quota left |
| Investigator agent | The Gemini reasoning loop with tools | The core Gen AI mechanic (40% of the score) |
| Rule compiler | English → structured rule for Tier 1 | Gen AI that configures the system, not just chats |
| Firestore | System of record + realtime push to the console | Free, serverless, no websocket server to run |

---

## 4. Deployment topology ($0)

```mermaid
flowchart LR
    subgraph GH["GitHub (public repo)"]
        CODE["main branch"]
        GHA["GitHub Actions<br/>lint · test · build · deploy"]
    end

    subgraph PA["Project A: shrinksight-app (free trial, us-central1)"]
        HOST["Firebase Hosting<br/>static Next.js + /api/** rewrite"]
        CR["Cloud Run: shrinksight-api<br/>min 0 · max 2 · concurrency 20"]
        AR["Artifact Registry<br/>1 image, cleanup policy"]
        FSA[("Firestore")]
        GCSA[("Cloud Storage")]
        SMA["Secret Manager"]
        BUD["Budget alert @ $1"]
    end

    subgraph PB["Project B: shrinksight-ai (NO billing)"]
        KEY["AI Studio API key<br/>→ Gemini free tier"]
    end

    CDN["Google CDN<br/>MediaPipe wasm + models"]
    USER(("Browser"))

    CODE --> GHA
    GHA -- "Workload Identity Federation<br/>(no keys)" --> AR --> CR
    GHA -- "firebase deploy" --> HOST
    USER --> HOST
    HOST -- "/api/**" --> CR
    USER -- "models" --> CDN
    USER -- "seed clips" --> GCSA
    CR --> FSA & GCSA
    SMA -.-> CR
    KEY -. "stored in" .-> SMA
    CR -- "HTTPS" --> GEMAPI["Gemini API"]
```

**Why two projects:** a Gemini key from a billing-enabled project is billed at paid rates. A key from a project with
no billing stays on the free tier. The free-trial account in Project A can't charge the card unless someone
manually upgrades it.

---

## 5. Tier 1 in the browser: frame-level pipeline

```mermaid
flowchart TD
    F["New video frame<br/>(requestVideoFrameCallback)"] --> W["Post ImageBitmap to Worker<br/>(transferable, zero-copy)"]
    W --> S{"Scheduler:<br/>whose turn this frame?"}
    S -- "every 2nd frame" --> P["Pose (33 landmarks)"]
    S -- "every 6th frame" --> O["Objects: person, bag,<br/>bottle, basket"]
    S -- "every 3rd frame" --> FD["Face boxes"]
    FD --> BL["Gaussian blur faces<br/>→ write to ring buffer"]
    P & O --> T["Tracker: match to person IDs<br/>(IoU + velocity)"]
    T --> R["Rule engine per track"]

    R --> R1["Concealment:<br/>wrist → hip/pocket/bag region<br/>after being near a shelf zone"]
    R --> R2["Scanner bypass:<br/>hand path goes AROUND the<br/>scanner zone to the bagging area"]
    R --> R3["Loitering:<br/>dwell in zone > rule limit"]
    R --> R4["Lane session:<br/>shopper enters/leaves lane →<br/>transaction window"]

    R1 & R2 & R3 & R4 --> SC["Score 0–1, smoothed over<br/>N consecutive frames (persistence)"]
    SC --> M{"Inside an exclusion<br/>mask?"}
    M -- yes --> DROP["Drop"]
    M -- no --> TH{"score ≥ 0.40?"}
    TH -- no --> FUN1["Funnel: +1 'seen, ignored'"]
    TH -- yes --> CUT["Cut clip: 4 s before + 3 s after<br/>from blurred ring buffer"]
    CUT --> SEND["POST /api/investigate<br/>Funnel: +1 'sent to Gemini'"]
    F -.-> PERF{"fps < 12?"}
    PERF -- yes --> ADAPT["Adaptive mode: skip more frames,<br/>or replay pre-computed tracks JSON"]
```

**Starting thresholds (tuned on the eval set):**
- Send to Gemini if the score is ≥ 0.40 for at least 8 frames in a row.
- For the self-checkout lane, *always* send the whole transaction window when the shopper leaves the lane. The
  cross-check needs the full session, not just one suspicious moment.

---

## 6. Flow A: judge opens the URL

```mermaid
sequenceDiagram
    autonumber
    actor J as Judge
    participant H as Firebase Hosting
    participant B as Browser app
    participant C as Cloud Run API
    participant FS as Firestore
    participant CDN as Google CDN

    J->>H: GET https://shrinksight.web.app
    H-->>B: Static app (HTML/JS/CSS, cached at edge)
    par warm-up
        B->>C: GET /api/healthz (wakes a scaled-to-zero instance)
    and auth
        B->>B: Anonymous sign-in + App Check token
    and models
        B->>CDN: Lazy-load MediaPipe wasm + models (after first paint)
    end
    B->>FS: Subscribe to incidents (seeded + live)
    FS-->>B: Seeded incidents → console is never empty
    B-->>J: Store view: 4-camera grid, funnel counter, incident feed
```

---

## 7. Flow B (hero): self-checkout cross-check against the till

```mermaid
sequenceDiagram
    autonumber
    participant T1 as Tier 1 (browser)
    participant G as Gatekeeper
    participant K as Verdict cache
    participant A as Investigator agent
    participant GM as Gemini
    participant FS as Firestore
    participant UI as Console

    Note over T1: Shopper at Lane 3 scans 4 items,<br/>passes 1 item around the scanner
    T1->>T1: Scanner-bypass rule fires (score 0.62)
    T1->>T1: Shopper leaves lane → close transaction window
    T1->>G: POST /api/investigate {clip, lane:3, t_start, t_end, tier1_events[]}
    G->>G: Verify App Check · rate limit · clip ≤3 MB, video/webm
    G->>K: lookup sha256(clip)
    K-->>G: miss
    G->>A: start investigation
    A-->>UI: SSE "Watching clip…"
    A->>GM: clip (fps≈5, low res) + system prompt + tool declarations
    GM-->>A: function_call get_pos_transaction(lane=3, window)
    A->>FS: read pos_transactions
    FS-->>A: receipt: 4 line items (SKUs, times)
    A-->>UI: SSE "Checking the till receipt…"
    A->>GM: function_response(receipt)
    GM-->>A: function_call get_sku_price(sku="WINE-750")
    A->>FS: read skus
    A->>GM: function_response(price)
    GM-->>A: Final JSON: verdict=SCAN_AVOIDANCE, items_seen=5,<br/>items_scanned=4, unscanned=[{t:00:06.4, box_2d, desc}], est_loss=24.99
    A->>A: Validate against schema (re-ask once if invalid)
    A->>FS: raise_incident(...) + verdict_cache.put
    A-->>UI: SSE "Done" + incident id
    FS-->>UI: onSnapshot → incident card appears for all viewers
    Note over UI: Card: "1 item not scanned at 00:06 · est. $24.99"<br/>evidence frame with Gemini's box · "Needs review"
```

**Why only Gemini can do this:** it has to understand *which object* was handled, *count* items across time, and
*reason over two modalities at once* (video and a till receipt fetched through a tool). Classical CV would need a
custom-trained model per store and a separate rule system for the receipt.

**Fallback if the day-1 spike shows Gemini counts poorly:** Tier 1 already logs each hand-crossing with a timestamp.
The agent asks Gemini about each crossing separately ("between 00:06.0 and 00:07.0, did the item pass over the
scanner?") and reconciles the counts in deterministic code.

---

## 8. Flow C: shop-floor concealment and rejecting a false alarm

```mermaid
sequenceDiagram
    autonumber
    participant T1 as Tier 1 (browser)
    participant A as Investigator agent
    participant GM as Gemini
    participant FS as Firestore
    participant UI as Console

    rect rgb(255, 240, 240)
    Note over T1,UI: Case 1: real concealment
    T1->>T1: Wrist moves shelf → jacket pocket, holds 1.2 s (score 0.71)
    T1->>A: POST /api/investigate {clip, camera:"Aisle 4", zone:"spirits"}
    A->>GM: clip + prompt
    GM-->>A: function_call get_zone_policy("spirits")
    A->>GM: {high_value:true, after_hours_rule:...}
    GM-->>A: verdict=CONCEALMENT, confidence=0.86,<br/>timeline=[pick 00:02.1, conceal 00:03.4], box_2d
    A->>FS: incident (severity HIGH)
    FS-->>UI: Red card + attendant notification
    end

    rect rgb(240, 255, 240)
    Note over T1,UI: Case 2: benign (the important one)
    T1->>T1: Wrist → pocket (score 0.55)
    T1->>A: POST /api/investigate {clip, camera:"Aisle 2"}
    A->>GM: clip + prompt
    GM-->>A: verdict=BENIGN, reason="took out phone,<br/>no merchandise in hand", confidence=0.91
    A->>FS: log as REJECTED (no alert raised)
    FS-->>UI: Funnel: "Gemini rejected 1 false alarm" (grey, collapsed)
    end
```

---

## 9. Flow D: plain-English rule → enforced by Tier 1

```mermaid
sequenceDiagram
    autonumber
    actor M as Store manager
    participant UI as Rule builder
    participant C as Rule compiler (Cloud Run)
    participant GM as Gemini
    participant FS as Firestore
    participant T1 as Tier 1 rule engine

    M->>UI: Draws a polygon on "Aisle 4" → names it "spirits"
    M->>UI: Types "Alert if anyone stays here more than 45 seconds after 9pm"
    UI->>C: POST /api/rules/compile {text, zones:[spirits]}
    C->>GM: text + zone list + Rule JSON schema (structured output)
    GM-->>C: {type:"DWELL", zone:"spirits", min_seconds:45,<br/>active:{from:"21:00", to:"06:00"}, severity:"MEDIUM"}
    C->>C: Validate (known zone? sane limits? supported type?)
    C-->>UI: Show the rule in plain words for confirmation
    M->>UI: Confirm
    UI->>FS: save rule
    FS-->>T1: onSnapshot → rule loaded into worker, applies instantly
    Note over T1: Next time someone lingers 45 s → candidate → Flow C
```

Supported rule types (MVP): `DWELL`, `CONCEALMENT_SENSITIVITY`, `ZONE_ENTRY`, `SCANNER_BYPASS`. Anything else is
rejected with a friendly "I can't enforce that yet" message, so the model never invents a rule the engine can't run.

---

## 10. Flow E: cache, rate limits and graceful degradation

```mermaid
flowchart TD
    REQ["POST /api/investigate"] --> AC{"App Check<br/>token valid?"}
    AC -- no --> E401["401: refresh token and retry"]
    AC -- yes --> VAL{"Valid clip?<br/>≤3 MB · webm/mp4 · ≤12 s"}
    VAL -- no --> E400["400 + friendly message"]
    VAL -- yes --> CH{"Cache hit?<br/>sha256(clip)"}
    CH -- "yes (and no 're-run live')" --> HIT["Return cached verdict<br/>label: 'cached analysis'"]
    CH -- no --> RL{"Per-user limit OK?<br/>(e.g. 6/min)"}
    RL -- no --> E429U["429: 'Slow down' toast + countdown"]
    RL -- yes --> GL{"Global daily cap OK?"}
    GL -- no --> DEG["Degraded mode: Tier-1 verdict only,<br/>label 'AI review paused', queue for later"]
    GL -- yes --> CALL["Call Gemini<br/>timeout 25 s"]
    CALL --> OK{"Success?"}
    OK -- "429 / 5xx" --> RETRY{"Retries < 2?"}
    RETRY -- yes --> BACK["Exponential backoff + jitter"] --> CALL
    RETRY -- no --> FALL["Fallback model (Flash-Lite)<br/>or degraded mode"]
    OK -- yes --> SCHEMA{"Matches the<br/>JSON schema?"}
    SCHEMA -- no --> REASK["Re-ask once with the error"] --> SCHEMA
    SCHEMA -- yes --> SAVE["Write incident + cache → stream 'Done'"]
```

---

## 11. Incident lifecycle

```mermaid
stateDiagram-v2
    [*] --> CANDIDATE: Tier 1 score ≥ threshold
    CANDIDATE --> INVESTIGATING: clip accepted by API
    INVESTIGATING --> CONFIRMED: Gemini verdict = CONCEALMENT / SCAN_AVOIDANCE / RULE_BREACH
    INVESTIGATING --> REJECTED: Gemini verdict = BENIGN
    INVESTIGATING --> INCONCLUSIVE: low confidence or bad footage
    INVESTIGATING --> AI_PAUSED: quota exhausted (degraded mode)
    AI_PAUSED --> INVESTIGATING: quota available again
    CONFIRMED --> NEEDS_REVIEW: alert sent to staff
    INCONCLUSIVE --> NEEDS_REVIEW
    NEEDS_REVIEW --> RESOLVED_ACTIONED: human confirms
    NEEDS_REVIEW --> RESOLVED_DISMISSED: human dismisses
    REJECTED --> [*]
    RESOLVED_ACTIONED --> [*]
    RESOLVED_DISMISSED --> [*]
```

A human decision is always the last step. ShrinkSight never labels a person a thief; it flags events for review.
Human dismissals are also logged, which gives us a precision metric for the deck.

---

## 12. Data model (Firestore)

```mermaid
erDiagram
    STORE ||--o{ CAMERA : has
    STORE ||--o{ ZONE : defines
    STORE ||--o{ RULE : configures
    CAMERA ||--o{ INCIDENT : produces
    ZONE ||--o{ RULE : "scoped by"
    LANE ||--o{ POS_TRANSACTION : records
    POS_TRANSACTION ||--o{ LINE_ITEM : contains
    SKU ||--o{ LINE_ITEM : "sold as"
    INCIDENT }o--o| POS_TRANSACTION : "reconciled against"

    INCIDENT {
        string id
        string camera_id
        string type "CONCEALMENT | SCAN_AVOIDANCE | RULE_BREACH"
        string status "see lifecycle"
        float  tier1_score
        float  gemini_confidence
        json   timeline "[{t, event, box_2d}]"
        json   unscanned_items
        float  est_loss
        string reason
        string evidence_uri "GCS, 24h lifecycle"
        bool   cached
        timestamp created_at
        timestamp expire_at "TTL policy"
    }
    RULE {
        string id
        string source_text
        string type
        string zone_id
        json   params
        string severity
    }
    POS_TRANSACTION {
        string id
        string lane_id
        timestamp started_at
        timestamp ended_at
    }
    LINE_ITEM {
        string sku
        timestamp scanned_at
        float price
    }
    SKU {
        string sku
        string name
        float price
        bool high_value
    }
```

Other collections: `verdict_cache/{sha256}` (verdict JSON, model id, created_at) and `quotas/{uid|global}`
(rolling counters). All POS, SKU and store data is **synthetic** and lives in `/seed`.

---

## 13. API contract (Cloud Run)

| Method & path | Purpose | Request | Response |
|---|---|---|---|
| `GET /api/healthz` | Warm-up / liveness | — | `{ok, model, version}` |
| `POST /api/investigate` | Run the Gemini agent on a clip | multipart: `clip` (webm/mp4 ≤3 MB), `meta` JSON `{camera_id, lane_id?, zone_ids[], t_start, t_end, tier1_events[], rerun_live?}` | `text/event-stream`: `progress` events → final `result` `{incident_id, verdict…}` |
| `POST /api/rules/compile` | English → Rule JSON | `{text, zones[]}` | `{rule, explanation}` or `{error}` |
| `GET /api/stats` | Funnel and eval numbers for the UI | — | `{tier1_candidates, gemini_confirmed, rejected, avg_latency_ms}` |

Every request needs an App Check header and a Firebase anonymous ID token. Validation errors return 400 with
human-readable messages; quota errors return 429 with `retry_after`.

---

## 14. Gemini contracts

**Tools (function declarations):**

| Tool | Args | Returns | Notes |
|---|---|---|---|
| `get_pos_transaction` | `lane_id`, `t_start`, `t_end` | line items with SKU, name, scan time | Read-only |
| `get_zone_policy` | `zone_id` | high-value flag, active rules | Read-only |
| `get_sku_price` | `sku` or `description` | name, price | Fuzzy match on description |
| `raise_incident` | type, severity, summary | incident id | Server checks the args; the model can't skip schema validation |

**Final response schema (structured output, simplified):**

```json
{
  "verdict": "CONCEALMENT | SCAN_AVOIDANCE | RULE_BREACH | BENIGN | INCONCLUSIVE",
  "confidence": 0.0,
  "items_seen": 0,
  "items_scanned": 0,
  "unscanned_items": [{ "t": "00:06.4", "description": "green wine bottle", "box_2d": [ymin, xmin, ymax, xmax] }],
  "timeline": [{ "t": "00:02.1", "event": "picks item from shelf" }],
  "est_loss": 0.0,
  "reason": "one or two plain sentences",
  "behaviour_only": true
}
```

**Prompt principles:** describe **actions only** (never appearance, clothing as identity, age, gender or ethnicity);
say INCONCLUSIVE rather than guess; timestamps are relative to the clip start; bounding boxes use Gemini's native
0–1000 `box_2d` format so the UI can overlay them directly.

**Model choice (set in config, confirmed on day 1):** Flash for investigations, Flash-Lite for rule compiling and as
the fallback model.

---

## 15. Security and privacy boundaries

```mermaid
flowchart LR
    NET(("Internet"))
    subgraph DEVICE["Device (trusted for privacy)"]
        RAW["Raw frames"] --> BLUR["Face blur"] --> RB["Ring buffer<br/>(blurred only)"]
        RAW -. "never leaves" .-x NET
    end
    RB -- "short blurred clip, HTTPS,<br/>App Check + anon token" --> NET
    NET --> CR["Cloud Run<br/>(validates everything)"]
    CR -- "key from Secret Manager" --> GEM["Gemini"]
    CR --> FS[("Firestore<br/>rules: clients read incidents,<br/>only server writes")]
    CR --> GCS[("GCS evidence<br/>private, signed URLs,<br/>24 h lifecycle")]
```

- Raw video never leaves the device; only short, face-blurred clips are uploaded.
- Evidence is deleted after 24 hours (GCS lifecycle + Firestore TTL).
- Firestore security rules: the browser can **read** incidents and rules, but only the server writes incidents and
  only signed-in users write rules (validated).
- No secrets in the browser or in git. The Gemini key exists only in Secret Manager.
- All demo footage is staged by team members who signed consent forms; all records are synthetic.

---

## 16. CI/CD flow

```mermaid
flowchart LR
    DEV["Feature branch"] --> PR["Pull request"]
    PR --> CI["GitHub Actions:<br/>lint · type-check · unit tests ·<br/>Gemini-mocked smoke test · build"]
    CI -- green + review --> MAIN["Merge to main"]
    MAIN --> BUILD["Build API image"]
    BUILD -- "WIF auth (no keys)" --> PUSH["Push to Artifact Registry"]
    PUSH --> DEPLOY["gcloud run deploy<br/>(new revision)"]
    MAIN --> FB["next build (static export)<br/>→ firebase deploy --only hosting"]
    DEPLOY & FB --> SMOKE["Post-deploy smoke:<br/>GET /api/healthz + cached investigation"]
    SMOKE -- fail --> ROLL["Roll traffic back to<br/>previous revision"]
```

---

## 17. Latency budget (one investigation, target median < 6 s)

| Step | Budget |
|---|---|
| Clip cut + encode in browser | 0.3 s |
| Upload ≤3 MB | 0.5–1.0 s |
| Gatekeeper + cache lookup | 0.1 s |
| Gemini first pass (video understanding) | 2.5–3.5 s |
| Tool round-trips (1–2 × Firestore + Gemini) | 1.0–1.5 s |
| Validate + write + Firestore push to UI | 0.2 s |

Users see progress steps the whole time, so the wait reads as "the agent is investigating," not as a hang.

---

## 18. Production scale-up story (for the deck)

| Prototype | At 100× (real chain) |
|---|---|
| Browser runs Tier 1 | In-store edge box (Coral / Jetson / NVR plugin) runs the same rule engine |
| Direct HTTPS calls | Pub/Sub queue between stores and investigators, with back-pressure |
| Gemini Developer API free tier | Vertex AI Gemini with provisioned throughput, batch mode for overnight audits |
| One Firestore database | Per-chain tenancy, BigQuery export for shrink analytics |
| Synthetic POS | Real POS connectors (read-only), joined on lane + time |
| Cloud Run max 2 | Autoscaled; cost scales with *suspicious events*, not camera-hours, because Tier 1 filters 95%+ |

**What breaks first at 100×:** the Gemini rate limit, then Firestore hot-spotting on the incident feed. The fixes are
Vertex AI provisioned throughput and sharded per-store collections.
