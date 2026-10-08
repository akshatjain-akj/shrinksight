/**
 * Clips kept on this device for replay (IndexedDB), never on our servers.
 *
 * When Gemini files an incident, the clip that produced it is kept here under the incident id for 24 hours, so the
 * incident page and Playback can replay it with Gemini's boxes. Investigate keeps the original file (Gemini's boxes
 * are mapped back to the full picture, so they line up with it); Live edge keeps the face-blurred clip it sent.
 * Oldest clips go first past the size or count limit; signing out deletes them all.
 */

export const KEEP_MS = 24 * 60 * 60 * 1000;
export const MAX_BYTES = 300 * 1024 * 1024;
export const MAX_COUNT = 30;

const DB = "shrinksight";
const STORE = "clips";
const SETTING = "shrinksight.keepClips";

export interface ClipEntry {
  incidentId: string;
  savedAt: number;
  size: number;
}

export interface LocalClip extends ClipEntry {
  blob: Blob;
  cameraId: string;
  source: "investigate" | "edge";
}

/**
 * Which entries to delete: expired ones, then the oldest until the rest fit the count and size limits. `incoming`
 * is room to make for a clip about to be saved.
 */
export function planEviction(
  entries: ClipEntry[],
  now: number,
  incoming = 0,
  limits = { keepMs: KEEP_MS, maxBytes: MAX_BYTES, maxCount: MAX_COUNT },
): string[] {
  const doomed = new Set(entries.filter((e) => now - e.savedAt >= limits.keepMs).map((e) => e.incidentId));
  const kept = entries.filter((e) => !doomed.has(e.incidentId)).sort((a, b) => a.savedAt - b.savedAt);
  let bytes = kept.reduce((sum, e) => sum + e.size, 0) + incoming;
  let count = kept.length + (incoming ? 1 : 0);
  for (const entry of kept) {
    if (bytes <= limits.maxBytes && count <= limits.maxCount) break;
    doomed.add(entry.incidentId);
    bytes -= entry.size;
    count -= 1;
  }
  return [...doomed];
}

export function expiresAt(entry: ClipEntry): number {
  return entry.savedAt + KEEP_MS;
}

/** "Keep my clips on this device for 24 h" (on unless switched off). */
export function keepClipsOn(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(SETTING) !== "off";
}

export function setKeepClips(on: boolean): void {
  localStorage.setItem(SETTING, on ? "on" : "off");
  if (!on) void clearLocalClips();
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser can't keep clips"));
      return;
    }
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "incidentId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Couldn't open device storage"));
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request ? request.result : (undefined as T));
      tx.onerror = () => reject(tx.error ?? new Error("Device storage failed"));
      tx.onabort = () => reject(tx.error ?? new Error("Device storage is full"));
    });
  } finally {
    db.close();
  }
}

async function entries(): Promise<LocalClip[]> {
  return run<LocalClip[]>("readonly", (store) => store.getAll() as IDBRequest<LocalClip[]>);
}

async function remove(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await run("readwrite", (store) => {
    for (const id of ids) store.delete(id);
  });
}

/** Deletes expired clips and, with `incoming`, makes room for one more. Never throws. */
export async function purgeLocalClips(incoming = 0): Promise<void> {
  try {
    const all = await entries();
    await remove(planEviction(all, Date.now(), incoming));
  } catch {
    /* no storage (some private windows): nothing to purge */
  }
}

/**
 * Keeps this clip for the incident. Returns when it will be deleted, or null if it wasn't kept (switched off, too
 * big, or the browser refused, as some private windows do).
 */
export async function saveLocalClip(
  incidentId: string,
  blob: Blob,
  cameraId: string,
  source: LocalClip["source"],
): Promise<number | null> {
  if (!keepClipsOn() || !blob.size || blob.size > MAX_BYTES) return null;
  try {
    await purgeLocalClips(blob.size);
    const clip: LocalClip = { incidentId, blob, cameraId, source, savedAt: Date.now(), size: blob.size };
    await run("readwrite", (store) => store.put(clip));
    return expiresAt(clip);
  } catch {
    return null;
  }
}

/** The kept clip for an incident, or null (none, expired, or no storage). */
export async function getLocalClip(incidentId: string): Promise<LocalClip | null> {
  try {
    const clip = await run<LocalClip | undefined>("readonly", (store) => store.get(incidentId) as IDBRequest<LocalClip | undefined>);
    if (!clip || Date.now() >= expiresAt(clip)) return null;
    return clip;
  } catch {
    return null;
  }
}

/** Count and total size of kept clips, for the profile page. */
export async function localClipStats(): Promise<{ count: number; bytes: number }> {
  try {
    const now = Date.now();
    const live = (await entries()).filter((clip) => now < expiresAt(clip));
    return { count: live.length, bytes: live.reduce((sum, clip) => sum + clip.size, 0) };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

export async function clearLocalClips(): Promise<void> {
  try {
    await run("readwrite", (store) => store.clear());
  } catch {
    /* nothing kept */
  }
}
