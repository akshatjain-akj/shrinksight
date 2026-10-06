import { api } from "./api";
import { polygonsFor, type Pt, type ZoneShape } from "./tier1/geometry";
import { shapesToHints } from "./tier1/zones";
import type { CameraLayout } from "./types";

export interface DetectionSwitches {
  person: boolean;
  concealment: boolean;
  loitering: boolean;
  loiterSeconds: number;
  shelfReach: boolean;
  healthHazard: boolean;
}

export interface SavedCamera {
  detection: DetectionSwitches;
  polygons: Record<string, Pt[]>;
  /** What each zone looks like, e.g. "white paper square". Sent to Gemini with the zone. */
  descriptions?: Record<string, string>;
}

const KEY = "shrinksight.camera-config";

/** NEXT_PUBLIC_SAVE_TO_FIRESTORE=false keeps detection and zone shapes on this browser. Unset means on. */
export function cloudSyncEnabled(): boolean {
  const flag = process.env.NEXT_PUBLIC_SAVE_TO_FIRESTORE;
  if (flag == null || flag === "") return true;
  return !["0", "false", "off", "no"].includes(flag.toLowerCase());
}

export const DEFAULT_DETECTION: DetectionSwitches = {
  person: true,
  concealment: true,
  loitering: true,
  loiterSeconds: 30,
  shelfReach: true,
  healthHazard: true,
};

export function loadCameraConfigs(): Record<string, SavedCamera> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, SavedCamera>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveCameraConfig(cameraId: string, config: SavedCamera): void {
  const all = loadCameraConfigs();
  all[cameraId] = config;
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function polygonsForCamera(
  cameraId: string,
  zones: { id: string; name: string; kind: string }[],
) {
  return polygonsFor(zones, loadCameraConfigs()[cameraId]?.polygons);
}

/** True once someone has marked zones for this camera (here or, via sync, on any device). */
export function hasSavedLayout(cameraId: string): boolean {
  return Object.keys(loadCameraConfigs()[cameraId]?.polygons ?? {}).length > 0;
}

/** Zones someone actually marked for this camera (others are only placeholder presets). */
export function savedZoneIds(cameraId: string): string[] {
  return Object.keys(loadCameraConfigs()[cameraId]?.polygons ?? {});
}

export function savedDescriptions(cameraId: string): Record<string, string> {
  return { ...(loadCameraConfigs()[cameraId]?.descriptions ?? {}) };
}

/** The server copy is the source of truth; this browser keeps a cache for Live edge and the scans. */
export function applyServerLayouts(layouts: Record<string, CameraLayout>): void {
  if (typeof window === "undefined") return;
  const all = loadCameraConfigs();
  for (const [cameraId, layout] of Object.entries(layouts)) {
    const current = all[cameraId] ?? { detection: DEFAULT_DETECTION, polygons: {} };
    all[cameraId] = {
      ...current,
      polygons: Object.fromEntries(layout.zones.map((zone) => [zone.zone_id, zone.polygon])),
      descriptions: Object.fromEntries(layout.zones.map((zone) => [zone.zone_id, zone.description])),
    };
  }
  localStorage.setItem(KEY, JSON.stringify(all));
}

let synced: Promise<void> | null = null;

/** Pulls every camera's saved layout once per page load. Failures are ignored (presets still work). */
export function syncLayoutsFromServer(force = false): Promise<void> {
  if (!cloudSyncEnabled()) {
    synced = Promise.resolve();
    return synced;
  }
  if (!synced || force) {
    synced = api
      .layouts()
      .then(applyServerLayouts)
      .catch(() => {
        synced = null;
      });
  }
  return synced;
}

/** Saves a camera's zones for everyone (server) and in this browser's cache. */
export async function saveLayoutForEveryone(
  cameraId: string,
  shapes: ZoneShape[],
  descriptions: Record<string, string>,
): Promise<void> {
  const layout = await api.saveLayout(cameraId, shapesToHints(shapes, descriptions));
  applyServerLayouts({ [cameraId]: layout });
}
