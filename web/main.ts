import { ApiError, api, clearReadCache, clearToken, getToken, isOffline, loadToken, onNetworkChange, onUnauthorized } from "./lib/api";
import { h } from "./lib/dom";
import { initInstall } from "./lib/install";
import { onEvent, onRemoved, startLive, stopLive } from "./lib/live";
import type { LiveEvent } from "./lib/live";
import { clearOutbox, flushOutbox, isSyncing, onOutboxChange, onOutboxSynced, pendingCount } from "./lib/outbox";
import { ROUTES, startRouter } from "./lib/router";
import type { Route } from "./lib/router";
import { clearSession, isParent, loadSession, session } from "./lib/session";
import { kvGet, kvSet } from "./lib/store";
import { resubscribePush } from "./push";
import { closeAllSheets, toast } from "./lib/ui";
import * as chatView from "./views/chat";
import * as listView from "./views/list";
import { showOnboarding } from "./views/onboarding";
import { openSettings } from "./views/settings";
import * as tasksView from "./views/tasks";
import type { View } from "./views/types";

const views: Record<Route, View> = { list: listView, tasks: tasksView, chat: chatView };
const TABS: { route: Route; label: string; ico: string }[] = [
  { route: "list", label: "List", ico: "\u{1F6D2}" },
  { route: "tasks", label: "Tasks", ico: "✅" },
  { route: "chat", label: "Chat", ico: "\u{1F4AC}" },
];

const app = document.getElementById("app") as HTMLElement;
let unmountView: (() => void) | null = null;
let activeRoute: Route | null = null;
let unsub: (() => void) | null = null;
let signingOut = false;
let main: HTMLElement | null = null;
let offlineBar: HTMLElement | null = null;
const tabEls = new Map<Route, HTMLElement>();

// Tab badges: how many things others added or changed since this tab was last open.
const counts: Record<Route, number> = { list: 0, tasks: 0, chat: 0 };
const badges = new Map<Route, HTMLElement>();
const COUNT_KEY: Record<Route, string> = { list: "listUnread", tasks: "tasksUnread", chat: "unread" };
const SEEN_KEY: Record<Route, string> = { list: "listSeenAt", tasks: "tasksSeenAt", chat: "chatSeenAt" };
const BADGE_LABEL: Record<Route, string> = { list: "New items", tasks: "New or updated tasks", chat: "Unread messages" };

interface TaskLite {
  assignee_id: string | null;
  created_by: string;
  created_at: number;
  done_by: string | null;
  done_at: number | null;
  blocked_by: string | null;
  blocked_at: number | null;
  seen_by: string | null;
  seen_at: number | null;
}

/** Count what others did after `since`. Read receipts, ticks and edits also emit events, so we recount rather than add 1. */
const COUNTERS: Record<Route, (since: number, meId: string | undefined) => Promise<number>> = {
  chat: async (since, meId) => {
    const { messages } = await api<{ messages: { author_id: string; created_at: number }[] }>("/api/messages?limit=100");
    return messages.filter((m) => m.author_id !== meId && m.created_at > since).length;
  },
  list: async (since, meId) => {
    const { items } = await api<{ items: { added_by: string; added_at: number; bought_at: number | null }[] }>("/api/items");
    return items.filter((i) => !i.bought_at && i.added_by !== meId && i.added_at > since).length;
  },
  tasks: async (since, meId) => {
    const { open, done } = await api<{ open: TaskLite[]; done: TaskLite[] }>("/api/tasks");
    const parent = isParent();
    // Everyone: new tasks for them. Parents also: tasks others saw, finished or got stuck on.
    const isNew = (t: TaskLite) =>
      t.created_by !== meId && t.created_at > since && (parent || t.assignee_id === null || t.assignee_id === meId);
    const blocked = (t: TaskLite) => parent && !!t.blocked_at && t.blocked_at > since && t.blocked_by !== meId;
    const seen = (t: TaskLite) => parent && !!t.seen_at && t.seen_at > since && t.seen_by !== meId;
    const finished = (t: TaskLite) => parent && !!t.done_at && t.done_at > since && t.done_by !== meId;
    return open.filter((t) => isNew(t) || blocked(t) || seen(t)).length + done.filter(finished).length;
  },
};

async function signOut(): Promise<void> {
  if (signingOut) return;
  signingOut = true;
  stopLive();
  unsub?.();
  unsub = null;
  unmountView?.();
  unmountView = null;
  activeRoute = null;
  closeAllSheets();
  await clearOutbox();
  await clearReadCache();
  void window.caches?.delete("bayt-media").catch(() => undefined);
  await clearToken();
  clearSession();
  for (const r of ROUTES) {
    counts[r] = 0;
    await kvSet(COUNT_KEY[r], 0).catch(() => undefined);
    await kvSet(SEEN_KEY[r], undefined).catch(() => undefined);
  }
  signingOut = false;
  await boot();
}

/** Slim banner under the header: offline / changes waiting / syncing. Hidden when online with nothing queued. */
function paintOffline(): void {
  if (!offlineBar) return;
  const n = pendingCount();
  const off = isOffline();
  let text = "";
  if (off) text = "Offline — showing saved data" + (n ? ` · ${n} ${n === 1 ? "change" : "changes"} waiting` : "");
  else if (isSyncing()) text = "Syncing…";
  else if (n) text = `${n} ${n === 1 ? "change" : "changes"} waiting to sync`;
  offlineBar.textContent = text;
  offlineBar.hidden = !text;
  offlineBar.classList.toggle("syncing", !off && !!text);
}

function paintBadges(): void {
  for (const [r, el] of badges) {
    el.hidden = counts[r] <= 0;
    el.textContent = counts[r] > 99 ? "99+" : String(counts[r]);
  }
  // Home-screen icon dot/number where supported (installed PWA on Android/desktop).
  const total = ROUTES.reduce((n, r) => n + counts[r], 0);
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  void (total ? nav.setAppBadge?.(total) : nav.clearAppBadge?.())?.catch(() => undefined);
}

function setCount(r: Route, n: number): void {
  counts[r] = n;
  paintBadges();
  void kvSet(COUNT_KEY[r], n).catch(() => undefined);
}

/** Remember when a tab was last looked at, so its badge counts only newer things from others. */
function markSeen(r: Route): void {
  setCount(r, 0);
  void kvSet(SEEN_KEY[r], Date.now()).catch(() => undefined);
}

/** First run (or just joined): start counting from now, not from the whole history. */
async function seenAt(r: Route): Promise<number> {
  const v = await kvGet<number>(SEEN_KEY[r]).catch(() => undefined);
  if (typeof v === "number") return v;
  const t = Date.now();
  await kvSet(SEEN_KEY[r], t).catch(() => undefined);
  return t;
}

async function recount(r: Route): Promise<void> {
  try {
    const n = await COUNTERS[r](await seenAt(r), session.me?.id);
    if (activeRoute === r) return;
    setCount(r, n);
  } catch {
    /* offline or signed out: keep the current badge */
  }
}

function recountOthers(): void {
  for (const r of ROUTES) if (r !== activeRoute) void recount(r);
}

function showRoute(r: Route): void {
  if (!main) return;
  closeAllSheets();
  unmountView?.();
  // Things that arrived while the old tab was open were seen there.
  if (activeRoute && activeRoute !== r) markSeen(activeRoute);
  activeRoute = r;
  unmountView = views[r].mount(main);
  main.scrollTop = 0;
  for (const [route, el] of tabEls) {
    if (route === r) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  markSeen(r);
}

function onLive(e: LiveEvent): void {
  if (e.type === "poll") {
    void loadSession().catch(() => undefined);
    if (activeRoute) void views[activeRoute].refresh().catch(() => undefined);
    recountOthers();
    return;
  }
  if (e.type !== "changed") return;
  if (e.scope === "members") {
    void loadSession().catch(() => undefined);
    return;
  }
  if (e.scope === activeRoute) void views[e.scope].refresh().catch(() => undefined);
  else void recount(e.scope);
}

function buildFrame(): void {
  main = h("main", { class: "main", id: "main" });
  offlineBar = h("div", { class: "offline-bar", role: "status", "aria-live": "polite", hidden: true });
  badges.clear();
  tabEls.clear();
  const tabs = TABS.map((t) => {
    const badge = h("span", { class: "badge", hidden: true, "aria-label": BADGE_LABEL[t.route] });
    badges.set(t.route, badge);
    const el = h(
      "a",
      { class: "tab", href: "#/" + t.route },
      h("span", { class: "ico", "aria-hidden": "true" }, t.ico),
      h("span", null, t.label),
      badge,
    );
    tabEls.set(t.route, el);
    return el;
  });
  app.replaceChildren(
    h(
      "div",
      { class: "frame" },
      h(
        "header",
        { class: "top" },
        h("h1", null, "Bayt"),
        h("button", { class: "icon-btn", "aria-label": "Settings", onclick: () => openSettings(() => void signOut()) }, "⚙"),
      ),
      offlineBar,
      main,
      h("nav", { class: "tabbar", "aria-label": "Sections" }, tabs),
    ),
  );
  paintBadges();
  paintOffline();
}

async function startApp(): Promise<void> {
  for (const r of ROUTES) counts[r] = (await kvGet<number>(COUNT_KEY[r]).catch(() => 0)) || 0;
  buildFrame();
  unsub = onEvent(onLive);
  startRouter(showRoute);
  recountOthers();
  startLive();
  void flushOutbox();
}

async function boot(): Promise<void> {
  await loadToken();
  if (!getToken()) {
    await showOnboarding(app, () => void boot());
    return;
  }
  try {
    await loadSession();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return; // onUnauthorized already signing out
    app.replaceChildren(
      h(
        "div",
        { class: "onboard" },
        h("div", { class: "card" }, h("h1", null, "Cannot connect"), h("p", null, "Check your connection and try again."), h("button", { class: "btn primary block", onclick: () => void boot() }, "Try again")),
      ),
    );
    return;
  }
  void syncTimezone();
  await startApp();
}

/** Parents seed the household timezone from the browser when the server still has the UTC default. */
async function syncTimezone(): Promise<void> {
  try {
    if (!isParent()) return;
    const { tz } = await api<{ tz: string }>("/api/household");
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if ((!tz || tz === "UTC") && local && local !== "UTC") await api("/api/household", { method: "PUT", body: { tz: local } });
  } catch {
    /* best effort */
  }
}

onNetworkChange(paintOffline);
onOutboxChange(paintOffline);
onOutboxSynced(() => {
  if (activeRoute) void views[activeRoute].refresh().catch(() => undefined);
  recountOthers();
});
// Leaving the app counts as having seen the open tab (the next launch may open on another one).
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && activeRoute) markSeen(activeRoute);
});
onUnauthorized(() => void signOut());
onRemoved(() => void signOut());
initInstall();
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker
    .register("/sw.js")
    .then((reg) => {
      const activate = (w: ServiceWorker | null): void => {
        if (w && navigator.serviceWorker.controller) {
          toast("Updating Bayt…");
          w.postMessage({ type: "SKIP_WAITING" });
        }
      };
      activate(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed") activate(w);
        });
      });
      void loadToken().then(() => {
        const t = getToken();
        if (t && "Notification" in window && Notification.permission === "granted") void resubscribePush(t);
      });
    })
    .catch(() => undefined);
}
void boot();
