/** Which Gemini item boxes to draw over the evidence video, and when. */

export interface Markable {
  t: string;
  box_2d: number[];
  scanned: boolean;
}

/** A box is drawn only this close (seconds) to its item's moment; elsewhere the item isn't there. */
export const MARK_WINDOW_S = 0.7;

/** "mm:ss.s" → seconds. */
export function markSeconds(t: string): number {
  const parts = t.split(":").map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

const boxed = (item: Markable) => item.box_2d?.length === 4;

/** The item the screen opens on: the first one that wasn't paid for and has a box. */
export function flaggedItem<T extends Markable>(items: T[]): T | null {
  return items.find((item) => !item.scanned && boxed(item)) ?? null;
}

/**
 * Boxes to draw at the playhead (seconds). Without a video (playhead null) only the focused item is shown, as a
 * still. The focused item comes last so it draws on top.
 */
export function visibleMarks<T extends Markable>(
  items: T[],
  focus: T | null,
  playhead: number | null,
  windowS = MARK_WINDOW_S,
): T[] {
  if (playhead == null) return focus && boxed(focus) ? [focus] : [];
  const near = items.filter((item) => boxed(item) && Math.abs(markSeconds(item.t) - playhead) <= windowS);
  return [...near.filter((item) => item !== focus), ...near.filter((item) => item === focus)];
}

const THREAT_NAME: Record<string, string> = { firearm: "Firearm", knife: "Knife", other_weapon: "Weapon" };

/** Weapons Gemini saw, as boxes for the same overlay (drawn first, so a threat is the flagged mark). */
export function threatMarks(threats: { type: string; t: string; box_2d: number[]; pointed_at_person: boolean }[] | undefined) {
  return (threats ?? []).map((threat) => ({
    t: threat.t,
    description: `${THREAT_NAME[threat.type] ?? "Weapon"}${threat.pointed_at_person ? " (pointed)" : ""}`,
    scanned: false,
    box_2d: threat.box_2d,
  }));
}
