/** Demo mode rules that don't need the browser: which incidents to list, and when a looping tile alerts. */

/** Hides demo-clip incidents unless demo mode is on. */
export function forDemoMode<T extends { source: string }>(items: T[], on: boolean): T[] {
  return on ? items : items.filter((item) => item.source !== "demo");
}

/**
 * Each demo clip alerts once per page session: the first time its tile plays past the analysed moment. Later loops,
 * and other tiles playing the same clip, stay quiet.
 */
export class AlertOnce {
  private readonly seen = new Set<string>();

  /** True exactly once per clip, when playback reaches `alertAt` seconds. */
  check(clip: string, alertAt: number, seconds: number): boolean {
    if (this.seen.has(clip) || seconds + 0.05 < alertAt) return false;
    this.seen.add(clip);
    return true;
  }

  has(clip: string): boolean {
    return this.seen.has(clip);
  }
}
