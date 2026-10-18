import type { SeenObject } from "./threat.ts";
import type { SeenPerson } from "./tracks.ts";

type Detection = { categories?: { categoryName?: string; score?: number }[]; boundingBox?: { originX: number; originY: number; width: number; height: number } };

/** MediaPipe object detections (pixel boxes) → labelled 0–1 boxes for the threat check. */
export function toSeenObjects(detections: Detection[] | undefined, width: number, height: number): SeenObject[] {
  if (!width || !height) return [];
  return (detections ?? []).flatMap((d) => {
    const label = d.categories?.[0]?.categoryName;
    const box = d.boundingBox;
    if (!label || !box) return [];
    return [{ label, x: box.originX / width, y: box.originY / height, w: box.width / width, h: box.height / height }];
  });
}

/** Every tracked person in this frame sees the same objects; the threat check pairs them with that person's wrists. */
export function withObjects(people: SeenPerson[], objects: SeenObject[]): SeenPerson[] {
  return objects.length ? people.map((p) => ({ ...p, sample: { ...p.sample, objects } })) : people;
}
