import { appCheckToken } from "./firebase";
import type {
  AskAnswer,
  CameraLayout,
  Incident,
  InvestigationEvent,
  ReceiptLine,
  Rule,
  RuleSpec,
  Store,
  Transaction,
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
      ...(token ? { "x-firebase-appcheck": token } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<T>;
}

export const api = {
  store: () => request<Store>("/api/store"),
  clip: (cameraId: string) =>
    request<{ camera_id: string; url: string; expires_in: number }>(`/api/clips/${encodeURIComponent(cameraId)}`),
  transactions: (laneId: string) => request<Transaction[]>(`/api/transactions?lane_id=${encodeURIComponent(laneId)}`),
  incidents: () => request<Incident[]>("/api/incidents"),
  incident: (id: string) => request<Incident>(`/api/incidents/${encodeURIComponent(id)}`),
  review: (id: string, decision: "confirm" | "dismiss") =>
    request<Incident>(`/api/incidents/${encodeURIComponent(id)}/review`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
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
      headers: { "content-type": frame.type || "image/jpeg", ...(token ? { "x-firebase-appcheck": token } : {}) },
    });
    if (!res.ok) throw await errorFrom(res);
    return res.json() as Promise<{ camera_id: string; zones: ZoneSuggestion[]; cached: boolean }>;
  },
};

export interface MarkedStill {
  label: "before" | "reach" | "hold" | "after" | "pickup_start" | "scanner_mid" | "bagging_end";
  blob: Blob;
}

export interface InvestigateMeta {
  camera_id: string;
  /** Zones for this clip. Omit to use the camera's saved layout; [] sends none. */
  zones?: ZoneHint[];
  transaction_id?: string;
  receipt?: ReceiptLine[];
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
