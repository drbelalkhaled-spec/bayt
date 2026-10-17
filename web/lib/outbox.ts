// Offline outbox: small user actions that failed at the network layer are kept in IndexedDB
// (kv key "outbox") and replayed in order once the connection is back. The server accepts a
// client-generated id for new items/messages, so a replay after a lost response cannot duplicate.
import { ApiError, apiRaw, getToken, isOffline, onNetworkChange, setQueueHook } from "./api";
import { kvDel, kvGet, kvSet } from "./store";
import { toast } from "./ui";

export { isQueued } from "./api";

export interface OutboxEntry {
  id: string;
  method: string;
  path: string;
  body: unknown;
  at: number;
}

const KEY = "outbox";
/** How often waiting changes are retried while the server cannot be reached (the browser may still say "online"). */
const RETRY_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ITEM = /^\/api\/items\/([^/?]+)$/;
const TASK = /^\/api\/tasks\/([^/?]+)$/;

let queue: OutboxEntry[] = [];
let syncing = false;
let inflight: string | null = null;
let flushing: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let saveChain: Promise<unknown> = Promise.resolve();
let syncedHandler: (() => void) | null = null;
const handlers = new Set<() => void>();

const bodyOf = (b: unknown): Record<string, unknown> => (b && typeof b === "object" ? (b as Record<string, unknown>) : {});
const isUuid = (v: unknown): boolean => typeof v === "string" && UUID.test(v);

/** Which mutations may be queued (and so must be safe to replay late and in order). */
export function queueable(method: string, path: string, body: unknown): boolean {
  const b = bodyOf(body);
  if (method === "POST" && path === "/api/items") return isUuid(b.id);
  if (method === "PATCH" && ITEM.test(path)) return true;
  if (method === "DELETE" && ITEM.test(path)) return true;
  if (method === "PATCH" && TASK.test(path)) {
    const keys = Object.keys(b);
    return keys.length === 1 && ((keys[0] === "done" && typeof b.done === "boolean") || (keys[0] === "seen" && b.seen === true));
  }
  if (method === "POST" && path === "/api/messages") return (b.kind === undefined || b.kind === "text") && isUuid(b.id);
  if (method === "POST" && path === "/api/messages/read") return true;
  return false;
}

/** The item/task/message id an entry is about (null for read receipts). */
function targetId(e: OutboxEntry): string | null {
  if (e.method === "POST") return e.path === "/api/items" || e.path === "/api/messages" ? String(bodyOf(e.body).id ?? "") || null : null;
  const m = ITEM.exec(e.path) ?? TASK.exec(e.path);
  return m ? decodeURIComponent(m[1]!) : null;
}

const onlyKey = (b: unknown, k: string): boolean => {
  const keys = Object.keys(bodyOf(b));
  return keys.length === 1 && keys[0] === k;
};

function persist(): void {
  const snap = queue.map((e) => ({ ...e }));
  saveChain = saveChain.then(() => (snap.length ? kvSet(KEY, snap) : kvDel(KEY))).catch(() => undefined);
}

function notify(): void {
  for (const h of [...handlers]) {
    try {
      h();
    } catch (err) {
      console.error(err);
    }
  }
}

function schedule(): void {
  if (queue.length && !timer) timer = setInterval(() => void flushOutbox(), RETRY_MS);
  else if (!queue.length && timer) {
    clearInterval(timer);
    timer = null;
  }
}

function enqueue(method: string, path: string, body: unknown): void {
  const removable = (e: OutboxEntry): boolean => e.id !== inflight;
  const entry: OutboxEntry = { id: crypto.randomUUID(), method, path, body, at: Date.now() };
  if (path === "/api/messages/read") {
    queue = queue.filter((e) => e.path !== path || !removable(e)); // only the newest read position matters
  } else if (method === "PATCH" && TASK.test(path)) {
    queue = queue.filter((e) => !(e.method === "PATCH" && e.path === path && removable(e))); // last "done" wins
  } else if (method === "PATCH" && ITEM.test(path) && onlyKey(body, "bought")) {
    queue = queue.filter((e) => !(e.method === "PATCH" && e.path === path && onlyKey(e.body, "bought") && removable(e)));
  } else if (method === "DELETE" && ITEM.test(path)) {
    const id = targetId(entry);
    const created = queue.find((e) => e.method === "POST" && e.path === "/api/items" && targetId(e) === id);
    if (created && removable(created)) {
      // Added and deleted while offline: the server never needs to hear about it.
      queue = queue.filter((e) => targetId(e) !== id);
      persist();
      notify();
      schedule();
      return;
    }
  }
  queue.push(entry);
  persist();
  notify();
  schedule();
  if (!isOffline()) void flushOutbox();
}

function describe(e: OutboxEntry): string {
  if (e.method === "POST" && e.path === "/api/items") return `adding "${String(bodyOf(e.body).name ?? "an item")}"`;
  if (ITEM.test(e.path)) return e.method === "DELETE" ? "deleting an item" : "updating an item";
  if (TASK.test(e.path)) return "updating a task";
  if (e.path === "/api/messages") return "sending a message";
  return "a change";
}

function shortError(err: ApiError): string {
  if (err.status === 404) return "it no longer exists";
  if (err.status === 403) return "not allowed";
  if (err.status === 409) return "conflict";
  return err.code.replace(/_/g, " ");
}

async function run(): Promise<void> {
  syncing = true;
  notify();
  let done = 0;
  try {
    while (queue.length) {
      const e = queue[0]!;
      inflight = e.id;
      try {
        await apiRaw(e.path, e.method, e.body);
      } catch (err) {
        if (!(err instanceof ApiError)) break;
        if (err.status === 0 || err.status === 401 || err.status >= 500) break; // keep it, try again later
        // Any other 4xx will never succeed: drop it and say so (a delete of something already gone is fine).
        const quiet = e.path === "/api/messages/read" || (e.method === "DELETE" && err.status === 404);
        if (!quiet) toast(`Couldn't sync: ${describe(e)} (${shortError(err)})`, true);
      } finally {
        inflight = null;
      }
      queue = queue.filter((x) => x.id !== e.id);
      done++;
      persist();
      notify();
    }
  } finally {
    syncing = false;
  }
  if (done) syncedHandler?.();
}

/** Replay queued changes now (no-op when empty, signed out, offline, or already running). */
export function flushOutbox(): Promise<void> {
  if (flushing) return flushing;
  if (!queue.length || !getToken() || navigator.onLine === false) return Promise.resolve();
  flushing = run().finally(() => {
    flushing = null;
    notify();
    schedule();
  });
  return flushing;
}

export const pendingCount = (): number => queue.length;
export const isSyncing = (): boolean => syncing;
export const queuedEntries = (): OutboxEntry[] => queue.slice();
/** Ids (items, tasks, messages) that have a change waiting to sync. */
export const queuedIds = (): Set<string> => new Set(queue.map(targetId).filter((x): x is string => !!x));
export function onOutboxChange(cb: () => void): () => void {
  handlers.add(cb);
  return () => handlers.delete(cb);
}
/** Called after a replay batch got at least one change through; main refreshes the active view. */
export function onOutboxSynced(cb: () => void): void {
  syncedHandler = cb;
}

/** Drop everything (sign-out). */
export async function clearOutbox(): Promise<void> {
  queue = [];
  schedule();
  notify();
  await saveChain;
  await kvDel(KEY).catch(() => undefined);
}

const ready: Promise<void> = (async () => {
  try {
    const stored = await kvGet<OutboxEntry[]>(KEY);
    if (Array.isArray(stored) && stored.length) {
      queue = [...stored.filter((e) => e && typeof e.path === "string"), ...queue];
      notify();
      schedule();
    }
  } catch {
    /* IndexedDB unavailable: the outbox then lives only in memory */
  }
})();

setQueueHook({ ready, hasPending: () => queue.length > 0, queueable, enqueue });
window.addEventListener("online", () => void flushOutbox());
// Phones pause the app in the background: try again the moment it is back on screen.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void flushOutbox();
});
onNetworkChange(() => {
  if (!isOffline()) void flushOutbox();
});
