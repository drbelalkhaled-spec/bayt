import { ApiError, api, getToken, markOnline, wsUrl } from "./api";
import { flushOutbox } from "./outbox";

export type LiveEvent =
  | { type: "hello"; online: string[] }
  | { type: "presence"; online: string[] }
  | { type: "changed"; scope: "list" | "tasks" | "chat" | "members" }
  | { type: "typing"; memberId: string }
  | { type: "poll" }; // synthetic: safety poll tick or (re)connect; refresh everything

type Handler = (e: LiveEvent) => void;

const POLL_LIVE_MS = 30000;
const POLL_DOWN_MS = 4000;

const handlers = new Set<Handler>();
let onlineSet = new Set<string>();
let ws: WebSocket | null = null;
let up = false;
let tries = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let pollT: ReturnType<typeof setInterval> | null = null;
let pingT: ReturnType<typeof setInterval> | null = null;
let lastRx = 0;
let lastTyping = 0;
let running = false;
let removedHandler: (() => void) | null = null;

export const online = (): Set<string> => onlineSet;
export const isConnected = (): boolean => up;
export function onEvent(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}
export function onRemoved(fn: () => void): void {
  removedHandler = fn;
}

function emit(e: LiveEvent): void {
  for (const h of [...handlers]) {
    try {
      h(e);
    } catch (err) {
      console.error(err);
    }
  }
}

function setPoll(ms: number): void {
  if (pollT) clearInterval(pollT);
  pollT = setInterval(() => {
    if (document.visibilityState === "visible") emit({ type: "poll" });
  }, ms);
}

function connect(): void {
  const token = getToken();
  if (!running || ws || !token || document.visibilityState !== "visible") return;
  if (timer) clearTimeout(timer);
  timer = null;
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl("/api/live"), ["bayt", token]);
  } catch {
    return schedule();
  }
  ws = sock;
  let opened = false;
  sock.onopen = () => {
    opened = true;
    up = true;
    tries = 0;
    lastRx = Date.now();
    setPoll(POLL_LIVE_MS);
    markOnline();
    void flushOutbox();
    emit({ type: "poll" });
  };
  sock.onmessage = (ev) => {
    lastRx = Date.now();
    if (typeof ev.data !== "string" || ev.data === "pong") return;
    let m: LiveEvent;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    if (m.type === "hello" || m.type === "presence") onlineSet = new Set(Array.isArray(m.online) ? m.online : []);
    emit(m);
  };
  sock.onclose = (ev) => down(ev.code, opened);
}

function down(code: number, opened: boolean): void {
  ws = null;
  up = false;
  onlineSet = new Set();
  setPoll(POLL_DOWN_MS);
  emit({ type: "presence", online: [] });
  if (code === 4001) return removedHandler?.();
  // A failed upgrade (e.g. 401) is invisible to the page; a normal call tells us (api() signs out on 401).
  if (!opened) api("/api/me").catch((e) => e instanceof ApiError && e.status === 401 && removedHandler?.());
  schedule();
}

function schedule(): void {
  if (!running || timer || document.visibilityState !== "visible") return;
  const wait = Math.min(30000, 1000 * 2 ** tries++);
  timer = setTimeout(() => {
    timer = null;
    connect();
  }, wait);
}

// A half-open socket can sit "open" for minutes; drop without waiting for the close handshake.
function drop(): void {
  const s = ws;
  if (!s) return;
  s.onopen = s.onmessage = s.onclose = null;
  try {
    s.close();
  } catch {
    /* ignore */
  }
  ws = null;
  up = false;
  onlineSet = new Set();
  setPoll(POLL_DOWN_MS);
}

function onVisibility(): void {
  if (!running) return;
  if (document.visibilityState === "hidden") {
    if (timer) clearTimeout(timer);
    timer = null;
    drop();
    return;
  }
  tries = 0;
  emit({ type: "poll" });
  connect();
}

export function startLive(): void {
  if (running) return;
  running = true;
  tries = 0;
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  setPoll(POLL_DOWN_MS);
  pingT = setInterval(() => {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - lastRx > 60000) return drop(), connect();
    try {
      ws.send("ping");
    } catch {
      /* ignore */
    }
  }, 25000);
  connect();
}

function onOnline(): void {
  drop();
  tries = 0;
  connect();
}

export function stopLive(): void {
  running = false;
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("online", onOnline);
  if (timer) clearTimeout(timer);
  if (pollT) clearInterval(pollT);
  if (pingT) clearInterval(pingT);
  timer = pollT = pingT = null;
  const s = ws;
  if (s) {
    s.onopen = s.onmessage = s.onclose = null;
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  ws = null;
  up = false;
  onlineSet = new Set();
}

/** Tell others we are typing; throttled to one frame per 3 s. */
export function sendTyping(): void {
  const now = Date.now();
  if (now - lastTyping < 3000 || !ws || ws.readyState !== 1) return;
  lastTyping = now;
  try {
    ws.send(JSON.stringify({ type: "typing" }));
  } catch {
    /* ignore */
  }
}
