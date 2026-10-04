import { VERDICT_LABEL, clipSeconds } from "@/lib/format";
import type { Incident, SeenItem } from "@/lib/types";

function styleFor(box: number[]) {
  const [ymin, xmin, ymax, xmax] = box;
  return {
    top: `${ymin / 10}%`,
    left: `${xmin / 10}%`,
    height: `${(ymax - ymin) / 10}%`,
    width: `${(xmax - xmin) / 10}%`,
  };
}

function labelFor(incident: Incident, item: SeenItem, primary: boolean): string {
  const scan = item.scanned ? "Scanned" : "Not scanned";
  if (!primary) return `${scan} · ${item.description}`;
  const verdict = `${VERDICT_LABEL[incident.verdict.verdict]} ${Math.round(incident.verdict.confidence * 100)}%`;
  return `${verdict} · ${scan} · ${item.description}`;
}

/** Item boxes from a Gemini verdict, in the clip's 0–1000 space. */
export default function ClipMarks({ incident, playhead }: { incident: Incident; playhead?: number }) {
  const marks = incident.verdict.seen_items.filter((item) => item.box_2d?.length === 4);
  const reached =
    playhead == null ? marks : marks.filter((item) => clipSeconds(item.t) <= playhead + 0.35);
  const shown = reached.length > 0 ? reached : marks.slice(0, 1);
  const primary = shown.find((item) => !item.scanned) ?? shown[0];
  if (shown.length === 0) {
    return (
      <span className="clip-verdict">
        {VERDICT_LABEL[incident.verdict.verdict]} {Math.round(incident.verdict.confidence * 100)}%
      </span>
    );
  }
  return (
    <>
      {shown.map((item) => (
        <span
          key={`${item.t}-${item.description}`}
          className={`clip-box ${item.scanned ? "scanned" : "missed"}`}
          style={styleFor(item.box_2d)}
        >
          <span>{labelFor(incident, item, item === primary)}</span>
        </span>
      ))}
    </>
  );
}
