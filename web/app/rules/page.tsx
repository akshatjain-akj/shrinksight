"use client";

import { useState } from "react";
import { ErrorNotice, Skeletons, Spinner } from "@/components/ui";
import { api } from "@/lib/api";
import { useRules, useStore } from "@/lib/hooks";
import type { Rule, RuleSpec, Zone } from "@/lib/types";

const EXAMPLES = [
  "Alert if anyone stays at the spirits shelf for more than 45 seconds after 9pm",
  "Tell me if someone goes near the store exit between 10pm and 7am",
  "Alert if an item is put into a jacket pocket at the spirits shelf",
  "Alert if an item is placed into a personal bag at the spirits shelf",
  "Alert if an item is tucked under a shirt at the spirits shelf",
  "Alert if an item is slid into the waistband at the spirits shelf",
  "Flag items going around the scanner at lane 2",
];

const HIDE_LABEL: Record<string, string> = {
  pocket: "Jacket pocket",
  bag: "Personal bag",
  shirt: "Under shirt",
  waistband: "Waistband",
};

const TYPE_LABEL: Record<string, string> = {
  DWELL: "Loitering",
  ZONE_ENTRY: "Zone entry",
  CONCEALMENT_SENSITIVITY: "Concealment sensitivity",
  SCANNER_BYPASS: "Scanner bypass",
};

function SpecChips({ spec, zones }: { spec: RuleSpec; zones: Zone[] }) {
  const zone = zones.find((z) => z.id === spec.zone_id);
  return (
    <div className="row">
      {spec.type && <span className="chip tone-accent">{TYPE_LABEL[spec.type]}</span>}
      {zone && <span className="chip">{zone.name}</span>}
      {spec.min_seconds != null && <span className="chip">&gt; {spec.min_seconds} s</span>}
      {spec.active_from && spec.active_to && (
        <span className="chip">
          {spec.active_from}–{spec.active_to}
        </span>
      )}
      {spec.sensitivity && <span className="chip">{spec.sensitivity} sensitivity</span>}
      {spec.concealment_of && <span className="chip">{HIDE_LABEL[spec.concealment_of]}</span>}
      <span className={`chip ${spec.severity === "HIGH" ? "tone-danger" : spec.severity === "MEDIUM" ? "tone-warning" : ""}`}>
        {spec.severity.toLowerCase()} severity
      </span>
    </div>
  );
}

function RuleRow({ rule, zones }: { rule: Rule; zones: Zone[] }) {
  const [enabled, setEnabled] = useState(rule.enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      setEnabled((await api.setRuleEnabled(rule.id, !enabled)).enabled);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rule-item">
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={enabled}
        aria-label={`${enabled ? "Disable" : "Enable"} rule: ${rule.spec.summary}`}
        disabled={busy}
        onClick={toggle}
      />
      <div className="stack" style={{ gap: "0.35rem", flex: 1 }}>
        <strong style={{ opacity: enabled ? 1 : 0.6 }}>{rule.spec.summary}</strong>
        <span className="muted small">“{rule.source_text}”</span>
        <SpecChips spec={rule.spec} zones={zones} />
        {error && <ErrorNotice>{error}</ErrorNotice>}
      </div>
    </li>
  );
}

export default function RulesPage() {
  const { store } = useStore();
  const { data: rules, error: rulesError } = useRules();
  const zones = store?.zones ?? [];
  const [text, setText] = useState("");
  const [compiled, setCompiled] = useState<{ spec: RuleSpec; problems: string[]; cached: boolean } | null>(null);
  const [compiling, setCompiling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const translate = async () => {
    setCompiling(true);
    setError(null);
    setSaved(null);
    setCompiled(null);
    try {
      setCompiled(await api.compileRule(text.trim()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCompiling(false);
    }
  };

  const save = async () => {
    if (!compiled) return;
    setSaving(true);
    setError(null);
    try {
      const rule = await api.createRule(text.trim(), compiled.spec);
      setSaved(rule.spec.summary);
      setCompiled(null);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Store rules</h1>
          <p>Describe a rule in plain English. Gemini turns it into a structured rule the cameras can enforce.</p>
        </div>
      </div>

      <div className="grid-main">
        <div className="stack">
          <section className="card stack" aria-labelledby="new-rule-title">
            <h2 id="new-rule-title">New rule</h2>
            <div className="field">
              <label htmlFor="rule-text">What should ShrinkSight watch for?</label>
              <textarea
                id="rule-text"
                value={text}
                maxLength={300}
                placeholder="e.g. Alert if anyone stays at the spirits shelf for more than 45 seconds after 9pm"
                onChange={(e) => setText(e.target.value)}
              />
              <span className="hint">Rules describe actions and places, never how people look.</span>
            </div>
            <div className="row" aria-label="Examples">
              {EXAMPLES.map((example) => (
                <button key={example} type="button" className="chip" onClick={() => setText(example)}>
                  {example.length > 42 ? `${example.slice(0, 42)}…` : example}
                </button>
              ))}
            </div>
            <div className="row">
              <button
                type="button"
                className="btn btn-primary"
                disabled={text.trim().length < 5 || compiling}
                onClick={translate}
              >
                {compiling ? "Translating…" : "Translate with Gemini"}
              </button>
              {compiling && <Spinner />}
            </div>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            {saved && (
              <div className="notice" role="status">
                ✓ Saved: {saved}. It’s now active on the matching camera.
              </div>
            )}
          </section>

          {compiled && (
            <section className="card stack" aria-live="polite" aria-labelledby="compiled-title">
              <h2 id="compiled-title">Gemini understood</h2>
              <p style={{ margin: 0, fontSize: "1.05rem" }}>
                <strong>{compiled.spec.summary}</strong>
              </p>
              <SpecChips spec={compiled.spec} zones={zones} />
              {compiled.problems.length > 0 ? (
                <ErrorNotice>{compiled.problems.join(" ")}</ErrorNotice>
              ) : (
                <div className="row">
                  <button type="button" className="btn btn-success" disabled={saving} onClick={save}>
                    {saving ? "Saving…" : "✓ Looks right, save rule"}
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setCompiled(null)}>
                    Edit wording
                  </button>
                </div>
              )}
              {compiled.cached && <span className="muted small">Served from cache (no AI quota used).</span>}
            </section>
          )}

          <section className="card" aria-labelledby="zones-title">
            <h2 id="zones-title">Zones in this store</h2>
            <div className="row">
              {zones.map((z) => (
                <span key={z.id} className={`chip ${z.high_value ? "tone-warning" : ""}`}>
                  {z.name}
                </span>
              ))}
            </div>
            <p className="hint">Drawing your own zones on camera frames is coming with live footage.</p>
          </section>
        </div>

        <section className="card" aria-labelledby="rules-title">
          <h2 id="rules-title">Active rules</h2>
          {rulesError && <ErrorNotice>{rulesError}</ErrorNotice>}
          {!rules && !rulesError && <Skeletons count={2} />}
          {rules && rules.length === 0 && <p className="muted">No rules yet. Create one on the left.</p>}
          {rules && (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {rules.map((rule) => (
                <RuleRow key={`${rule.id}-${rule.enabled}`} rule={rule} zones={zones} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
