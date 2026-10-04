"use client";

import { useEffect, useState } from "react";

export interface Step {
  label: string;
  done: boolean;
}

/** Live list of what the Gemini agent is doing, with an elapsed-time counter. */
export default function ProgressSteps({ steps, running }: { steps: Step[]; running: boolean }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [running]);

  return (
    <div className="stack" aria-live="polite">
      <ul className="steps steps-vertical">
        {steps.map((step, i) => (
          <li key={i} className={step.done ? "done" : undefined}>
            {step.done ? (
              <span className="tick" aria-hidden="true">
                ✓
              </span>
            ) : (
              <span className="spinner" aria-hidden="true" />
            )}
            {step.label}
            {!step.done && <span className="visually-hidden">(in progress)</span>}
          </li>
        ))}
      </ul>
      {running && <span className="muted small">Gemini is investigating… {elapsed}s</span>}
    </div>
  );
}
