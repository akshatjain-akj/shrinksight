import { appCheckToken } from "./firebase";
import type { Incident, InvestigationEvent, ReceiptLine, Rule, RuleSpec, Store, Transaction } from "./types";

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
};

export interface MarkedStill {
  label: "before" | "reach" | "hold" | "after";
  blob: Blob;
}

export interface InvestigateMeta {
  camera_id: string;
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

/** Uploads a clip and calls onEvent for each Server-Sent Event until the stream ends. */
export async function investigateStream(
  clip: Blob,
  meta: InvestigateMeta,
  onEvent: (event: InvestigationEvent) => void,
  signal?: AbortSignal,
  stills: MarkedStill[] = [],
): Promise<void> {
  const token = await appCheckToken();
  const headers: Record<string, string> = {
    "x-shrinksight-meta": base64url(JSON.stringify(meta)),
    ...(token ? { "x-firebase-appcheck": token } : {}),
  };
  let body: BodyInit = clip;
  if (stills.length) {
    const form = new FormData();
    form.append("clip", clip, "clip.webm");
    for (const still of stills) form.append("still", still.blob, `${still.label}.jpg`);
    body = form;
  } else {
    headers["content-type"] = clip.type || "video/mp4";
  }
  const res = await fetch(`${STREAM_BASE}/api/investigate`, {
    method: "POST",
    body,
    signal,
    headers,
  });
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new ApiError(0, "Streaming isn't supported by this browser.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
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
  }
}
