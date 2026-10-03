# AI Builder Cup 2026 — Build Constraints (Context for Claude Code)

> Paste this file into Claude Code as project context (e.g. save as `CLAUDE.md` at repo root).
> Everything below is a HARD CONSTRAINT verified against https://aibuildercup.com on 2 Oct 2026,
> unless explicitly marked `[UNVERIFIED]`.

---

## 0. YOUR ROLE

You are helping build a submission for the **Google Cloud AI Builder Cup 2026** (organised by
Hack2skill, sponsored by Google Cloud). This is a JAPAC-region hackathon with a live Demo Day in
Singapore. Treat the rules below as non-negotiable acceptance criteria. Before proposing any
architecture, library, or deployment step, check it against §2 (Mandatory Stack) and §6
(Disqualification Triggers). If a suggestion would violate a rule, do not propose it — propose
a compliant alternative and say why.

**Always plan in plain English first and wait for my approval before writing code.**

---

## 1. WHAT MUST EXIST AT THE END

Four artifacts are mandatory. Treat each as a deliverable with its own definition-of-done.

| # | Artifact | Hard requirement |
|---|----------|------------------|
| 1 | **Working deployed link** | Live, publicly reachable URL of the prototype, deployed on Cloud Run / GCP / Firebase. Must work end-to-end without me being present. |
| 2 | **Demo video** | Public YouTube, Vimeo, or public Google Drive link. **Under 3 minutes.** |
| 3 | **Public GitHub repository** | Complete source of the prototype. Must be public. |
| 4 | **Deck** | PPT converted to **PDF**, explaining the solution in detail: problem, vision, impact/benefit to community, feasibility, scalability, architecture. |

Plus: the submission must **clearly identify the single chosen theme**.

**Language:** all code, documentation, presentations, and the video must be in **English**.

### Implications you must build for
- Every feature must be demoable in under 3 minutes. If a feature cannot be shown in the video,
  deprioritise it.
- The deployed URL must survive cold starts and be usable by a judge with no setup. No
  "run it locally" instructions, no localhost-only features, no required API keys from the judge.
- Write a README that assumes a judge with 5 minutes: what it does, the live URL, the architecture
  diagram, which Google AI services are used and where, and how to reproduce.
- Seed demo data must ship with the repo so the live URL is never empty.

---

## 2. MANDATORY TECH STACK (violating this = ineligible)

### 2.1 AI layer — REQUIRED
The prototype **must** integrate Google AI models or Google agentic platforms. Verbatim from the site:

> "all submissions must leverage Google AI models (like Gemini or Gemma) or be built using
> agentic platforms (such as Agent Platform, Antigravity, or AI Studio)"

So, pick from: **Gemini family**, **Gemma family**, **Agent Platform**, **Antigravity**, **AI Studio**.

**Rules for you:**
- Never substitute OpenAI, Anthropic, Mistral, Llama, Cohere, or any non-Google model as the primary
  reasoning engine. Not even as a fallback in committed code.
- Gen AI must be load-bearing. Judging explicitly penalises "basic or superficial implementation".
  A Gemini call that only rephrases text is weak. Gen AI should be doing something the app
  cannot do without it.
- Prefer deep, visible use of the Google AI stack — there is a dedicated **USD 2,000 "Best use of
  Google Cloud AI tools"** prize. Multimodality (video/audio/image understanding), function
  calling / tool use, structured output, grounding, and agentic multi-step reasoning all read as
  depth.

### 2.2 Deployment — REQUIRED
> "they must be deployed on Google Cloud via Cloud Run or Firebase"

And from the FAQ: *"successfully deployed on Cloud Run/GCP/Firebase."*

**Rules for you:**
- Target **Cloud Run** (containerised) or **Firebase** (Hosting / App Hosting / Functions).
- Containerise early. Do not leave Dockerfile + deploy to the last two days.
- Keep the service stateless and horizontally scalable; Cloud Run can scale to zero, so handle
  cold start gracefully and never hold state in process memory across requests.
- No AWS, Azure, Vercel, Netlify, Render, Fly.io, Heroku, or Railway for anything on the critical
  path. **"Solutions built primarily on other cloud platforms will not be eligible for evaluation."**
- Managed Google data/infra services are the safe default: Firestore, Cloud SQL, BigQuery,
  Cloud Storage, Pub/Sub, Cloud Tasks, Secret Manager, Vertex AI.

### 2.3 Third-party and external APIs
Allowed as supporting components, but:
- The **primary** stack must remain Google Cloud. External APIs may supply data, not core compute
  or core AI.
- Prefer free-tier / no-credit-card public APIs and open datasets. Document the source and licence
  of every dataset in the README.
- Never commit secrets. Use Secret Manager or Cloud Run env vars; `.env` must be gitignored, with
  a committed `.env.example`.

---

## 3. JUDGING CRITERIA — OPTIMISE AGAINST THESE WEIGHTS

The same four weighted criteria apply to all six themes.

### Technical Merit & Gen AI Implementation — 40%
- *Meaningful use of Gen AI:* does Gen AI contribute **directly** to solving the problem?
- *Technical implementation:* is it functional, technically sound, appropriately implemented?
- *Scalability & sustainability:* does it show potential for wider adoption and development
  beyond the prototype?

**What this means for your plans:** this is the largest bucket and it rewards working software plus
architectural credibility. Prioritise a genuinely functional happy path over breadth of features.
Include real error handling, retries/timeouts on model calls, input validation, and at least smoke
tests. Document the scaling story (what breaks at 100x, and what you'd change).

### Problem Alignment & Impact — 25%
- Does it effectively address the chosen theme?
- Clear, meaningful value for intended users/industry/community?

**What this means:** name a specific user and a specific painful workflow. Quantify the before/after
if at all possible. Every feature must trace back to the chosen theme — cut anything that doesn't.

### Innovation & Creativity — 25%
- *Originality & differentiation:* fresh perspective, novel approach, meaningful differentiation
  from existing solutions?
- *Innovation in use of Gen AI:* creative application **beyond a basic or superficial
  implementation**?

**What this means:** avoid the saturated archetypes — generic "chat with your PDF/docs", a plain
RAG wrapper, a basic support chatbot, a resume screener, a text summariser. If the plan drifts
toward one of those, flag it to me explicitly. Prefer non-obvious input modalities and
non-obvious outputs.

### User Experience & Solution Design — 10%
- Intuitive, user-friendly, reasonably accessible.
- Components including Gen AI work together cohesively for a smooth experience.

**What this means:** there is a separate **USD 2,000 "Best UI/UX"** prize. Budget real time for the
front end. Handle loading states for slow model calls (stream tokens, show progress), empty states,
and errors. Mobile-responsive. Basic a11y: semantic HTML, labels, contrast, keyboard navigation.

---

## 4. CHOOSE EXACTLY ONE THEME

One team may submit **one** solution under **one** problem statement/theme. Record the chosen theme
at the top of the README and in the deck.

1. **BFSI: Intelligent Risk, Fraud & Financial Experiences** — banking, financial services,
   insurance. Fraud/risk detection and mitigation, automating complex processes, improving customer
   interactions, personalised financial experiences.
2. **Retail & Commerce: Intelligent Customer and Business Experiences** — discovery,
   personalisation, conversational shopping, demand planning, inventory, customer insights, fraud.
3. **Manufacturing: Intelligent Operations & Industrial Efficiency** — efficiency, quality,
   reliability, supply and demand, sustainability; turning operational data into insights,
   recommendations, or actions.
4. **Media, Content & Digital Experiences** — how content is created, discovered, personalised,
   understood, or experienced; media, entertainment, publishing, education, communication.
5. **Future of Work & Enterprise Productivity** — access to knowledge, collaboration,
   decision-making, completing everyday work; productivity, efficiency, knowledge accessibility,
   workflow execution.
6. **Sustainability & Social Impact** — environmental or societal challenges; resource efficiency,
   accessibility, resilience, supporting communities, sustainable decision-making.

> Note: the "Category Specification" bullet on the submission page lists *(Healthcare, Education,
> Sustainability, Accessibility, Social Good)* — this looks like leftover template text that
> contradicts the six themes above. **Treat the six themes as authoritative.**

---

## 5. TIMELINE — PLAN BACKWARDS FROM THIS

| Milestone | Date |
|---|---|
| Registration & team formation | 1 Sept – 11 Oct 2026 |
| Prototype building & submission window | 7 Sept – 18 Oct 2026 |
| **Prototype submission deadline** | **18 Oct 2026** |
| Evaluation phase | 19 Oct – 6 Nov 2026 |
| Finalists announced | 7 Nov 2026 |
| Grand Finale — Demo Day, Singapore | 4 Dec 2026 |

There is a **scoring round before the Grand Finale** that decides who travels to Singapore. The
submitted artifacts alone must win that round — assume no live explanation.

**Planning rule:** work back from 18 Oct. Reserve the final ~3 days for deployment hardening, the
video, and the deck — not for features. Deliver a deployable thin slice in the first third of the
remaining time, then iterate. Never leave the repo in a non-deployable state overnight.

---

## 6. DISQUALIFICATION TRIGGERS — CHECK EVERY PLAN AGAINST THIS

- **No pre-existing work.** "Only fresh projects built during the hackathon timeline are eligible.
  Submissions based on pre-existing projects, or work started before the program launch, will not
  be considered." Do not import my old projects or private prior code. Start the repo fresh inside
  the window, with honest commit history. Public open-source libraries/frameworks are normal
  dependencies, not pre-existing work — but do not fork an existing product and reskin it.
- **No competing cloud as the primary platform.**
- **One theme, one submission.** No submitting across multiple themes.
- **Eligibility:** working professionals, entrepreneurs, startups. **Students are not eligible** —
  a single student on the team disqualifies the whole team, even after shortlisting. All
  participants **21+** at registration. Team of **2–4 members**, JAPAC region. Only **2 members**
  travel to Singapore if shortlisted.
- **Content/compliance:** no third-party copyrighted material you don't have rights to, no real
  PII in demos, no malware, nothing unlawful. Google Cloud ToS / acceptable use applies.
- **Everything public that must be public:** repo public, video link public, deployed URL
  publicly reachable. A private repo or an expired/403 link is a self-inflicted zero.

### Demo-data rule (do not skip)
Use **synthetic or properly licensed open data only**. If the theme needs financial, health, or
personal records, generate synthetic records. Never put real customer, employer, or proprietary
data in the repo, the deployed app, or the video. Scrub any real names, account numbers, emails,
and phone numbers from screenshots and the demo video.

---

## 7. LEGAL / IP FLAGS TO SURFACE, NOT DECIDE

The binding document is the **Initiative Terms & Conditions**:
https://docs.google.com/document/d/e/2PACX-1vRm7ChZ6Ij9fG7uFDkxzUMpwgVeBmnQ6cMDnAIEEX84AiLBOOQ9cYbl3S5OzFBbcVb8TF55s-eVpiXb/pub

`[UNVERIFIED — I have not read the full T&C text myself]` Reported to contain a **right of first
refusal** for the organiser over submitted IP for a period after the hackathon, plus a broad
marketing/publicity licence. **Do not** build anything on top of my employer's proprietary IP,
internal data, or confidential material. Keep the project fully independent and personally owned.
If a plan would touch employer IP, stop and tell me.

---

## 8. OPERATING RULES FOR YOU (CLAUDE CODE)

1. **Plan in plain English first. Wait for my approval before writing code.** State the chosen
   theme, the user, the core Gen AI mechanic, the Google Cloud services, and the demo script.
2. **Compliance check before every architecture decision.** If a choice risks §2 or §6, say so
   and offer a compliant alternative.
3. **Demo-first prioritisation.** For each proposed feature, state where it appears in the
   sub-3-minute video. If it doesn't appear, justify it or cut it.
4. **Deployability is a standing invariant.** Dockerfile/Firebase config and a deploy path exist
   from day one. Keep `main` deployable at all times.
5. **No scope creep.** Depth on one mechanic beats five shallow features — Technical Merit is 40%
   and rewards "meaningful", not "many".
6. **Flag convergence risk.** If the idea resembles a common AI-hackathon archetype, say so
   unprompted and propose differentiation. Originality is 25%.
7. **Keep an architecture diagram and README current** as the build evolves — both feed the deck.
8. **Secrets discipline:** Secret Manager or Cloud Run env vars; never commit keys; ship
   `.env.example`.
9. **Cost discipline:** stay inside free tiers / minimal spend. Set Cloud Run min-instances to 0
   unless cold start breaks the demo, cap max-instances, and prefer the cheapest adequate Gemini
   model tier.
10. **Don't invent rules.** If a requirement isn't in this file, say "not specified in the brief"
    and ask, rather than assuming.

---

## 9. DEFINITION OF DONE (pre-submission checklist)

- [ ] Deployed on Cloud Run or Firebase; public URL loads cold, in an incognito window, on mobile
- [ ] Gemini / Gemma / Agent Platform / Antigravity / AI Studio is in the critical path, and it is
      obvious from the UI why
- [ ] No non-Google model in committed code; no non-Google cloud on the critical path
- [ ] GitHub repo is public; README has theme, live URL, architecture diagram, AI services used,
      setup steps, and data sources + licences
- [ ] Demo video is public and **under 3:00**, in English, shows the end-to-end happy path
- [ ] Deck exported to **PDF**: problem, solution, impact, feasibility, scalability, architecture
- [ ] Exactly one theme declared, consistently, everywhere
- [ ] Repo created and all work done inside the hackathon window; no prior code imported
- [ ] No real PII or proprietary data anywhere in repo, app, deck, or video
- [ ] No secrets in git history
- [ ] Error, loading, and empty states handled; seeded demo data present
- [ ] Submitted before **18 Oct 2026** (submit a working version early, then update)

---

## 10. SOURCES

- Overview / eligibility / timeline — https://aibuildercup.com/
- Themes, what you'll build, what you'll submit, judging criteria — https://aibuildercup.com/themes.html
- Prizes — https://aibuildercup.com/rewards.html
- FAQs (submission format, Google Cloud requirement, fresh-work rule, one-theme rule, pre-finale
  scoring round) — https://aibuildercup.com/Faqs.html
- Initiative Terms & Conditions (binding; read in full) — see §7 link

**Prize pool:** USD 30,000 total — Winner 10,000 / 1st runner-up 7,000 / 2nd runner-up 5,000 /
Best use of Google Cloud AI tools 2,000 / Most Impactful Solution 2,000 / Social Choice Award
2,000 / Best UI/UX 2,000. Shortlisted teams get sponsored travel and stay in Singapore.

**`[UNVERIFIED]`** The exact number of finalist teams is not stated on the public pages. Submission
timezone is not stated on the public pages — assume the Hack2skill platform deadline (likely IST)
and submit a day early.
