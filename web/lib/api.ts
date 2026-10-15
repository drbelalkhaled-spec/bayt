import { kvDel, kvDelPrefix, kvGet, kvSet } from "./store";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

let token: string | null = null;
let signOutHandler: (() => void) | null = null;

export const getToken = (): string | null => token;
export async function loadToken(): Promise<string | null> {
  token = (await kvGet<string>("token")) || null;
  return token;
}
export async function setToken(t: string): Promise<void> {
  token = t;
  await kvSet("token", t);
}
export async function clearToken(): Promise<void> {
  token = null;
  await kvDel("token");
}
/** Registered once by main; called when the server answers 401 to an authenticated request. */
export function onUnauthorized(fn: () => void): void {
  signOutHandler = fn;
}

// ---------------------------------------------------------------- network state
// "Offline" = the browser says so, or the last request died at the network layer.
let netDown = typeof navigator !== "undefined" && navigator.onLine === false;
const netHandlers = new Set<() => void>();

function setNet(down: boolean): void {
  if (down === netDown) return;
  netDown = down;
  for (const h of [...netHandlers]) {
    try {
      h();
    } catch (err) {
      console.error(err);
    }
  }
}
export const isOffline = (): boolean => netDown || (typeof navigator !== "undefined" && navigator.onLine === false);
/** Call when something proves the network works (e.g. the live socket opened). */
export const markOnline = (): void => setNet(false);
export function onNetworkChange(cb: () => void): () => void {
  netHandlers.add(cb);
  return () => netHandlers.delete(cb);
}
if (typeof window !== "undefined") {
  window.addEventListener("online", () => setNet(false)); // optimistic; the next failed request flips it back
  window.addEventListener("offline", () => setNet(true));
}

/** The outbox registers itself here (keeps api.ts free of an import cycle). */
export interface QueueHook {
  ready: Promise<void>;
  hasPending(): boolean;
  queueable(method: string, path: string, body: unknown): boolean;
  enqueue(method: string, path: string, body: unknown): void;
}
let queueHook: QueueHook | null = null;
export function setQueueHook(q: QueueHook): void {
  queueHook = q;
}
/** True for the error api() throws when a mutation was saved to the outbox instead of being sent. */
export const isQueued = (e: unknown): boolean => e instanceof ApiError && e.status === 0 && e.code === "queued";
export const isNetworkError = (e: unknown): boolean => e instanceof ApiError && e.status === 0 && e.code === "network";

const TIMEOUT_MS = 15000;

/** One authenticated JSON request. Throws ApiError(0, "network") when nothing came back (also on timeout). */
export async function apiRaw<T = unknown>(path: string, method: string, reqBody?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (reqBody !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(reqBody);
  }
  let res: Response;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    res = await fetch(path, { method, headers, body, signal: ctl.signal });
  } catch {
    setNet(true);
    throw new ApiError(0, "network");
  } finally {
    clearTimeout(timer);
  }
  setNet(false);
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    if (res.status === 401 && token) signOutHandler?.();
    const code = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : "http_" + res.status;
    throw new ApiError(res.status, code);
  }
  return data as T;
}

/** IDB key for GETs that are kept for offline use; null = never cached. Only the latest chat page, never before/after. */
function cacheKey(path: string): string | null {
  const [p, q = ""] = path.split("?");
  if (p === "/api/me" || p === "/api/items" || p === "/api/tasks") return "cache:" + path;
  if (p === "/api/messages") {
    const sp = new URLSearchParams(q);
    return sp.has("before") || sp.has("after") ? null : "cache:" + path;
  }
  return null;
}

/** Forget everything kept for offline use (call on sign-out). */
export async function clearReadCache(): Promise<void> {
  await kvDelPrefix("cache:").catch(() => undefined);
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = (opts.method || (opts.body !== undefined ? "POST" : "GET")).toUpperCase();

  if (method === "GET") {
    const key = cacheKey(path);
    if (key && typeof navigator !== "undefined" && navigator.onLine === false) {
      const hit = await kvGet<T>(key).catch(() => undefined);
      if (hit !== undefined) return hit;
    }
    try {
      const data = await apiRaw<T>(path, method);
      if (key) void kvSet(key, data).catch(() => undefined);
      return data;
    } catch (e) {
      if (key && isNetworkError(e)) {
        const hit = await kvGet<T>(key).catch(() => undefined);
        if (hit !== undefined) return hit;
      }
      throw e;
    }
  }

  const q = queueHook && queueHook.queueable(method, path, opts.body) ? queueHook : null;
  if (q) {
    await q.ready;
    // Keep order: while older changes are waiting, newer ones line up behind them.
    if (q.hasPending() || navigator.onLine === false) {
      q.enqueue(method, path, opts.body);
      throw new ApiError(0, "queued");
    }
  }
  try {
    return await apiRaw<T>(path, method, opts.body);
  } catch (e) {
    if (q && isNetworkError(e)) {
      q.enqueue(method, path, opts.body);
      throw new ApiError(0, "queued");
    }
    throw e;
  }
}

export function wsUrl(path: string): string {
  return (location.protocol === "https:" ? "wss://" : "ws://") + location.host + path;
}
