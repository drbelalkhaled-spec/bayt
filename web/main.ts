import { ApiError, api, clearReadCache, clearToken, getToken, isOffline, loadToken, onNetworkChange, onUnauthorized } from "./lib/api";
import { h } from "./lib/dom";
import { initInstall } from "./lib/install";
import { onEvent, onRemoved, startLive, stopLive } from "./lib/live";
import type { LiveEvent } from "./lib/live";
import { clearOutbox, flushOutbox, isSyncing, onOutboxChange, onOutboxSynced, pendingCount } from "./lib/outbox";
import { current, startRouter } from "./lib/router";
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
let unread = 0;
let unsub: (() => void) | null = null;
let signingOut = false;
let main: HTMLElement | null = null;
let badge: HTMLElement | null = null;
let offlineBar: HTMLElement | null = null;
const tabEls = new Map<Route, HTMLElement>();

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
  unread = 0;
  await kvSet("unread", 0).catch(() => undefined);
  await kvSet("chatSeenAt", 0).catch(() => undefined);
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

function paintBadge(): void {
  if (!badge) return;
  badge.hidden = unread <= 0;
  badge.textContent = unread > 99 ? "99+" : String(unread);
}

function setUnread(n: number): void {
  unread = n;
  paintBadge();
  void kvSet("unread", n).catch(() => undefined);
}

function showRoute(r: Route): void {
  if (!main) return;
  closeAllSheets();
  unmountView?.();
  activeRoute = r;
  unmountView = views[r].mount(main);
  main.scrollTop = 0;
  for (const [route, el] of tabEls) {
    if (route === r) el.setAttribute("aria-current", "page");
    else el.removeAttribute("aria-current");
  }
  if (r === "chat") markChatSeen();
}

/** Remember when chat was last open, so the badge counts only newer messages from others. */
function markChatSeen(): void {
  setUnread(0);
  void kvSet("chatSeenAt", Date.now()).catch(() => undefined);
}

/** Recount unread chat messages: read receipts and pins also emit "chat", so we can't just add 1. */
async function recountUnread(): Promise<void> {
  try {
    const seenAt = (await kvGet<number>("chatSeenAt").catch(() => 0)) || 0;
    const { messages } = await api<{ messages: { author_id: string; created_at: number }[] }>("/api/messages?limit=100");
    const meId = session.me?.id;
    if (activeRoute === "chat") return;
    setUnread(messages.filter((m) => m.author_id !== meId && m.created_at > seenAt).length);
  } catch {
    /* offline or signed out: keep the current badge */
  }
}

function onLive(e: LiveEvent): void {
  if (e.type === "poll") {
    void loadSession().catch(() => undefined);
    if (activeRoute) void views[activeRoute].refresh().catch(() => undefined);
    return;
  }
  if (e.type !== "changed") return;
  if (e.scope === "members") {
    void loadSession().catch(() => undefined);
    return;
  }
  if (e.scope === "chat" && activeRoute !== "chat") void recountUnread();
  if (e.scope === activeRoute) void views[e.scope].refresh().catch(() => undefined);
}

function buildFrame(): void {
  main = h("main", { class: "main", id: "main" });
  offlineBar = h("div", { class: "offline-bar", role: "status", "aria-live": "polite", hidden: true });
  badge = h("span", { class: "badge", hidden: true, "aria-label": "Unread messages" });
  tabEls.clear();
  const tabs = TABS.map((t) => {
    const el = h(
      "a",
      { class: "tab", href: "#/" + t.route },
      h("span", { class: "ico", "aria-hidden": "true" }, t.ico),
      h("span", null, t.label),
      t.route === "chat" ? badge : null,
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
  paintBadge();
  paintOffline();
}

async function startApp(): Promise<void> {
  unread = (await kvGet<number>("unread").catch(() => 0)) || 0;
  buildFrame();
  unsub = onEvent(onLive);
  startRouter(showRoute);
  if (current() === "chat") markChatSeen();
  else void recountUnread();
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
  void recountUnread();
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
