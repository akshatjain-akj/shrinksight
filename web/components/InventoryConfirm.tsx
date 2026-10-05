"use client";

import { useState } from "react";
import type { InventoryItem } from "@/lib/types";
import { Spinner } from "./ui";

export type InventoryStatus = "off" | "listing" | "ready" | "failed" | "used";

export interface InventoryState {
  status: InventoryStatus;
  items: InventoryItem[];
  /** The user edited the list, so we wait for "Continue" instead of auto-continuing. */
  touched: boolean;
  confirmed: boolean;
  model?: string;
}

export const INVENTORY_OFF: InventoryState = { status: "off", items: [], touched: false, confirmed: false };

/** Gemini's item-pile list as editable chips. Continues automatically unless the user edits it. */
export default function InventoryConfirm({
  state,
  onChange,
}: {
  state: InventoryState;
  onChange: (next: InventoryState) => void;
}) {
  const [draft, setDraft] = useState("");
  if (state.status === "off") return null;
  const editable = state.status === "ready";

  const add = () => {
    const description = draft.trim().slice(0, 80);
    if (!description) return;
    onChange({ ...state, items: [...state.items, { description, box_2d: [] }], touched: true });
    setDraft("");
  };

  return (
    <section className="stack" aria-labelledby="inventory-title" aria-live="polite" style={{ gap: "0.5rem" }}>
      <h3 id="inventory-title" style={{ margin: 0 }}>
        Items in the pile
      </h3>
      {state.status === "listing" && <Spinner label="Gemini is listing the items in the pile…" />}
      {state.status === "failed" && (
        <p className="muted small" style={{ margin: 0 }}>
          Couldn’t list the items this time; Gemini will count them while watching the clip.
        </p>
      )}
      {(state.status === "ready" || state.status === "used") && (
        <>
          <div className="row" role="list">
            {state.items.map((item, index) => (
              <span key={index} className="chip tone-accent" role="listitem">
                #{index + 1} {item.description}
                {editable && (
                  <button
                    type="button"
                    className="linkish"
                    aria-label={`Remove ${item.description}`}
                    onClick={() =>
                      onChange({ ...state, items: state.items.filter((_, i) => i !== index), touched: true })
                    }
                  >
                    {" "}
                    ✕
                  </button>
                )}
              </span>
            ))}
            {state.items.length === 0 && <span className="muted small">No items found.</span>}
          </div>
          {editable && (
            <>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  add();
                }}
              >
                <label htmlFor="inventory-add" className="visually-hidden">
                  Add an item
                </label>
                <input
                  id="inventory-add"
                  type="text"
                  maxLength={80}
                  placeholder="Missing something? e.g. flat cloth flower"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  style={{ flex: 1, minWidth: 160 }}
                />
                <button type="submit" className="btn btn-sm" disabled={!draft.trim()}>
                  + Add
                </button>
              </form>
              {state.touched ? (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => onChange({ ...state, confirmed: true })}>
                  Continue with this list
                </button>
              ) : (
                <span className="hint">Continues automatically when the upload is ready. Edit the list to pause.</span>
              )}
            </>
          )}
          {state.status === "used" && (
            <span className="hint">
              Gemini is tracking these {state.items.length} items{state.model ? ` (listed by ${state.model})` : ""}.
            </span>
          )}
        </>
      )}
    </section>
  );
}
