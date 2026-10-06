import Link from "next/link";

export default function AboutPage() {
  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <div className="page-head">
        <div>
          <h1>About ShrinkSight</h1>
          <p>Retail loss prevention for the camera and the till.</p>
        </div>
      </div>

      <section className="card stack" id="problem">
        <h2>The problem</h2>
        <p style={{ margin: 0 }}>
          Stores lose money to theft and missed scans. Camera analytics raise so many false alarms that staff stop
          trusting them, and proving a self-checkout missed scan means scrubbing footage and matching it to the till by
          hand.
        </p>
      </section>

      <section className="card stack" id="how">
        <h2>How it works</h2>
        <ol className="stack" style={{ margin: 0, paddingLeft: "1.2rem" }}>
          <li>
            <strong>Tier 1, on the device:</strong> lightweight vision in the browser flags suspicious moments, like a hand
            going around the scanner or into a pocket. Open <Link href="/edge">Live edge</Link> to run it on this device.
            Faces are blurred before a clip can leave the browser.
          </li>
          <li>
            <strong>Tier 2, the Gemini agent:</strong> watches the short clip, calls tools to fetch the till receipt, the
            zone policy and item prices, then returns a structured verdict with timestamps, bounding boxes and an
            estimated loss.
          </li>
          <li>
            <strong>False alarms are rejected</strong> before anyone is disturbed. Real incidents go to a person, who
            always makes the final call.
          </li>
          <li>
            <strong>Rules in plain English:</strong> managers describe what to watch for and Gemini turns it into a rule
            the cameras enforce.
          </li>
        </ol>
      </section>

      <section className="card stack" id="privacy">
        <h2>Privacy</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: "1.2rem" }}>
          <li>Gemini is instructed to judge actions only, never appearance, age, gender or ethnicity.</li>
          <li>Clips are analysed and not stored; only the incident report is kept.</li>
          <li>The live edge blurs faces on the device. Raw frames stay in the browser.</li>
        </ul>
      </section>

      <section className="card stack" id="cloud">
        <h2>Google Cloud</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: "1.2rem" }}>
          <li>
            <strong>Gemini API</strong>: video understanding, function calling and structured output
          </li>
          <li>
            <strong>Cloud Run</strong>: the investigation API
          </li>
          <li>
            <strong>Firebase Hosting</strong>, <strong>Firestore</strong> and <strong>Firebase Auth</strong>
          </li>
        </ul>
      </section>
    </div>
  );
}
