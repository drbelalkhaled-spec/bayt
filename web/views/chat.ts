import { ApiError, api, isOffline, isQueued, onNetworkChange } from "../lib/api";
import { add, clear, h } from "../lib/dom";
import { onEvent, sendTyping } from "../lib/live";
import { compressImage, pickImage, recordVoice, uploadMedia, voiceSupported, type VoiceRecording } from "../lib/media";
import { onOutboxChange, queuedEntries, queuedIds } from "../lib/outbox";
import { isParent, memberName, session } from "../lib/session";
import { confirmDialog, openSheet, toast, type Sheet } from "../lib/ui";
import { closeViewer, fmtDur, pendingPhotoEl, pendingVoiceEl, photoEl, stopAllAudio, voiceEl } from "./chat-media";
import "./views.css";
import "./chat.css";
import type { View } from "./types";

interface Msg {
  id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: number;
  kind: "text" | "photo" | "voice";
  media_key: string | null;
  media_meta: { w?: number; h?: number; durationMs?: number } | null;
  pinned_at: number | null;
  /** Created on this device while offline (or not yet confirmed by the server); replaced by the server row with the same id. */
  local?: boolean;
}
interface PinnedMsg extends Msg {
  pinned_by_name: string;
}
interface ReadRow {
  member_id: string;
  name: string;
  read_at: number;
}
interface Page {
  messages: Msg[];
  more: boolean;
  cursor: string | null;
  reads?: ReadRow[];
  pinned?: PinnedMsg[];
}
interface Pending {
  id: string;
  kind: "photo" | "voice";
  preview?: string;
}

const GROUP_MS = 5 * 60 * 1000;
const TYPING_MS = 4000;
const LONG_PRESS_MS = 550;
const MAX_LINES = 5;
const READ_DEBOUNCE_MS = 1000;
const MAX_VOICE_MS = 120_000;
const MIN_VOICE_MS = 700;

let root: HTMLElement | null = null;
let msgs: Msg[] = [];
let reads: ReadRow[] = [];
let pinned: PinnedMsg[] = [];
let pending: Pending[] = [];
let olderCursor: string | null = null;
let lastCursor: string | null = null;
let ready = false;
let busy = false;
let loadingOlder = false;
let refreshCount = 0;
let gen = 0;
let sig = "";
let lastReadPosted = 0;
let readTimer: ReturnType<typeof setTimeout> | null = null;
let msgsEl: HTMLElement | null = null;
let typingEl: HTMLElement | null = null;
let pillEl: HTMLElement | null = null;
let pinBar: HTMLButtonElement | null = null;
let unsubLive: (() => void) | null = null;
let unsubOutbox: (() => void) | null = null;
let unsubNet: (() => void) | null = null;
/** Message ids whose send is still waiting in the offline outbox. */
let waiting = new Set<string>();
const typers = new Map<string, ReturnType<typeof setTimeout>>();
/** Media elements are cached so a re-render does not interrupt playback or reload images. */
const mediaEls = new Map<string, HTMLElement>();

const cur = (m: Msg): string => `${m.created_at}:${m.id}`;
const isMine = (m: Msg): boolean => m.author_id === session.me?.id;
const errMsg = (e: unknown): string => (e instanceof ApiError && e.code === "network" ? "You are offline" : "Something went wrong");
const uploadErr = (e: unknown): string => {
  const c = e instanceof Error ? e.message : "";
  if (c === "network") return "You are offline";
  if (c === "too_large") return "That file is too large";
  return "Could not send";
};

function nearBottom(): boolean {
  return !msgsEl || msgsEl.scrollHeight - msgsEl.scrollTop - msgsEl.clientHeight < 80;
}
function toBottom(): void {
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  if (pillEl) pillEl.hidden = true;
}

function dayLabel(ms: number): string {
  const d = new Date(ms);
  const t = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(t) - day(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== t.getFullYear() ? { year: "numeric" } : {}) });
}
const timeLabel = (ms: number): string => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

function preview(m: Msg): string {
  if (m.kind === "photo") return "\u{1F4F7} " + (m.body || "Photo");
  if (m.kind === "voice") return "\u{1F3A4} Voice note";
  return m.body;
}

function merge(list: Msg[]): boolean {
  const byId = new Map(msgs.map((m) => [m.id, m]));
  let changed = false;
  for (const m of list) {
    const old = byId.get(m.id);
    if (!old || old.local) {
      byId.set(m.id, m);
      changed = true;
    }
  }
  if (changed) msgs = [...byId.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return changed;
}

/** Applies the reads/pinned side data of a page. Returns true when something changed. */
function applyExtras(p: Page): boolean {
  let changed = false;
  if (p.reads && JSON.stringify(p.reads) !== JSON.stringify(reads)) {
    reads = p.reads;
    changed = true;
  }
  if (p.pinned && JSON.stringify(p.pinned.map((x) => x.id)) !== JSON.stringify(pinned.map((x) => x.id))) {
    pinned = p.pinned;
    changed = true;
    paintPin();
  }
  return changed;
}

function seenText(): { id: string; text: string } | null {
  let last: Msg | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (isMine(msgs[i]!)) {
      last = msgs[i]!;
      break;
    }
  }
  if (!last) return null;
  const names = reads.filter((r) => r.read_at >= last!.created_at).map((r) => r.name);
  if (!names.length) return null;
  const others = session.members.filter((m) => m.id !== session.me?.id).length;
  if (names.length >= 2 && names.length >= others) return { id: last.id, text: "Seen by everyone" };
  const list = names.length === 1 ? names[0]! : names.slice(0, -1).join(", ") + " and " + names[names.length - 1]!;
  return { id: last.id, text: "Seen by " + list };
}

function mediaFor(m: Msg): HTMLElement {
  let el = mediaEls.get(m.id);
  if (!el) {
    el = m.kind === "photo" ? photoEl(m) : voiceEl(m);
    mediaEls.set(m.id, el);
  }
  return el;
}

function render(): void {
  if (!msgsEl) return;
  const seen = seenText();
  const pinIds = new Set(pinned.map((p) => p.id));
  waiting = queuedIds();
  const s = JSON.stringify([msgs.map((m) => m.id), olderCursor !== null, [...pinIds], seen, pending.map((p) => p.id), [...waiting]]);
  if (s === sig) return;
  sig = s;
  const top = msgsEl.scrollTop;
  clear(msgsEl);
  const live = new Set(msgs.map((m) => m.id));
  for (const k of [...mediaEls.keys()]) if (!live.has(k)) mediaEls.delete(k);
  if (olderCursor !== null) {
    add(msgsEl, h("button", { class: "btn small ghost load-earlier", type: "button", onclick: () => void loadOlder() }, "Load earlier"));
  }
  if (!msgs.length && !pending.length) add(msgsEl, h("div", { class: "empty" }, "No messages yet. Say hi \u{1F44B}"));
  let prev: Msg | null = null;
  for (const m of msgs) {
    const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
    if (newDay) add(msgsEl, h("div", { class: "day-sep" }, h("span", null, dayLabel(m.created_at))));
    const start = newDay || !prev || prev.author_id !== m.author_id || m.created_at - prev.created_at > GROUP_MS;
    const mine = isMine(m);
    const isMedia = m.kind === "photo" || m.kind === "voice";
    add(
      msgsEl,
      h(
        "div",
        { class: "msg " + (mine ? "mine" : "theirs") + (start ? " first" : ""), "data-id": m.id },
        !mine && start ? h("div", { class: "author" }, m.author_name || memberName(m.author_id)) : null,
        h(
          "div",
          { class: "bubble" + (isMedia ? " media " + m.kind : "") },
          isMedia ? mediaFor(m) : null,
          m.body ? h("span", { class: "text" }, m.body) : null,
          h("span", { class: "time" }, pinIds.has(m.id) ? h("span", { class: "pin-ico", "aria-label": "Pinned" }, "\u{1F4CC} ") : null, m.local && waiting.has(m.id) ? h("span", { class: "wait-clock", title: "Waiting to send", "aria-label": "Waiting to send" }, "⏳") : timeLabel(m.created_at)),
        ),
        seen && seen.id === m.id ? h("div", { class: "seen" }, seen.text) : null,
      ),
    );
    prev = m;
  }
  for (const p of pending) {
    add(
      msgsEl,
      h(
        "div",
        { class: "msg mine pending first" },
        h("div", { class: "bubble media " + p.kind }, p.kind === "photo" ? pendingPhotoEl(p.preview ?? "") : pendingVoiceEl()),
      ),
    );
  }
  msgsEl.scrollTop = top;
}

function paintTyping(): void {
  if (!typingEl) return;
  const names = [...typers.keys()].map(memberName);
  typingEl.textContent = names.length === 0 ? "" : names.length === 1 ? `${names[0]} is typing…` : `${names.join(" and ")} are typing…`;
}

function paintPin(): void {
  if (!pinBar) return;
  const p = pinned[0];
  pinBar.hidden = !p;
  if (!p) return;
  clear(pinBar);
  add(
    pinBar,
    h("span", { class: "pin-glyph", "aria-hidden": "true" }, "\u{1F4CC}"),
    h("span", { class: "pin-text" }, preview(p)),
    pinned.length > 1 ? h("span", { class: "pin-more" }, `+${pinned.length - 1}`) : null,
  );
}

async function fetchPage(q: string): Promise<Page> {
  return api<Page>("/api/messages" + q);
}

async function loadInitial(): Promise<void> {
  const my = gen;
  const p = await fetchPage("");
  if (my !== gen || !root) return;
  msgs = p.messages;
  reads = p.reads ?? [];
  pinned = p.pinned ?? [];
  olderCursor = p.more ? p.cursor : null;
  lastCursor = msgs.length ? cur(msgs[msgs.length - 1]!) : null;
  addQueuedMessages();
  ready = true;
  paintPin();
  render();
  toBottom();
  scheduleRead();
}

async function loadOlder(): Promise<void> {
  if (loadingOlder || olderCursor === null || !msgsEl) return;
  loadingOlder = true;
  const my = gen;
  try {
    const p = await fetchPage("?before=" + encodeURIComponent(olderCursor));
    if (my !== gen || !msgsEl) return;
    const prevH = msgsEl.scrollHeight;
    const prevTop = msgsEl.scrollTop;
    merge(p.messages);
    applyExtras(p);
    olderCursor = p.more ? p.cursor : null;
    sig = "";
    render();
    msgsEl.scrollTop = prevTop + (msgsEl.scrollHeight - prevH);
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    loadingOlder = false;
  }
}

function afterSent(m: Msg): void {
  merge([m]);
  if (!lastCursor || cur(m) > lastCursor) lastCursor = cur(m);
  render();
  toBottom();
  scheduleRead();
}

function localMsg(id: string, body: string, at: number): Msg {
  const me = session.me;
  return {
    id,
    author_id: me?.id ?? "",
    author_name: me?.name ?? "",
    body,
    created_at: at,
    kind: "text",
    media_key: null,
    media_meta: null,
    pinned_at: null,
    local: true,
  };
}

/** Show messages that are still in the outbox (e.g. after reopening the chat offline). */
function addQueuedMessages(): void {
  for (const e of queuedEntries()) {
    if (e.method !== "POST" || e.path !== "/api/messages") continue;
    const b = (e.body && typeof e.body === "object" ? e.body : {}) as { id?: unknown; body?: unknown };
    const id = String(b.id ?? "");
    if (id && !msgs.some((m) => m.id === id)) msgs = [...msgs, localMsg(id, String(b.body ?? ""), e.at)];
  }
}

async function send(text: string): Promise<void> {
  const id = crypto.randomUUID(); // the server stores the row under this id, so the optimistic bubble reconciles by id
  try {
    const r = await api<{ message: Msg }>("/api/messages", { method: "POST", body: { id, body: text } });
    afterSent(r.message);
  } catch (e) {
    if (!isQueued(e)) throw e;
    // Offline: show the bubble now with a clock. lastCursor is NOT advanced, so messages from others that
    // arrived meanwhile are still fetched by the next "after" refresh.
    merge([localMsg(id, text, Date.now())]);
    render();
    toBottom();
  }
}

// ---------- read receipts ----------
function scheduleRead(): void {
  if (!root || document.hidden || !ready || !msgs.length) return;
  const newest = msgs[msgs.length - 1]!.created_at;
  if (newest <= lastReadPosted) return;
  if (readTimer) clearTimeout(readTimer);
  const my = gen;
  readTimer = setTimeout(() => {
    readTimer = null;
    if (my !== gen || !root || document.hidden || !msgs.length) return;
    const at = msgs[msgs.length - 1]!.created_at;
    if (at <= lastReadPosted) return;
    const prevPosted = lastReadPosted;
    lastReadPosted = at;
    api("/api/messages/read", { method: "POST", body: { at } }).catch((e) => {
      if (!isQueued(e) && lastReadPosted === at) lastReadPosted = prevPosted;
    });
  }, READ_DEBOUNCE_MS);
}

// ---------- message actions ----------
async function removeMsg(m: Msg): Promise<void> {
  if (!(await confirmDialog("Delete this message for everyone?", "Delete", true))) return;
  try {
    await api("/api/messages/" + m.id, { method: "DELETE" });
    msgs = msgs.filter((x) => x.id !== m.id);
    pinned = pinned.filter((x) => x.id !== m.id);
    paintPin();
    render();
  } catch (e) {
    toast(errMsg(e), true);
  }
}

async function setPinned(m: Msg, on: boolean): Promise<boolean> {
  try {
    await api("/api/messages/" + m.id, { method: "PATCH", body: { pinned: on } });
  } catch (e) {
    toast(errMsg(e), true);
    return false;
  }
  if (on) {
    pinned = [{ ...m, pinned_at: Date.now(), pinned_by_name: session.me?.name ?? "" }, ...pinned.filter((x) => x.id !== m.id)];
  } else {
    pinned = pinned.filter((x) => x.id !== m.id);
  }
  paintPin();
  render();
  return true;
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { class: "clip-tmp" });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* ignore */
    }
    ta.remove();
  }
  toast("Copied");
}

const oneLine = (t: string, max: number): string => t.replace(/\s+/g, " ").trim().slice(0, max);

function field(label: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "field" }, h("span", null, label), control);
}

function openAddToList(m: Msg): void {
  const sheet = openSheet("Add to shopping list");
  const input = h("input", { class: "input", type: "text", maxLength: 80, value: oneLine(m.body, 80), "aria-label": "Item name" });
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        void api("/api/items", { method: "POST", body: { id: crypto.randomUUID(), name } })
          .then(() => {
            sheet.close();
            toast("Added to list");
          })
          .catch((err) => {
            if (isQueued(err)) {
              sheet.close();
              toast("Added to list · will sync when you are online");
            } else toast(errMsg(err), true);
          });
      },
    },
    field("Item", input),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Cancel"), h("button", { class: "btn primary", type: "submit" }, "Add")),
  );
  add(sheet.body, form);
  setTimeout(() => input.focus(), 50);
}

function openMakeTask(m: Msg): void {
  const sheet = openSheet("Make a task");
  const input = h("input", { class: "input", type: "text", maxLength: 120, value: oneLine(m.body, 120), "aria-label": "Task" });
  const selEl = h("select", { class: "input", "aria-label": "Assign to" });
  const sel = selEl as unknown as HTMLElement;
  add(sel, h("option", { value: "" }, "Anyone"));
  for (const mem of session.members) add(sel, h("option", { value: mem.id }, mem.name));
  const nanny = session.members.find((x) => x.role === "nanny");
  selEl.value = nanny?.id ?? session.me?.id ?? "";
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return;
        const body: Record<string, unknown> = { title };
        if (selEl.value) body.assignee_id = selEl.value;
        void api("/api/tasks", { method: "POST", body })
          .then(() => {
            sheet.close();
            toast("Task created", {
              action: {
                label: "View",
                run: () => {
                  location.hash = "#/tasks";
                },
              },
            });
          })
          .catch((err) => toast(errMsg(err), true));
      },
    },
    field("Task", input),
    field("Assign to", sel),
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Cancel"), h("button", { class: "btn primary", type: "submit" }, "Create")),
  );
  add(sheet.body, form);
  setTimeout(() => input.focus(), 50);
}

function scrollToMsg(id: string): boolean {
  const el = msgsEl?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
  return true;
}

function openActions(m: Msg): void {
  const sheet = openSheet("Message");
  const isPinned = pinned.some((p) => p.id === m.id);
  const act = (label: string, fn: () => void, danger = false) =>
    add(
      sheet.body,
      h(
        "button",
        {
          class: "btn block" + (danger ? " danger" : ""),
          type: "button",
          onclick: () => {
            sheet.close();
            fn();
          },
        },
        label,
      ),
    );
  add(sheet.body, h("p", { class: "muted act-preview" }, oneLine(preview(m), 140)));
  if (m.body) {
    act("\u{1F6D2} Add to shopping list", () => openAddToList(m));
    if (isParent()) act("✅ Make a task", () => openMakeTask(m));
  }
  act(isPinned ? "\u{1F4CC} Unpin" : "\u{1F4CC} Pin", () => void setPinned(m, !isPinned));
  if (m.body) act("\u{1F4CB} Copy text", () => void copyText(m.body));
  if (isMine(m)) act("\u{1F5D1} Delete", () => void removeMsg(m), true);
}

function openPinnedSheet(): void {
  if (!pinned.length) return;
  const sheet: Sheet = openSheet("Pinned");
  const fill = () => {
    clear(sheet.body);
    if (!pinned.length) {
      sheet.close();
      return;
    }
    for (const p of pinned) {
      add(
        sheet.body,
        h(
          "div",
          { class: "pin-row" },
          h(
            "button",
            {
              class: "pin-row-main",
              type: "button",
              onclick: () => {
                if (scrollToMsg(p.id)) sheet.close();
              },
            },
            h("span", { class: "pin-row-who" }, `${p.author_name || memberName(p.author_id)} · pinned by ${p.pinned_by_name || "someone"}`),
            h("span", { class: "pin-row-text" }, preview(p)),
          ),
          h("button", { class: "btn small", type: "button", onclick: () => void setPinned(p, false).then(fill) }, "Unpin"),
        ),
      );
    }
  };
  fill();
}

// ---------- sending media ----------
async function postMedia(body: Record<string, unknown>): Promise<void> {
  const r = await api<{ message: Msg }>("/api/messages", { method: "POST", body });
  afterSent(r.message);
}

function addPending(p: Pending): void {
  pending.push(p);
  render();
  toBottom();
}
function dropPending(id: string): void {
  const p = pending.find((x) => x.id === id);
  if (p?.preview) URL.revokeObjectURL(p.preview);
  pending = pending.filter((x) => x.id !== id);
  render();
}

async function sendPhoto(caption: string): Promise<boolean> {
  const file = await pickImage();
  if (!file) return false;
  const id = "p" + Math.random().toString(36).slice(2);
  addPending({ id, kind: "photo", preview: URL.createObjectURL(file) });
  try {
    const blob = await compressImage(file);
    let meta: { w: number; h: number } | undefined;
    try {
      const bmp = await createImageBitmap(blob);
      meta = { w: bmp.width, h: bmp.height };
      bmp.close();
    } catch {
      /* dimensions are optional */
    }
    const up = await uploadMedia(blob);
    await postMedia({ kind: "photo", media_key: up.key, ...(caption ? { body: caption } : {}), ...(meta ? { media_meta: meta } : {}) });
    dropPending(id);
    return true;
  } catch (e) {
    dropPending(id);
    toast(uploadErr(e), true);
    return false;
  }
}

async function sendVoice(blob: Blob, durationMs: number): Promise<void> {
  const id = "v" + Math.random().toString(36).slice(2);
  addPending({ id, kind: "voice" });
  try {
    const typed = blob.type ? blob : new Blob([blob], { type: "audio/webm" });
    const up = await uploadMedia(typed);
    await postMedia({ kind: "voice", media_key: up.key, media_meta: { durationMs: Math.max(1, Math.min(MAX_VOICE_MS, Math.round(durationMs))) } });
    dropPending(id);
  } catch (e) {
    dropPending(id);
    toast(uploadErr(e), true);
  }
}

export async function refresh(): Promise<void> {
  if (!root || !ready || busy) return;
  busy = true;
  const my = gen;
  try {
    const wasNear = nearBottom();
    let fresh: Msg[] = [];
    let extrasChanged = false;
    let guard = 0;
    for (;;) {
      const after = lastCursor;
      const p = await fetchPage(after ? "?after=" + encodeURIComponent(after) : "");
      if (my !== gen || !root) return;
      if (applyExtras(p)) extrasChanged = true;
      fresh = fresh.concat(p.messages);
      if (!after) {
        if (p.messages.length) lastCursor = cur(p.messages[p.messages.length - 1]!);
        break;
      }
      if (p.cursor) lastCursor = p.cursor;
      if (!p.more || ++guard > 10) break;
    }
    let changed = merge(fresh) || extrasChanged;
    // Deletions are invisible to `after`, so now and then compare against the latest window.
    if (++refreshCount % 3 === 0 && !isOffline()) {
      const latest = await fetchPage("");
      if (my !== gen || !root) return;
      if (applyExtras(latest)) changed = true;
      if (latest.messages.length) {
        const ids = new Set(latest.messages.map((m) => m.id));
        const oldest = latest.messages[0]!;
        const stillQueued = queuedIds();
        const keep = msgs.filter((m) => ids.has(m.id) || (m.local ? stillQueued.has(m.id) : m.created_at < oldest.created_at));
        if (keep.length !== msgs.length) {
          msgs = keep;
          changed = true;
        }
        if (merge(latest.messages)) changed = true;
      } else if (msgs.length) {
        msgs = [];
        changed = true;
      }
    }
    if (!changed) return;
    const gotOthers = fresh.some((m) => !isMine(m));
    render();
    if (wasNear) toBottom();
    else if (gotOthers && pillEl) pillEl.hidden = false;
    scheduleRead();
  } finally {
    busy = false;
  }
}

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  const cs = getComputedStyle(ta);
  const lh = parseFloat(cs.lineHeight) || 22;
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  ta.style.height = Math.min(ta.scrollHeight, lh * MAX_LINES + pad) + "px";
}

export function mount(el: HTMLElement): () => void {
  root = el;
  msgs = [];
  reads = [];
  pinned = [];
  pending = [];
  mediaEls.clear();
  olderCursor = null;
  lastCursor = null;
  ready = false;
  busy = false;
  loadingOlder = false;
  refreshCount = 0;
  lastReadPosted = 0;
  sig = "";
  gen++;

  msgsEl = h("div", { class: "msgs", role: "log", "aria-live": "polite" });
  typingEl = h("div", { class: "typing", "aria-live": "polite" });
  pillEl = h("button", { class: "new-pill", type: "button", hidden: true, onclick: toBottom }, "New messages ↓");
  pinBar = h("button", { class: "pin-bar", type: "button", hidden: true, "aria-label": "Pinned messages", onclick: openPinnedSheet });

  const ta = h("textarea", { class: "input composer-in", rows: 1, maxLength: 2000, placeholder: "Message…", "aria-label": "Message", enterKeyHint: "send" });
  const sendBtn = h("button", { class: "btn primary send", type: "submit", disabled: true, "aria-label": "Send" }, "Send ➤");
  const micBtn = h("button", { class: "btn mic", type: "button", "aria-label": "Record voice note", hidden: true }, "\u{1F3A4}");
  const camBtn = h("button", { class: "btn cam", type: "button", "aria-label": "Send a photo" }, "\u{1F4F7}");
  let sending = false;
  let recording = false;
  const useMic = voiceSupported();
  const sync = () => {
    const empty = !ta.value.trim();
    const showMic = useMic && empty;
    micBtn.hidden = !showMic;
    sendBtn.hidden = showMic;
    sendBtn.disabled = sending || empty;
    camBtn.disabled = sending;
    const off = isOffline();
    for (const [b, what] of [[camBtn, "Photos"], [micBtn, "Voice notes"]] as const) {
      b.classList.toggle("off", off);
      b.setAttribute("aria-disabled", off ? "true" : "false");
      b.title = off ? `${what} need a connection` : "";
    }
  };
  const doSend = async () => {
    const text = ta.value.trim();
    if (!text || sending) return;
    sending = true;
    sync();
    try {
      await send(text);
      ta.value = "";
      autoGrow(ta);
    } catch (e) {
      toast(errMsg(e), true);
    } finally {
      sending = false;
      sync();
      ta.focus();
    }
  };
  camBtn.addEventListener("click", () => {
    if (sending) return;
    if (isOffline()) return void toast("You are offline · photos need a connection", true);
    const caption = ta.value.trim().slice(0, 2000);
    sending = true;
    sync();
    void sendPhoto(caption)
      .then((ok) => {
        if (ok && caption) {
          ta.value = "";
          autoGrow(ta);
        }
      })
      .finally(() => {
        sending = false;
        sync();
      });
  });
  ta.addEventListener("input", () => {
    autoGrow(ta);
    sync();
    if (ta.value) sendTyping();
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void doSend();
    }
  });
  const form = h(
    "form",
    {
      class: "composer",
      onsubmit: (e: Event) => {
        e.preventDefault();
        void doSend();
      },
    },
    camBtn,
    ta,
    micBtn,
    sendBtn,
  );

  // ---- voice recording bar ----
  let rec: VoiceRecording | null = null;
  let recT0 = 0;
  let recTimer: ReturnType<typeof setInterval> | null = null;
  const recTime = h("span", { class: "rec-time" }, "0:00");
  const recBar = h(
    "div",
    { class: "recbar", hidden: true, role: "group", "aria-label": "Recording voice note" },
    h("button", { class: "btn rec-cancel", type: "button", "aria-label": "Cancel recording", onclick: () => void finishRec(false) }, "✕"),
    h("span", { class: "rec-dot", "aria-hidden": "true" }),
    recTime,
    h("span", { class: "rec-hint" }, "Recording…"),
    h("button", { class: "btn primary send rec-send", type: "button", "aria-label": "Send voice note", onclick: () => void finishRec(true) }, "➤"),
  );
  const showRecUI = (on: boolean) => {
    recBar.hidden = !on;
    form.hidden = on;
  };
  const stopTimer = () => {
    if (recTimer) clearInterval(recTimer);
    recTimer = null;
  };
  async function finishRec(doSendIt: boolean): Promise<void> {
    const r = rec;
    if (!r) return;
    rec = null;
    recording = false;
    stopTimer();
    showRecUI(false);
    if (!doSendIt) {
      r.cancel();
      return;
    }
    try {
      const out = await r.stop();
      if (out.durationMs < MIN_VOICE_MS || !out.blob.size) {
        toast("Hold a little longer to record");
        return;
      }
      await sendVoice(out.blob, out.durationMs);
    } catch {
      toast("Could not send", true);
    }
  }
  micBtn.addEventListener("click", () => {
    if (recording) return;
    if (isOffline()) return void toast("You are offline · voice notes need a connection", true);
    recording = true;
    void recordVoice()
      .then((r) => {
        if (!root) {
          r.cancel();
          return;
        }
        rec = r;
        recT0 = Date.now();
        recTime.textContent = "0:00";
        showRecUI(true);
        recTimer = setInterval(() => {
          const ms = Date.now() - recT0;
          recTime.textContent = fmtDur(ms);
          if (ms >= MAX_VOICE_MS) void finishRec(true);
        }, 250);
      })
      .catch((e: unknown) => {
        recording = false;
        const n = e instanceof Error ? e.name : "";
        toast(n === "NotAllowedError" || n === "SecurityError" ? "Microphone access was denied" : n === "NotFoundError" ? "No microphone found" : "Could not start recording", true);
      });
  });

  // ---- message actions: right-click or long-press on any message ----
  const target = (e: Event): Msg | null => {
    const node = (e.target as Element | null)?.closest(".msg[data-id]");
    const id = node?.getAttribute("data-id");
    return id ? (msgs.find((m) => m.id === id) ?? null) : null;
  };
  let lp: ReturnType<typeof setTimeout> | null = null;
  let lpFired = false;
  const cancelLp = () => {
    if (lp) clearTimeout(lp);
    lp = null;
  };
  msgsEl.addEventListener("contextmenu", (e) => {
    const m = target(e);
    if (!m) return;
    e.preventDefault();
    if (lpFired) {
      lpFired = false;
      return;
    }
    openActions(m);
  });
  msgsEl.addEventListener(
    "touchstart",
    (e) => {
      const m = target(e);
      cancelLp();
      lpFired = false;
      if (!m) return;
      lp = setTimeout(() => {
        lp = null;
        lpFired = true;
        openActions(m);
      }, LONG_PRESS_MS);
    },
    { passive: true },
  );
  msgsEl.addEventListener("touchmove", cancelLp, { passive: true });
  msgsEl.addEventListener("touchend", cancelLp);
  msgsEl.addEventListener("touchcancel", cancelLp);
  msgsEl.addEventListener(
    "scroll",
    () => {
      if (pillEl && !pillEl.hidden && nearBottom()) pillEl.hidden = true;
    },
    { passive: true },
  );

  const onVis = () => {
    if (!document.hidden) scheduleRead();
  };
  document.addEventListener("visibilitychange", onVis);

  unsubLive = onEvent((e) => {
    if (e.type !== "typing" || e.memberId === session.me?.id) return;
    const old = typers.get(e.memberId);
    if (old) clearTimeout(old);
    typers.set(
      e.memberId,
      setTimeout(() => {
        typers.delete(e.memberId);
        paintTyping();
      }, TYPING_MS),
    );
    paintTyping();
  });

  sync();
  unsubNet = onNetworkChange(sync);
  unsubOutbox = onOutboxChange(() => render());
  el.replaceChildren(h("div", { class: "view chat" }, pinBar, h("div", { class: "msgs-wrap" }, msgsEl, pillEl), typingEl, form, recBar));
  void loadInitial().catch((e) => toast(errMsg(e), true));

  return () => {
    gen++;
    root = null;
    ready = false;
    unsubLive?.();
    unsubLive = null;
    unsubNet?.();
    unsubNet = null;
    unsubOutbox?.();
    unsubOutbox = null;
    document.removeEventListener("visibilitychange", onVis);
    cancelLp();
    stopTimer();
    rec?.cancel();
    rec = null;
    if (readTimer) clearTimeout(readTimer);
    readTimer = null;
    for (const p of pending) if (p.preview) URL.revokeObjectURL(p.preview);
    pending = [];
    stopAllAudio();
    closeViewer();
    mediaEls.clear();
    for (const t of typers.values()) clearTimeout(t);
    typers.clear();
    msgsEl = typingEl = pillEl = pinBar = null;
    el.replaceChildren();
  };
}

export const view: View = { mount, refresh };
