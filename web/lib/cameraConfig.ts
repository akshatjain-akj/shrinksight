import { polygonsFor, type Pt } from "./tier1/geometry";

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
}

const KEY = "shrinksight.camera-config";

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
