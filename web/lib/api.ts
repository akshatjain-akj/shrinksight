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
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<T>;
}

export const api = {
  store: () => request<Store>("/api/store"),
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

export interface InvestigateMeta {
  camera_id: string;
  transaction_id?: string;
  receipt?: ReceiptLine[];
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
): Promise<void> {
  const res = await fetch(`${STREAM_BASE}/api/investigate`, {
    method: "POST",
    body: clip,
    signal,
    headers: {
      "content-type": clip.type || "video/mp4",
      "x-shrinksight-meta": base64url(JSON.stringify(meta)),
    },
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
