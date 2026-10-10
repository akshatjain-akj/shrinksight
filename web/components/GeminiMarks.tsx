"use client";

import { visibleMarks } from "@/lib/marks";
import type { SeenItem } from "@/lib/types";

/**
 * Gemini's item boxes over a playing clip: each box shows around its item's moment, the flagged item in red, others
 * grey. Shared by the incident page and Playback so both always draw the stored result the same way. Positioned in
 * percent of the player, which is sized to the clip (see fitPlayer).
 */
export default function GeminiMarks({ items, focus, playhead }: {
  items: SeenItem[];
  focus: SeenItem | null;
  /** Video time in seconds; null when there is no video (only the flagged item is drawn, as a still). */
  playhead: number | null;
}) {
  return (
    <>
      {visibleMarks(items, focus, playhead).map((item) => {
        const [ymin, xmin, ymax, xmax] = item.box_2d;
        return (
          <div
            key={`${item.t}-${item.description}`}
            className={`bbox${item === focus ? "" : " other"}`}
            style={{
              top: `${ymin / 10}%`,
              left: `${xmin / 10}%`,
              height: `${(ymax - ymin) / 10}%`,
              width: `${(xmax - xmin) / 10}%`,
            }}
          >
            <span>
              {item.description} · {item.t}
            </span>
          </div>
        );
      })}
    </>
  );
}
