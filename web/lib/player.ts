/**
 * Sizes a video player to its clip: the box takes the clip's exact shape, as wide as the panel allows but never taller
 * than `maxVh` of the screen. Portrait clips get a narrower, centred player instead of black space beside them, and
 * overlays positioned in percent (Gemini's boxes, the Tier-1 drawing) line up because there is no letterboxing.
 */
export function fitPlayer(aspect: number | null | undefined, maxVh = 70): {
  aspectRatio: string;
  width: string;
  marginInline: string;
} {
  const ratio = aspect && Number.isFinite(aspect) && aspect > 0 ? Math.min(4, Math.max(0.25, aspect)) : 16 / 9;
  const widthVh = Math.round(maxVh * ratio * 100) / 100;
  return { aspectRatio: String(Math.round(ratio * 10000) / 10000), width: `min(100%, ${widthVh}vh)`, marginInline: "auto" };
}
