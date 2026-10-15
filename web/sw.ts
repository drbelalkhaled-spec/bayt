/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst, NetworkFirst, StaleWhileRevalidate } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope;

// Precache the build output. /api/* JSON is never cached here (the page keeps its own
// offline copy in IndexedDB): the only runtime routes are navigations, immutable
// /api/media/* files and Google Fonts, so every other request (API calls, the WebSocket
// upgrade) falls through to the network untouched.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// Navigations: network first (3 s), fall back to the precached app shell.
const shell = createHandlerBoundToURL("/index.html");
const navNetwork = new NetworkFirst({ cacheName: "bayt-pages", networkTimeoutSeconds: 3 });
registerRoute(
  new NavigationRoute(
    async (opts) => {
      try {
        return await navNetwork.handle(opts);
      } catch {
        return shell(opts);
      }
    },
    { denylist: [/^\/api\//] },
  ),
);

// ---------------------------------------------------------------- runtime caches (offline)
// Photos: keys are immutable, so cache-first. The auth token rides in ?t=, which is dropped from the
// cache key (a re-login must not orphan the cache). Range requests (audio) are left to the network.
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
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// ---------------------------------------------------------------- token
// Dependency-free raw IndexedDB read of the auth token (DB "bayt", store "kv", key "token").
function readToken(): Promise<string | null> {
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
        const g = db.transaction("kv", "readonly").objectStore("kv").get("token");
        g.onsuccess = () => {
          db.close();
          res(typeof g.result === "string" && g.result ? g.result : null);
        };
        g.onerror = () => {
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

// ---------------------------------------------------------------- push
interface Notice {
  title?: string;
  text?: string;
  kind?: string;
}

function routeFor(kind?: string): string {
  switch (kind) {
    case "chat":
      return "/#/chat";
    case "task_new":
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

self.addEventListener("push", (e) => {
  e.waitUntil(
    (async () => {
      let notice: Notice | null = null;
      try {
        const token = await readToken();
        if (token) {
          const r = await fetch("/api/push/notice", { headers: { authorization: "Bearer " + token }, cache: "no-store" });
          if (r.ok) notice = ((await r.json()) as { notice?: Notice }).notice ?? null;
        }
      } catch {
        /* fall through to the generic notification */
      }

      const url = routeFor(notice?.kind);

      // Choice: if a visible, focused window is already showing the target route the
      // user sees the change live, so the system notification is skipped. Chrome
      // tolerates this when a client is focused. In every other case (including all
      // failures) a notification is always shown, to honour userVisibleOnly.
      if (notice) {
        try {
          const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
          const want = url.slice(2); // "#/chat"
          if (wins.some((c) => c.focused && c.visibilityState === "visible" && new URL(c.url).hash === want)) return;
        } catch {
          /* ignore */
        }
      }

      await self.registration.showNotification(notice ? notice.title || "Bayt" : "Bayt", {
        body: notice ? notice.text : "Something changed at home",
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        tag: notice?.kind || "bayt",
        renotify: true,
        data: { url },
      } as NotificationOptions);
    })(),
  );
});

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
  (e as ExtendableEvent).waitUntil(
    (async () => {
      try {
        const token = await readToken();
        if (!token) return;
        const { key } = (await (await fetch("/api/push/key")).json()) as { key: string };
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64uToU8(key) as BufferSource,
        });
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
      } catch {
        /* best effort */
      }
    })(),
  );
});
