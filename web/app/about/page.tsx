import Link from "next/link";

export default function AboutPage() {
  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div>
          <h1>About ShrinkSight</h1>
          <p>Retail &amp; Commerce · Google Cloud AI Builder Cup 2026</p>
        </div>
      </div>

      <section className="card stack">
        <h2>The problem</h2>
        <p style={{ margin: 0 }}>
          Stores lose money to theft and missed scans (“shrink”). Camera analytics raise so many false alarms that staff
          stop trusting them, and proving a self-checkout missed scan means scrubbing footage and matching it to the till by
          hand.
        </p>
      </section>

      <section className="card stack">
        <h2>How it works</h2>
        <ol className="stack" style={{ margin: 0, paddingLeft: "1.2rem" }}>
          <li>
            <strong>Tier 1, on the device:</strong> lightweight vision in the browser flags suspicious moments, like a hand
            going around the scanner or into a pocket. Open <Link href="/edge">Live edge</Link> to run it on
            this device. Faces are blurred before a clip can leave the browser.
          </li>
          <li>
            <strong>Tier 2, the Gemini agent:</strong> watches the short clip, calls tools to fetch the till receipt, the zone
            policy and item prices, then returns a structured verdict with timestamps, bounding boxes and an estimated loss.
          </li>
          <li>
            <strong>False alarms are rejected</strong> before anyone is disturbed. Real incidents go to a person, who always
            makes the final call.
          </li>
          <li>
            <strong>Rules in plain English:</strong> managers describe what to watch for and Gemini turns it into a rule the
            cameras enforce.
          </li>
        </ol>
      </section>

      <section className="card stack">
        <h2>Privacy and responsible AI</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: "1.2rem" }}>
          <li>Gemini is instructed to judge actions only, never appearance, age, gender or ethnicity.</li>
          <li>Clips are analysed and not stored; only the incident report is kept.</li>
          <li>The live edge blurs faces on the device. Raw frames stay in the browser.</li>
          <li>All store data, receipts and example incidents are synthetic.</li>
        </ul>
      </section>

      <section className="card stack">
        <h2>Built with Google Cloud</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: "1.2rem" }}>
          <li>
            <strong>Gemini API</strong>: video understanding, function calling and structured output
          </li>
          <li>
            <strong>Cloud Run</strong>: the investigation API (FastAPI)
          </li>
          <li>
            <strong>Firebase Hosting</strong>, <strong>Firestore</strong> (live incident feed) and{" "}
            <strong>Firebase Auth</strong>
          </li>
          <li>
            <strong>Secret Manager</strong>, <strong>Artifact Registry</strong> and keyless CI/CD from GitHub Actions
          </li>
        </ul>
        <p className="muted small" style={{ margin: 0 }}>
          System status: <Link href="/setup">setup check</Link>
        </p>
      </section>
    </div>
  );
}
