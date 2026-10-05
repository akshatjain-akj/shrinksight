/**
 * Face privacy helpers. The face detector we ship (BlazeFace short range) is built for selfie distance, so on a
 * CCTV-style shot it often misses small, far-away faces. The pose model tracks whole bodies at any distance, so we
 * also derive a head box from its face landmarks (nose, eyes, ears, mouth) and blur the union of both.
 */

export interface PixelBox {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

export interface PoseLandmark {
  x: number;
  y: number;
  visibility?: number;
}

const HEAD_POINTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const MIN_VISIBILITY = 0.3;

const visible = (p: PoseLandmark | undefined): p is PoseLandmark => Boolean(p) && (p!.visibility ?? 1) >= MIN_VISIBILITY;

/** Head box in pixels for one pose (landmarks normalised 0–1), or null if the head isn't visible. */
export function headBoxFromPose(pose: PoseLandmark[], width: number, height: number): PixelBox | null {
  const points = HEAD_POINTS.map((i) => pose[i]).filter(visible);
  if (points.length < 2) return null;
  const xs = points.map((p) => p.x * width);
  const ys = points.map((p) => p.y * height);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // Scale from the shoulders when we can: face landmarks alone underestimate head size side-on.
  const [ls, rs] = [pose[11], pose[12]];
  const shoulders = visible(ls) && visible(rs) ? Math.hypot((ls.x - rs.x) * width, (ls.y - rs.y) * height) * 0.55 : 0;
  const size = Math.max(maxX - minX, maxY - minY, shoulders, 14) * 1.7;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { originX: cx - size / 2, originY: cy - size * 0.6, width: size, height: size * 1.25 };
}

/** Face-detector boxes plus pose-derived head boxes; overlapping duplicates don't matter for blurring. */
export function privacyBoxes(faces: PixelBox[], poses: PoseLandmark[][], width: number, height: number): PixelBox[] {
  const heads = poses.map((pose) => headBoxFromPose(pose, width, height)).filter((b): b is PixelBox => b !== null);
  return [...faces, ...heads];
}
