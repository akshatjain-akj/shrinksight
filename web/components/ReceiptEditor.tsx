"use client";

import type { ReceiptLine } from "@/lib/types";

export const emptyLine = (): ReceiptLine => ({ name: "", price_inr: 0 });

/** Editable till receipt: what was actually scanned at the lane. */
export default function ReceiptEditor({ lines, onChange }: { lines: ReceiptLine[]; onChange: (l: ReceiptLine[]) => void }) {
  const update = (i: number, patch: Partial<ReceiptLine>) =>
    onChange(lines.map((line, j) => (j === i ? { ...line, ...patch } : line)));

  return (
    <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="visually-hidden">Items on the till receipt</legend>
      {lines.map((line, i) => (
        <div key={i} className="receipt-row">
          <input
            type="text"
            aria-label={`Item ${i + 1} name`}
            placeholder={`Item ${i + 1}, e.g. cereal box`}
            value={line.name}
            maxLength={80}
            onChange={(e) => update(i, { name: e.target.value })}
          />
          <input
            type="number"
            aria-label={`Item ${i + 1} price in rupees`}
            placeholder="₹"
            min={0}
            value={line.price_inr || ""}
            onChange={(e) => update(i, { price_inr: Number(e.target.value) || 0 })}
          />
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-label={`Remove item ${i + 1}`}
            disabled={lines.length === 1}
            onClick={() => onChange(lines.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={lines.length >= 30}
          onClick={() => onChange([...lines, emptyLine()])}
        >
          + Add item
        </button>
      </div>
    </fieldset>
  );
}
