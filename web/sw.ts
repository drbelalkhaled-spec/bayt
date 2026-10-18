/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, StaleWhileRevalidate } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope;

// Precache the build output. /api/* JSON is never cached here (the page keeps its own
// offline copy in IndexedDB): the only runtime routes are navigations, immutable
// /api/media/* files and Google Fonts, so every other request (API calls, the WebSocket
// upgrade) falls through to the network untouched.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Navigations: the network (3 s), else the precached app shell. Pages are deliberately NOT cached on
// their own: after an update such a copy points at script files that no longer exist (blank screen),
// while the precached shell always matches the precached scripts.
const shell = createHandlerBoundToURL("/index.html");
const NAV_TIMEOUT_MS = 3000;
registerRoute(
  new NavigationRoute(
    async (opts) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), NAV_TIMEOUT_MS);
      try {
        const r = await fetch(opts.request, { signal: ctl.signal });
        if (r.ok) return r;
      } catch {
        /* offline, server down or too slow */
      } finally {
        clearTimeout(timer);
      }
      return shell(opts);
    },
    { denylist: [/^\/api\//] },
  ),
);

// ---------------------------------------------------------------- runtime caches (offline)
// Photos: keys are immutable, so cache-first. The auth token rides in ?t=, which is dropped from the
// cache key (a re-login must not orphan the cache). Range requests (audio, video) are left to the network, and video responses are never stored.
const MEDIA_CACHE = "bayt-media";
const MEDIA_MAX = 200;
async function trimMedia(): Promise<void> {
  const cache = await caches.open(MEDIA_CACHE);
  const keys = await cache.keys(); // oldest first
  for (const k of keys.slice(0, Math.max(0, keys.length - MEDIA_MAX))) await cache.delete(k);
}
registerRoute(
  ({ url, request }) =>
    request.method === "GET" && url.origin === self.location.origin && url.pathname.startsWith("/api/media/") && !request.headers.has("range"),
  new CacheFirst({
    cacheName: MEDIA_CACHE,
    plugins: [
      {
        // Videos are big and streamed with Range requests: never keep them in the photo cache.
        cacheWillUpdate: async ({ response }) =>
          response.status === 200 && !(response.headers.get("content-type") ?? "").toLowerCase().startsWith("video/") ? response : null,
        cacheKeyWillBeUsed: async ({ request }) => {
          const u = new URL(request.url);
          u.searchParams.delete("t");
          return u.href;
        },
        cacheDidUpdate: async () => {
          await trimMedia();
        },
      },
    ],
  }),
);

// Chalk fonts. The <link>/@font-face loads can be opaque (status 0), so accept those too.
const okOrOpaque = {
  cacheWillUpdate: async ({ response }: { response: Response }) => (response.status === 0 || response.status === 200 ? response : null),
};
registerRoute(
  ({ url }) => url.origin === "https://fonts.googleapis.com",
  new StaleWhileRevalidate({ cacheName: "bayt-gfonts-css", plugins: [okOrOpaque] }),
);
registerRoute(
  ({ url }) => url.origin === "https://fonts.gstatic.com",
  new CacheFirst({ cacheName: "bayt-gfonts", plugins: [okOrOpaque] }),
);

self.addEventListener("message", (e) => {
  if ((e.data as { type?: string } | null)?.type === "SKIP_WAITING") void self.skipWaiting();
});
self.addEventListener("activate", (e) =>
  e.waitUntil(
    // "bayt-pages" held page copies in older versions (see the navigation route); drop it.
    caches.delete("bayt-pages").then(() => self.clients.claim()),
  ),
);

// ---------------------------------------------------------------- token
// Dependency-free raw IndexedDB access to the app's key/value store (DB "bayt", store "kv"): the auth
// token ("token") and this device's notification cursor ("pushCursor"). Resolves null on any problem.
function kv<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest | void): Promise<T | null> {
  return new Promise((res) => {
    let r: IDBOpenDBRequest;
    try {
      r = indexedDB.open("bayt", 1);
    } catch {
      return res(null);
    }
    // DB missing: abort the creation so we don't leave a store-less husk that
    // would break the app's own upgrade path.
    r.onupgradeneeded = () => {
      try {
        r.transaction?.abort();
      } catch {
        /* ignore */
      }
      res(null);
    };
    r.onerror = () => res(null);
    r.onsuccess = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("kv")) {
        db.close();
        return res(null);
      }
      try {
        const t = db.transaction("kv", mode);
        const q = run(t.objectStore("kv"));
        t.oncomplete = () => {
          db.close();
          res(q ? (q.result as T) : null);
        };
        t.onerror = t.onabort = () => {
          db.close();
          res(null);
        };
      } catch {
        db.close();
        res(null);
      }
    };
  });
}

async function readToken(): Promise<string | null> {
  const v = await kv<unknown>("readonly", (s) => s.get("token"));
  return typeof v === "string" && v ? v : null;
}

// ---------------------------------------------------------------- push
// A push is only a knock. Every event is its own notice on the server; this device asks for the ones past its
// cursor (GET /api/push/notices) and shows each under its own tag, so two quick pushes never overwrite each
// other and an urgent task's sticky notification is not replaced by a chat message.
interface Notice {
  id: string;
  kind: string;
  text: string;
  ref: string | null;
  at: number;
}

const MAX_SHOWN = 4;
const FIRST_WINDOW_MS = 10 * 60_000;
/** Notices already displayed by this worker: concurrent push events fetch the same ones, and the repeat must stay silent. */
const shown = new Set<string>();
/** Newest notice time seen by this worker (the saved cursor can only be behind it); stops a late event moving the cursor back. */
let cursorMem = 0;

const ICON = "/icons/icon-192.png";
const routeOf = (url: string): string => /#\/(\w+)/.exec(url)?.[1] ?? "";

/** Where a tap goes: the exact task, message or item when the notice names one, else the tab. */
function routeFor(kind?: string, ref?: string | null): string {
  const m = /^(task|msg|item):([\w-]+)$/.exec(ref ?? "");
  if (m) return `/#/${m[1] === "task" ? "tasks" : m[1] === "msg" ? "chat" : "list"}/${m[2]}`;
  switch (kind) {
    case "chat":
    case "msg_reminder":
      return "/#/chat";
    case "task_new":
    case "task_urgent":
    case "task_comment":
    case "task_seen":
    case "task_done":
    case "task_blocked":
    case "reminder":
      return "/#/tasks";
    case "shopping":
      return "/#/list";
    default:
      return "/#/list"; // "item" and anything unknown
  }
}

/** Routes ("chat", "tasks", "list") that a visible, focused window is showing right now. */
async function routesOnScreen(): Promise<Set<string>> {
  try {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    return new Set(wins.filter((c) => c.focused && c.visibilityState === "visible").map((c) => routeOf(c.url)));
  } catch {
    return new Set();
  }
}

function showNotice(n: Notice, quiet: boolean): Promise<void> {
  const urgent = n.kind === "task_urgent";
  const again = shown.has(n.id);
  if (shown.size > 200) shown.clear();
  shown.add(n.id);
  return self.registration.showNotification("Bayt", {
    body: n.text,
    icon: ICON,
    badge: ICON,
    tag: `${n.kind}:${n.ref ?? n.id}`,
    // A repeat of one already on screen replaces it without buzzing (and without the browser's own "updated in the background").
    renotify: !again,
    // In a burst only the last one makes a sound; urgent tasks always do.
    silent: quiet && !urgent ? true : undefined,
    // Urgent tasks stay on screen until dismissed and buzz harder.
    requireInteraction: urgent,
    vibrate: urgent ? [300, 120, 300, 120, 300] : undefined,
    data: { url: routeFor(n.kind, n.ref), id: n.id, at: n.at, kind: n.kind },
  } as NotificationOptions);
}

const showGeneric = (): Promise<void> =>
  self.registration.showNotification("Bayt", {
    body: "Something changed at home",
    icon: ICON,
    badge: ICON,
    tag: "bayt",
    renotify: true,
    data: { url: "/#/list" },
  } as NotificationOptions);

async function fetchNotices(token: string): Promise<Notice[] | null> {
  try {
    const saved = await kv<unknown>("readonly", (s) => s.get("pushCursor"));
    const after = Math.max(cursorMem, typeof saved === "number" ? saved : 0) || Date.now() - FIRST_WINDOW_MS;
    const r = await fetch("/api/push/notices?after=" + after, { headers: { authorization: "Bearer " + token }, cache: "no-store" });
    return r.ok ? (((await r.json()) as { notices?: Notice[] }).notices ?? null) : null;
  } catch {
    return null;
  }
}

async function onPush(): Promise<void> {
  const token = await readToken();
  const list = token ? await fetchNotices(token) : null;
  // Any failure: the generic notification, as the browser requires something visible.
  if (!list) return showGeneric();

  // If a visible, focused window is already showing a notice's tab the user sees the change live, so that
  // notification is skipped. Chrome tolerates this when a client is focused.
  const onScreen = await routesOnScreen();

  if (!list.length) {
    // Nothing new: another push event already showed it. Put the latest one back under the same tag, silently,
    // so the browser has no reason to show its own "updated in the background".
    if (onScreen.size) return;
    const last = (await self.registration.getNotifications()).sort(
      (a, b) => ((b.data as { at?: number } | null)?.at ?? 0) - ((a.data as { at?: number } | null)?.at ?? 0),
    )[0] as (Notification & { badge?: string }) | undefined;
    if (!last) return showGeneric();
    return self.registration.showNotification(last.title, {
      body: last.body,
      icon: last.icon,
      badge: last.badge,
      tag: last.tag,
      data: last.data,
      requireInteraction: last.requireInteraction,
      renotify: false,
    } as NotificationOptions);
  }

  const todo = list.filter((n) => !onScreen.has(routeOf(routeFor(n.kind, n.ref))));
  // Up to MAX_SHOWN get their own notification (urgent tasks first, then the newest); the rest become one summary.
  const rank = (n: Notice): number => (n.kind === "task_urgent" ? 1e15 : 0) + n.at;
  const own =
    todo.length > MAX_SHOWN ? [...todo].sort((a, b) => rank(b) - rank(a)).slice(0, MAX_SHOWN).sort((a, b) => a.at - b.at) : todo;
  const rest = todo.filter((n) => !own.includes(n));
  for (const [i, n] of own.entries()) await showNotice(n, i < own.length - 1 || rest.length > 0);
  if (rest.length) {
    const newest = rest[rest.length - 1]!;
    await self.registration.showNotification("Bayt", {
      body: `${rest.length} more update${rest.length === 1 ? "" : "s"}`,
      icon: ICON,
      badge: ICON,
      tag: "bayt-more",
      renotify: true,
      data: { url: routeFor(newest.kind), at: newest.at, kind: newest.kind },
    } as NotificationOptions);
  }
  // Only after showing: if the worker dies half way, the rest are fetched again next time.
  cursorMem = Math.max(cursorMem, ...list.map((n) => n.at));
  await kv("readwrite", (s) => {
    s.put(cursorMem, "pushCursor");
  });
}

self.addEventListener("push", (e) => e.waitUntil(onPush()));

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data as { url?: string } | null)?.url || "/#/list";
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const w = wins[0] as WindowClient | undefined;
      if (w) {
        try {
          await w.focus();
          await w.navigate(new URL(url, self.location.origin).href);
          return;
        } catch {
          /* fall through to openWindow */
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// ---------------------------------------------------------------- resubscribe
function b64uToU8(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
}

self.addEventListener("pushsubscriptionchange", (e) => {
  const ev = e as ExtendableEvent & { oldSubscription?: PushSubscription | null; newSubscription?: PushSubscription | null };
  ev.waitUntil(
    (async () => {
      try {
        const token = await readToken();
        if (!token) return;
        const headers = { "content-type": "application/json", authorization: "Bearer " + token };
        const { key } = (await (await fetch("/api/push/key")).json()) as { key: string };
        const sub =
          ev.newSubscription ??
          (await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: b64uToU8(key) as BufferSource,
          }));
        await fetch("/api/push/subscribe", { method: "POST", headers, body: JSON.stringify({ subscription: sub.toJSON() }) });
        // Only this device's old address goes; the person's other devices keep theirs.
        const old = ev.oldSubscription?.endpoint;
        if (old && old !== sub.endpoint) await fetch("/api/push/subscribe", { method: "DELETE", headers, body: JSON.stringify({ endpoint: old }) });
      } catch {
        /* best effort */
      }
    })(),
  );
});
