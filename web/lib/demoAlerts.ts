/** Demo mode rules that don't need the browser: which incidents to list, and when a looping tile alerts. */

/** Hides demo-clip incidents unless demo mode is on. */
export function forDemoMode<T extends { source: string }>(items: T[], on: boolean): T[] {
  return on ? items : items.filter((item) => item.source !== "demo");
}

/** A demo clip that reached its analysed moment on the Monitor this browser session. */
export interface DemoSighting {
  clip: string;
  incidentId: string;
  verdict: string;
  /** When it appeared on the wall (ms since epoch). */
  at: number;
}

/** Verdicts that raise an alert. A benign clip shows its badge on the tile but is never "recorded". */
export const ALERTING = new Set(["SCAN_AVOIDANCE", "CONCEALMENT", "RULE_BREACH", "INCONCLUSIVE"]);

/** True when a tile playing this clip should alert now: not yet seen this session, and past its analysed moment. */
export function shouldAlert(sightings: DemoSighting[], clip: string, alertAt: number, seconds: number): boolean {
  return seconds + 0.05 >= alertAt && !sightings.some((s) => s.clip === clip);
}

/** Newest first, one per clip: looping, or two tiles sharing a clip, never adds a second entry. */
export function addSighting(sightings: DemoSighting[], next: DemoSighting): DemoSighting[] {
  if (sightings.some((s) => s.clip === next.clip)) return sightings;
  return [next, ...sightings];
}

/**
 * The incident list in demo mode: real incidents as they are, plus only the demo incidents the wall has flagged this
 * session (alerting verdicts), newest sighting first and dated when they appeared. `seenAt` maps incident id → time.
 */
export function withSightings<T extends { id: string; source: string }>(
  incidents: T[],
  sightings: DemoSighting[],
): { items: T[]; seenAt: Map<string, number> } {
  const seen = sightings.filter((s) => ALERTING.has(s.verdict));
  const seenAt = new Map(seen.map((s) => [s.incidentId, s.at]));
  const order = new Map(seen.map((s, index) => [s.incidentId, index]));
  const items = incidents
    .filter((incident) => incident.source !== "demo" || seenAt.has(incident.id))
    .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  return { items, seenAt };
}

/** The newest-incidents list plus the demo clips' results (often older than that window), each incident once. */
export function withDemoIncidents<T extends { id: string }>(live: T[], demo: T[]): T[] {
  const ids = new Set(live.map((incident) => incident.id));
  return [...live, ...demo.filter((incident) => !ids.has(incident.id))];
}
