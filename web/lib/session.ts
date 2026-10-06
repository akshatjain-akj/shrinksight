export type Role = "manager" | "user";

export interface Session {
  email: string;
  role: Role;
  token: string;
  // Unix seconds; older stored sessions may not have it
  exp?: number;
}

const KEY = "shrinksight-session";
const EMAIL_KEY = "shrinksight-remembered-email";
const EVENT = "shrinksight-session";

function expired(session: Session): boolean {
  return typeof session.exp === "number" && session.exp * 1000 <= Date.now();
}

function parse(raw: string | null): Session | null {
  if (!raw) return null;
  try {
    const body = JSON.parse(raw) as Session;
    if (!body.email || (body.role !== "manager" && body.role !== "user") || !body.token) return null;
    return body;
  } catch {
    return null;
  }
}

// useSyncExternalStore requires the same object until the store actually changes.
let snapshotRaw: string | null | undefined;
let snapshot: Session | null = null;

export function readSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY);
  if (raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshot = parse(raw);
  }
  if (snapshot && expired(snapshot)) {
    // No event here: this runs inside useSyncExternalStore's getSnapshot.
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY);
    snapshotRaw = null;
    snapshot = null;
  }
  return snapshot;
}

/** Email from the last "Remember me" sign-in, used to prefill the login form. */
export function rememberedEmail(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(EMAIL_KEY) ?? "";
}

export function emptySession(): null {
  return null;
}

/** Returns false (and stores nothing) if the server sent a session this app can't use, e.g. an unknown role. */
export function saveSession(session: Session, remember: boolean): boolean {
  const raw = JSON.stringify(session);
  const usable = parse(raw);
  if (!usable || expired(usable)) return false;
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
  const store = remember ? localStorage : sessionStorage;
  store.setItem(KEY, raw);
  if (remember) localStorage.setItem(EMAIL_KEY, session.email);
  else localStorage.removeItem(EMAIL_KEY);
  window.dispatchEvent(new Event(EVENT));
  return true;
}

export function clearSession(): void {
  localStorage.removeItem(KEY);
  sessionStorage.removeItem(KEY);
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeSession(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function authHeader(): Record<string, string> {
  const session = readSession();
  return session ? { authorization: `Bearer ${session.token}` } : {};
}
