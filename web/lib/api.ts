import { appCheckToken } from "./firebase";
import { authHeader, clearSession, readSession, type Session } from "./session";
import type {
  AskAnswer,
  DemoClip,
  CameraLayout,
  Camera,
  CameraPrefs,
  ConfirmReason,
  DismissReason,
  EdgeConfig,
  InventoryItem,
  Incident,
  InvestigationEvent,
  ReceiptLine,
  Rule,
  RuleSpec,
  Tier1Measure,
  RosterPerson,
  Store,
  TokenUsage,
  Transaction,
  Zone,
  ZoneHint,
  ZoneSuggestion,
} from "./types";

// Same-origin in production (Firebase Hosting rewrites /api/** to Cloud Run).
// Local dev: NEXT_PUBLIC_API_BASE=http://localhost:8080
const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
// Optional direct Cloud Run URL for the streaming endpoint, used only if Hosting buffers SSE.
const STREAM_BASE = process.env.NEXT_PUBLIC_STREAM_BASE || API_BASE;

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  // Token expired or revoked: drop it so AppShell sends the user back to /login.
  if (res.status === 401 && readSession()) clearSession();
  let message = `Request failed (HTTP ${res.status})`;
  try {
    const body = await res.json();
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail)) message = body.detail.map((d: { msg?: string }) => d.msg).join("; ");
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, message);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await appCheckToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...authHeader(),
      ...(token ? { "x-firebase-appcheck": token } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<T>;
}

export async function openSession(email: string, password: string, remember = false): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, remember }),
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<Session>;
}

/** "Enter the demo store": the server signs in its demo manager; no password ever reaches the browser. */
/**
 * Saves the original clip as a demo clip (demo/<kind>/ in the bucket), with its receipt, zones and expected verdict.
 * Returns the object name, used to analyse it as that clip's one result.
 */
export async function saveDemoClip(
  clip: Blob,
  filename: string,
  cameraId: string,
  settings: { receipt?: ReceiptLine[]; zones?: unknown[]; expected?: string },
): Promise<{ object: string }> {
  const form = new FormData();
  form.append("clip", clip, filename);
  form.append("camera_id", cameraId);
  if (settings.receipt?.length) form.append("receipt", JSON.stringify(settings.receipt));
  if (settings.zones?.length) form.append("zones", JSON.stringify(settings.zones));
  if (settings.expected) form.append("expected", settings.expected);
  const token = await appCheckToken();
  const res = await fetch(`${API_BASE}/api/demo/clips`, {
    method: "POST",
    body: form,
    headers: { ...authHeader(), ...(token ? { "x-firebase-appcheck": token } : {}) },
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<{ object: string }>;
}

export async function openDemoSession(): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/session/demo`, { method: "POST" });
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<Session>;
}

/** Whether the one-click demo login is switched on (from the cheap health probe). */
export async function demoLoginOn(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/healthz`);
    if (!res.ok) return true;
    const body = (await res.json()) as { demo_login?: boolean };
    return body.demo_login !== false;
  } catch {
    return true;
  }
}

export async function openGoogleSession(idToken: string, remember = false): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/session/google`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: idToken, remember }),
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<Session>;
}

export const api = {
  store: () => request<Store>("/api/store"),
  createCamera: (body: { name: string; kind: "checkout" | "floor"; lane_id?: string }) =>
    request<{ camera: Camera; zones: Zone[] }>("/api/cameras", { method: "POST", body: JSON.stringify(body) }),
  deleteCamera: (cameraId: string) =>
    request<{ deleted: string }>(`/api/cameras/${encodeURIComponent(cameraId)}`, { method: "DELETE" }),
  createZone: (body: { name: string; camera_id: string; kind: Zone["kind"]; high_value: boolean }) =>
    request<Zone>("/api/zones", { method: "POST", body: JSON.stringify(body) }),
  deleteZone: (zoneId: string) =>
    request<{ deleted: string }>(`/api/zones/${encodeURIComponent(zoneId)}`, { method: "DELETE" }),
  cameraMemory: (cameraId: string) =>
    request<{ camera_id: string; decisions: number; used_per_clip: number }>(
      `/api/cameras/${encodeURIComponent(cameraId)}/memory`,
    ),
  clearCameraMemory: (cameraId: string) =>
    request<{ camera_id: string; cleared: number }>(`/api/cameras/${encodeURIComponent(cameraId)}/memory`, {
      method: "DELETE",
    }),
  cameraPrefs: (cameraId: string) =>
    request<CameraPrefs>(`/api/cameras/${encodeURIComponent(cameraId)}/prefs`),
  saveCameraPrefs: (cameraId: string, body: Omit<CameraPrefs, "camera_id">) =>
    request<CameraPrefs>(`/api/cameras/${encodeURIComponent(cameraId)}/prefs`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  users: () => request<RosterPerson[]>("/api/users"),
  setUserRole: (userId: string, role: RosterPerson["role"]) =>
    request<RosterPerson>(`/api/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  clip: (cameraId: string) =>
    request<{ camera_id: string; url: string; expires_in: number }>(`/api/clips/${encodeURIComponent(cameraId)}`),
  demoClips: () => request<{ clips: DemoClip[]; uploads: boolean }>("/api/demo/clips"),
  demoIncidents: () => request<Incident[]>("/api/demo/incidents"),
  demoClipUrl: (object: string) =>
    request<{ object: string; url: string; expires_in: number }>(`/api/demo/url?object=${encodeURIComponent(object)}`),
  deleteDemoClip: (object: string) =>
    request<{ deleted: string }>(`/api/demo/clips?object=${encodeURIComponent(object)}`, { method: "DELETE" }),
  setCameraDemoClip: (cameraId: string, object: string | null) =>
    request<Camera>(`/api/cameras/${encodeURIComponent(cameraId)}/demo-clip`, {
      method: "PUT",
      body: JSON.stringify({ object }),
    }),
  transactions: (laneId: string) => request<Transaction[]>(`/api/transactions?lane_id=${encodeURIComponent(laneId)}`),
  incidents: () => request<Incident[]>("/api/incidents"),
  incident: (id: string) => request<Incident>(`/api/incidents/${encodeURIComponent(id)}`),
  review: (
    id: string,
    decision: "confirm" | "dismiss",
    reason: DismissReason | ConfirmReason | null = null,
    note = "",
    remember = true,
  ) =>
    request<Incident>(`/api/incidents/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: JSON.stringify({ decision, reason, note, remember }),
    }),
  edgeConfig: (cameraId: string) => request<EdgeConfig>(`/api/edge-config/${encodeURIComponent(cameraId)}`),
  undoEdgeConfig: (cameraId: string) =>
    request<EdgeConfig>(`/api/edge-config/${encodeURIComponent(cameraId)}/undo`, { method: "POST" }),
  /** When each camera's scanner photo was saved, keyed by camera id. */
  scannerPhotos: () => request<Record<string, string>>("/api/scanner-photos"),
  scannerPhotoUrl: (cameraId: string, version: string) =>
    `${API_BASE}/api/cameras/${encodeURIComponent(cameraId)}/scanner-photo?v=${encodeURIComponent(version)}`,
  saveScannerPhoto: async (cameraId: string, photo: Blob) => {
    const token = await appCheckToken();
    const res = await fetch(`${API_BASE}/api/cameras/${encodeURIComponent(cameraId)}/scanner-photo`, {
      method: "PUT",
      body: photo,
      headers: { "content-type": "image/jpeg", ...authHeader(), ...(token ? { "x-firebase-appcheck": token } : {}) },
    });
    if (!res.ok) throw await errorFrom(res);
    return res.json() as Promise<{ camera_id: string; updated_at: string }>;
  },
  deleteScannerPhoto: (cameraId: string) =>
    request<{ deleted: boolean }>(`/api/cameras/${encodeURIComponent(cameraId)}/scanner-photo`, { method: "DELETE" }),
  rules: () => request<Rule[]>("/api/rules"),
  compileRule: (text: string) =>
    request<{ spec: RuleSpec; problems: string[]; cached: boolean }>("/api/rules/compile", {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  createRule: (source_text: string, spec: RuleSpec) =>
    request<Rule>("/api/rules", { method: "POST", body: JSON.stringify({ source_text, spec }) }),
  setRuleEnabled: (id: string, enabled: boolean) =>
    request<Rule>(`/api/rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
  ask: (incidentId: string, question: string) =>
    request<AskAnswer>(`/api/incidents/${encodeURIComponent(incidentId)}/ask`, {
      method: "POST",
      body: JSON.stringify({ question }),
    }),
  /** One image-only Gemini call: lists every object in the item pile from up to three views. */
  inventory: async (cameraId: string, views: { label: "pile" | "left" | "right"; blob: Blob }[]) => {
    const token = await appCheckToken();
    const form = new FormData();
    for (const view of views) form.append("view", view.blob, `${view.label}.jpg`);
    const res = await fetch(`${API_BASE}/api/inventory`, {
      method: "POST",
      body: form,
      headers: {
        "x-shrinksight-meta": base64url(JSON.stringify({ camera_id: cameraId })),
        ...authHeader(),
        ...(token ? { "x-firebase-appcheck": token } : {}),
      },
    });
    if (!res.ok) throw await errorFrom(res);
    return res.json() as Promise<{ items: InventoryItem[]; model: string; cached: boolean; usage: TokenUsage | null }>;
  },
  layouts: () => request<Record<string, CameraLayout>>("/api/layouts"),
  saveLayout: (cameraId: string, zones: ZoneHint[]) =>
    request<CameraLayout>(`/api/layouts/${encodeURIComponent(cameraId)}`, {
      method: "PUT",
      body: JSON.stringify({ zones }),
    }),
  /** Sends one JPEG frame; Gemini suggests where each of this camera's zones is. */
  suggestZones: async (cameraId: string, frame: Blob) => {
    const token = await appCheckToken();
    const res = await fetch(`${API_BASE}/api/layouts/${encodeURIComponent(cameraId)}/suggest`, {
      method: "POST",
      body: frame,
      headers: {
        "content-type": frame.type || "image/jpeg",
        ...authHeader(),
        ...(token ? { "x-firebase-appcheck": token } : {}),
      },
    });
    if (!res.ok) throw await errorFrom(res);
    return res.json() as Promise<{ camera_id: string; zones: ZoneSuggestion[]; cached: boolean }>;
  },
};

export interface MarkedStill {
  label:
    | "before"
    | "reach"
    | "hold"
    | "after"
    | "pickup_start"
    | "scanner_mid"
    | "bagging_end"
    | "hand_reach"
    | "hand_hold"
    | `hand_${1 | 2 | 3 | 4}`
    | `trip_${1 | 2 | 3 | 4 | 5 | 6}`
    | "scanner_ref";
  blob: Blob;
}

export interface InvestigateMeta {
  camera_id: string;
  /** Zones for this clip. Omit to use the camera's saved layout; [] sends none. */
  zones?: ZoneHint[];
  clip_seconds?: number;
  /** The confirmed item-pile list; Gemini tracks each # item. */
  inventory?: InventoryItem[];
  /** The part of the frame the video was cropped to, [ymin, xmin, ymax, xmax] 0–1000. */
  video_crop?: number[];
  transaction_id?: string;
  receipt?: ReceiptLine[];
  /** "edge" when the Live edge gate sent the clip; it then counts towards the camera's auto-tuning. */
  origin?: "edge" | "upload";
  /** "none" skips the camera's saved scanner photo for this clip. */
  scanner_photo?: "saved" | "none";
  inventory_usage?: TokenUsage;
  /** Analysing a demo clip: the incident becomes that clip's one result. */
  demo_clip?: string;
  /** Set when Investigate screened the clip with Tier-1 first ("cleared" = sent anyway). */
  tier1_screen?: "flagged" | "cleared";
  /** Investigate's Tier-1 hand measurements, when staff send the clip with them. */
  tier1_measure?: Tier1Measure;
  tier1_events?: {
    t: string;
    kind: string;
    score: number;
    detail: string;
    camera_id?: string;
    trigger?: "hot_score" | "lane_leave";
    confidence?: number;
    box?: [number, number, number, number];
  }[];
}

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function errorFromText(status: number, text: string): ApiError {
  let message = status ? `Request failed (HTTP ${status})` : "Network error while sending the clip.";
  try {
    const body = JSON.parse(text);
    if (typeof body.detail === "string") message = body.detail;
    else if (Array.isArray(body.detail)) message = body.detail.map((d: { msg?: string }) => d.msg).join("; ");
  } catch {
    if (status === 413) message = "The clip is too large to upload.";
  }
  return new ApiError(status, message);
}

/**
 * Uploads a clip and calls onEvent for each Server-Sent Event until the stream ends.
 * Uses XMLHttpRequest so the upload can report progress (fetch can't) while the response still streams.
 */
export async function investigateStream(
  clip: Blob,
  meta: InvestigateMeta,
  onEvent: (event: InvestigationEvent) => void,
  signal?: AbortSignal,
  stills: MarkedStill[] = [],
  onUpload?: (fraction: number) => void,
): Promise<void> {
  const token = await appCheckToken();
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `${STREAM_BASE}/api/investigate`);
  xhr.setRequestHeader("x-shrinksight-meta", base64url(JSON.stringify(meta)));
  const sessionHeader = authHeader().authorization;
  if (sessionHeader) xhr.setRequestHeader("authorization", sessionHeader);
  if (token) xhr.setRequestHeader("x-firebase-appcheck", token);
  let body: XMLHttpRequestBodyInit = clip;
  if (stills.length) {
    const form = new FormData();
    form.append("clip", clip, "clip.webm");
    for (const still of stills) form.append("still", still.blob, `${still.label}.jpg`);
    body = form; // the browser sets the multipart boundary
  } else {
    xhr.setRequestHeader("content-type", clip.type || "video/mp4");
  }

  return new Promise<void>((resolve, reject) => {
    let seen = 0;
    let buffer = "";
    const pump = () => {
      buffer += xhr.responseText.slice(seen);
      seen = xhr.responseText.length;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n");
        if (data) onEvent(JSON.parse(data) as InvestigationEvent);
      }
    };
    xhr.upload.onprogress = (e) => e.lengthComputable && onUpload?.(e.loaded / e.total);
    xhr.upload.onload = () => onUpload?.(1);
    xhr.onprogress = () => xhr.status === 200 && pump();
    xhr.onload = () => {
      if (xhr.status === 200) {
        pump();
        resolve();
      } else {
        reject(errorFromText(xhr.status, xhr.responseText));
      }
    };
    xhr.onerror = () =>
      reject(new ApiError(0, "The connection dropped while sending the clip. Check your network and try again."));
    signal?.addEventListener("abort", () => {
      xhr.abort();
      reject(new DOMException("Aborted", "AbortError"));
    });
    xhr.send(body);
  });
}
