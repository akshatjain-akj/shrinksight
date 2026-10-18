"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { AskAnswer, Incident } from "@/lib/types";
import { ErrorNotice, Spinner } from "./ui";

function suggestions(incident: Incident): string[] {
  const base =
    incident.camera_kind === "checkout"
      ? ["Has this lane had other missed scans today?", "Which items were not on the receipt, and what are they worth?"]
      : ["Have there been other incidents on this camera today?", "What is the policy for this zone?"];
  return [...base, "What is the total estimated loss across all cameras this week?"];
}

/** A Gemini agent answers questions about this incident, calling store-data tools; each call is shown as a step. */
export default function AskPanel({ incident }: { incident: Incident }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<AskAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (text: string) => {
    const q = text.trim();
    if (q.length < 3) return;
    setQuestion(q);
    setAsking(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await api.ask(incident.id, q));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  return (
    <section className="card stack" aria-labelledby="ask-title">
      <h2 id="ask-title">Ask about this incident</h2>
      <p className="muted small" style={{ margin: 0 }}>
        A Gemini agent looks things up in the store data (incidents, receipts, zones, prices) to answer.
      </p>
      <form
        className="ask-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(question);
        }}
      >
        <label htmlFor={`ask-${incident.id}`} className="visually-hidden">
          Your question
        </label>
        <input
          id={`ask-${incident.id}`}
          type="text"
          maxLength={240}
          placeholder="e.g. Has this lane had other missed scans today?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button type="submit" className="btn btn-primary" disabled={asking || question.trim().length < 3}>
          {asking ? "Asking…" : "Ask"}
        </button>
      </form>
      <div className="ask-suggestions" aria-label="Example questions">
        {suggestions(incident).map((s) => (
          <button key={s} type="button" className="chip" disabled={asking} onClick={() => void submit(s)}>
            {s}
          </button>
        ))}
      </div>
      {asking && <Spinner label="Gemini is looking it up…" />}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      {answer && (
        <div className="stack" aria-live="polite">
          {answer.steps.length > 0 && (
            <ul className="steps" aria-label="What the agent looked up">
              {answer.steps.map((step, i) => (
                <li key={i} className="done">
                  <span className="tick" aria-hidden="true">
                    ✓
                  </span>
                  {step.label}
                </li>
              ))}
            </ul>
          )}
          <blockquote className="reason">{answer.answer}</blockquote>
          <span className="muted small">Answered by {answer.model}</span>
        </div>
      )}
    </section>
  );
}
