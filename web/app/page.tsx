import type { Metadata } from "next";
import Link from "next/link";
import HeroStage from "@/components/HeroStage";
import Reveal from "@/components/Reveal";

export const metadata: Metadata = {
  title: "ShrinkSight · Real-time vigilance for retail",
  description:
    "Two-tier retail loss prevention. On-device vision gates the cameras. Gemini investigates only the ambiguous clips and checks them against the till.",
};

const DATA_FLOW = [
  { title: "Webcam or file", body: "Live camera uses the score gate. An uploaded file skips it." },
  { title: "MediaPipe", body: "Pose on device. Faces are blurred on the canvas before the clip is recorded." },
  { title: "Short WebM", body: "About four seconds. Sent to Cloud Run with the camera and Tier 1 hints." },
  { title: "Cache", body: "Same clip hash, camera, and transaction returns the saved incident." },
  { title: "Gemini", body: "Watches the clip, then calls the till, zone, and SKU tools." },
  { title: "Incident", body: "Verdict is saved. Monitor, Playback, and review read it back." },
];

const STORE = [
  { name: "Camera", links: "Zones, lane transactions, incidents" },
  { name: "Zone", links: "Belongs to a camera. Rules point here." },
  { name: "Transaction", links: "Till receipt for a lane. Checkout incidents can cite it." },
  { name: "SKU", links: "Catalogue price. Matched onto unscanned items." },
  { name: "Incident", links: "Verdict, loss, status. Confirm or dismiss updates it." },
  { name: "Rule", links: "Plain-English source plus a zone spec." },
  { name: "Cache", links: "Clip hash to incident id. No video bytes." },
];

const FLOW = [
  { kicker: "Input", title: "Camera streams", body: "Self-checkout lanes and floor cameras." },
  { kicker: "Tier 1", title: "Edge inference", body: "MediaPipe pose, hands and objects. Constant, on the device." },
  { kicker: "Gate", title: "Ambiguous moment?", body: "Clear frames stop here. Only a short clip moves on." },
  { kicker: "Tier 2", title: "Gemini adjudicator", body: "Watches the clip, calls the till, zone and price tools." },
  { kicker: "Output", title: "Verified alert", body: "Structured incident, evidence timestamps, human confirm." },
];

const DIFFS = [
  {
    tone: "accent",
    title: "Edge first",
    metric: "On device",
    body: "Tier 1 stays in the browser. No GPU box, no Jetson, and the public demo still runs.",
  },
  {
    tone: "success",
    title: "Humans see the hard cases",
    metric: "Gated alerts",
    body: "Staff are not paged for every motion. Gemini rejects the false alarm or sends a review.",
  },
  {
    tone: "accent",
    title: "Privacy by design",
    metric: "Actions, not faces",
    body: "The agent judges what someone did, never appearance. Clips are analysed; the report is what is kept.",
  },
  {
    tone: "warning",
    title: "API only on the gate",
    metric: "95% stay local",
    body: "Architecture target: most frames never call Gemini. The model runs on the suspicious minority.",
  },
];

const USES = [
  {
    title: "Self-checkout shrink",
    body: "Gemini counts items handled on camera, fetches the receipt, and names what never hit the till.",
  },
  {
    title: "Floor and high-value zones",
    body: "Plain-English rules, such as a long dwell at the liquor shelf after close, become enforceable checks.",
  },
  {
    title: "Restricted areas",
    body: "The same gate flags a person in a staff-only zone, then Gemini writes the forensic log for review.",
  },
];

export default function LandingPage() {
  return (
    <div className="landing">
      <p className="sec-status" role="status">
        <span className="sec-dot" aria-hidden="true" />
        Perimeter watch · Demo Mart · synthetic feed · Gemini standby
      </p>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">AI Builder Cup 2026 · Retail &amp; Commerce · classified demo</p>
          <h1 id="hero-title">
            <span className="sec-line">Real-time vigilance.</span>
            <span className="sec-line">False alarms rejected.</span>
          </h1>
          <p className="lede">
            Two-tier adjudication for retail loss prevention. On-device vision watches every frame. Gemini
            investigates only the ambiguous clip, and checks it against the till.
          </p>
          <ul className="sec-pips">
            <li>Tier 1 on device</li>
            <li>Gate at 0.40</li>
            <li>Gemini on the clip</li>
          </ul>
          <div className="row">
            <Link href="/investigate" className="btn btn-primary btn-lg">
              Request demo
            </Link>
            <a href="#architecture" className="btn btn-lg">
              Explore architecture
            </a>
            <Link href="/edge" className="btn btn-lg">
              Watch the edge
            </Link>
          </div>
          <p className="muted small">Opens the live prototype. No login. Synthetic store data only.</p>
        </div>

        <figure className="hero-stage">
          <HeroStage>
            <div className="hero-badge">95% of frames stay on device</div>
            <div className="sec-frame" aria-hidden="true">
              <span className="sec-corner tl" />
              <span className="sec-corner tr" />
              <span className="sec-corner bl" />
              <span className="sec-corner br" />
              <div className="mock">
                <div className="mock-bar">
                  <span />
                  <span />
                  <span />
                  <strong>CAM-03 · Lane 3 · LOCK</strong>
                </div>
                <div className="mock-body">
                  <div className="mock-video">
                    <span className="sec-scan" />
                    <span className="mock-box">Skipped item · 0:08</span>
                    <span className="mock-hud">REC · 1080P · POSE LIVE</span>
                  </div>
                  <div className="mock-vlm">
                    <p className="mock-kicker">Gemini verdict</p>
                    <p className="mock-verdict">Needs review · missed scan</p>
                    <ul>
                      <li>Watched the clip</li>
                      <li>Checked till receipt, lane 3</li>
                      <li>Bottle never scanned · ₹180</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </HeroStage>
          <figcaption className="visually-hidden">
            Illustration of an incident review: Gemini marks a skipped item against the till receipt.
          </figcaption>
        </figure>
      </section>

      <Reveal className="pitch-block" labelledBy="problem-title">
        <div className="pitch-copy">
          <p className="eyebrow">The problem</p>
          <h2 id="problem-title">False-alarm fatigue</h2>
          <p>
            Guards and self-checkout attendants stop trusting cameras when every shadow is an alert. The real
            miss — an item that went around the scanner — gets lost in the noise, then someone scrubs footage
            against the till by hand.
          </p>
        </div>
        <div className="compare" aria-label="False alarm comparison">
          <div>
            <div className="compare-label">
              <span>Typical video analytics</span>
              <strong>90%+ false alarms</strong>
            </div>
            <div className="bar" role="img" aria-label="About ninety percent noise">
              <span className="bar-fill bar-bad" style={{ width: "92%" }} />
            </div>
          </div>
          <div>
            <div className="compare-label">
              <span>ShrinkSight design target</span>
              <strong>&lt;10% reach a person</strong>
            </div>
            <div className="bar" role="img" aria-label="Under ten percent reach a person">
              <span className="bar-fill bar-good" style={{ width: "10%" }} />
            </div>
          </div>
          <p className="muted small">Industry pattern versus the gating target. Not a measured customer study.</p>
        </div>
      </Reveal>

      <Reveal className="pitch-block" id="architecture" labelledBy="arch-title">
        <p className="eyebrow">The solution</p>
        <h2 id="arch-title">Two-tier architecture</h2>
        <p className="lede tight">
          Cheap vision runs all the time. The expensive model runs only when the moment is ambiguous.
        </p>
        <ol className="flow">
          {FLOW.map((step, i) => (
            <li key={step.title} style={{ ["--i" as string]: i }}>
              <span className="flow-index">{i + 1}</span>
              <span className="flow-kicker">{step.kicker}</span>
              <strong>{step.title}</strong>
              <span>{step.body}</span>
            </li>
          ))}
        </ol>

        <h3 id="data-flow-title">Data flow</h3>
        <p className="muted">The clip is discarded after Gemini replies. The store keeps the incident and a cache pointer.</p>
        <ol className="data-flow" aria-labelledby="data-flow-title">
          {DATA_FLOW.map((step, i) => (
            <li key={step.title} style={{ ["--i" as string]: i }}>
              <strong>{step.title}</strong>
              <span>{step.body}</span>
            </li>
          ))}
        </ol>

        <h3 id="store-title">Store</h3>
        <p className="muted">Firestore in production. The same collections sit in memory for local runs.</p>
        <div className="store-map" aria-labelledby="store-title">
          {STORE.map((node, i) => (
            <article key={node.name} className="store-node" style={{ ["--i" as string]: i }}>
              <h4>{node.name}</h4>
              <p>{node.links}</p>
            </article>
          ))}
        </div>
      </Reveal>

      <Reveal className="pitch-block" labelledBy="diff-title">
        <p className="eyebrow">Why it is different</p>
        <h2 id="diff-title">What judges should remember</h2>
        <div className="diff-grid">
          {DIFFS.map((item, i) => (
            <article key={item.title} className={`diff tone-${item.tone}`} style={{ ["--i" as string]: i }}>
              <p className="diff-metric">{item.metric}</p>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </Reveal>

      <Reveal className="pitch-block" labelledBy="market-title">
        <p className="eyebrow">Where it pays</p>
        <h2 id="market-title">Retail first. Same gate elsewhere.</h2>
        <div className="use-grid">
          {USES.map((use, i) => (
            <article key={use.title} className="card" style={{ ["--i" as string]: i }}>
              <h3>{use.title}</h3>
              <p>{use.body}</p>
            </article>
          ))}
        </div>
      </Reveal>

      <Reveal className="cta-band" labelledBy="cta-title">
        <div>
          <h2 id="cta-title">Ready to see a gated alert?</h2>
          <p>Run a clip through the Gemini agent, or open the live incident monitor.</p>
        </div>
        <div className="row">
          <Link href="/investigate" className="btn btn-primary btn-lg">
            Request a pilot
          </Link>
          <Link href="/monitor" className="btn btn-lg">
            Open the monitor
          </Link>
        </div>
      </Reveal>
    </div>
  );
}
