import { ApiError, api, isOffline, isQueued, onNetworkChange } from "../lib/api";
import { add, clear, h } from "../lib/dom";
import { onEvent, sendTyping } from "../lib/live";
import { MAX_VIDEO_BYTES, MAX_VIDEO_MS, compressImage, pickImage, pickVideo, readVideoMeta, recordVoice, uploadMedia, videoType, voiceSupported, type VoiceRecording } from "../lib/media";
import { onOutboxChange, queuedEntries, queuedIds } from "../lib/outbox";
import { takeFocus } from "../lib/router";
import { isParent, memberName, session } from "../lib/session";
import { undoToast } from "../lib/trash";
import { confirmDialog, openSheet, toast, type Sheet } from "../lib/ui";
import { closeViewer, fmtDur, locationEl, pendingNoteEl, pendingPhotoEl, pendingVoiceEl, photoEl, stopAllAudio, videoEl, voiceEl } from "./chat-media";
import "./views.css";
import "./chat.css";
import type { View } from "./types";

interface Msg {
  id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: number;
  kind: "text" | "photo" | "voice" | "video" | "location";
  media_key: string | null;
  media_meta: { w?: number; h?: number; durationMs?: number; lat?: number; lng?: number; acc?: number } | null;
  pinned_at: number | null;
  /** Set when the author changed the text after sending. */
  edited_at?: number | null;
  /** The message this one answers (a short copy of it), or null. */
  reply?: ReplyRef | null;
  /** Created on this device while offline (or not yet confirmed by the server); replaced by the server row with the same id. */
  local?: boolean;
}
interface ReplyRef {
  id: string;
  author_id?: string;
  author_name?: string;
  body?: string;
  kind?: string;
  deleted?: boolean;
}
interface Reaction {
  message_id: string;
  member_id: string;
  emoji: string;
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
  reactions?: Reaction[];
  edits?: { id: string; body: string; edited_at: number }[];
}
interface Pending {
  id: string;
  kind: "photo" | "voice" | "video" | "location";
  preview?: string;
}

const GROUP_MS = 5 * 60 * 1000;
const TYPING_MS = 4000;
const LONG_PRESS_MS = 550;
const MAX_LINES = 5;
const READ_DEBOUNCE_MS = 1000;
const MAX_VOICE_MS = 120_000;
const MIN_VOICE_MS = 700;
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];
const SEARCH_DEBOUNCE_MS = 300;
/** Matches the server: your own text messages can be edited for 15 minutes. */
const EDIT_WINDOW_MS = 15 * 60_000;

let root: HTMLElement | null = null;
let msgs: Msg[] = [];
let reads: ReadRow[] = [];
let pinned: PinnedMsg[] = [];
let reactions: Reaction[] = [];
/** My pending "remind me" times by message id. */
const myReminders = new Map<string, number>();
/** The message being answered; shown above the composer until sent or cancelled. */
let replyTo: Msg | null = null;
let replyBar: HTMLElement | null = null;
let composer: HTMLTextAreaElement | null = null;
let pending: Pending[] = [];
let olderCursor: string | null = null;
let lastCursor: string | null = null;
let ready = false;
let busy = false;
let loadingOlder = false;
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
  if (m.kind === "video") return "\u{1F3A5} " + (m.body || "Video");
  if (m.kind === "location") return "\u{1F4CD} Location";
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
      // Their message arrived, so they have stopped typing it.
      const t = !old ? typers.get(m.author_id) : undefined;
      if (t !== undefined) {
        clearTimeout(t);
        typers.delete(m.author_id);
        paintTyping();
      }
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
  for (const e of p.edits ?? []) {
    const m = msgs.find((x) => x.id === e.id);
    if (m && (m.edited_at ?? 0) < e.edited_at) {
      msgs = msgs.map((x) => (x.id === e.id ? { ...x, body: e.body, edited_at: e.edited_at } : x));
      changed = true;
    }
  }
  if (p.reactions && JSON.stringify(p.reactions) !== JSON.stringify(reactions)) {
    reactions = p.reactions;
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
    el = m.kind === "photo" ? photoEl(m) : m.kind === "video" ? videoEl(m) : m.kind === "location" ? locationEl(m) : voiceEl(m);
    mediaEls.set(m.id, el);
  }
  return el;
}

function render(): void {
  if (!msgsEl) return;
  const seen = seenText();
  const pinIds = new Set(pinned.map((p) => p.id));
  waiting = queuedIds();
  const s = JSON.stringify([msgs.map((m) => m.id + ":" + (m.edited_at ?? "")), olderCursor !== null, [...pinIds], seen, pending.map((p) => p.id), [...waiting], reactions]);
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
    const isMedia = m.kind !== "text";
    add(
      msgsEl,
      h(
        "div",
        { class: "msg " + (mine ? "mine" : "theirs") + (start ? " first" : ""), "data-id": m.id },
        !mine && start ? h("div", { class: "author" }, m.author_name || memberName(m.author_id)) : null,
        h(
          "div",
          { class: "bubble" + (isMedia ? " media " + m.kind : "") },
          m.reply ? quoteEl(m.reply) : null,
          isMedia ? mediaFor(m) : null,
          m.body ? h("span", { class: "text" }, m.body) : null,
          h("span", { class: "time" }, pinIds.has(m.id) ? h("span", { class: "pin-ico", "aria-label": "Pinned" }, "\u{1F4CC} ") : null, m.local && waiting.has(m.id) ? h("span", { class: "wait-clock", title: "Waiting to send", "aria-label": "Waiting to send" }, "⏳") : (m.edited_at ? "edited · " : "") + timeLabel(m.created_at)),
        ),
        reactionsEl(m),
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
        h("div", { class: "bubble media " + p.kind }, pendingEl(p)),
      ),
    );
  }
  msgsEl.scrollTop = top;
}

function pendingEl(p: Pending): HTMLElement {
  if (p.kind === "photo") return pendingPhotoEl(p.preview ?? "");
  if (p.kind === "video") return pendingNoteEl("Sending video…");
  if (p.kind === "location") return pendingNoteEl("Finding your location…");
  return pendingVoiceEl();
}

function paintTyping(): void {
  if (!typingEl) return;
  const names = [...typers.keys()].map(memberName);
  typingEl.textContent = names.length === 0 ? "" : names.length === 1 ? `${names[0]} is typing…` : `${names.join(" and ")} are typing…`;
}

function refPreview(r: ReplyRef): string {
  if (r.deleted) return "Message deleted";
  if (r.kind === "photo") return "\u{1F4F7} " + (r.body || "Photo");
  if (r.kind === "voice") return "\u{1F3A4} Voice note";
  if (r.kind === "video") return "\u{1F3A5} " + (r.body || "Video");
  if (r.kind === "location") return "\u{1F4CD} Location";
  return r.body ?? "";
}

/** The quoted message at the top of a reply; tap to jump to it. */
function quoteEl(r: ReplyRef): HTMLElement {
  return h(
    "button",
    { class: "quote", type: "button", onclick: () => void jumpTo(r.id), "aria-label": "Go to the quoted message" },
    r.deleted ? null : h("span", { class: "quote-who" }, r.author_id === session.me?.id ? "You" : r.author_name || memberName(r.author_id ?? "")),
    h("span", { class: "quote-text" }, oneLine(refPreview(r), 140)),
  );
}

/** Reaction chips under a bubble: one per emoji with a count; tap to add or take back yours. */
function reactionsEl(m: Msg): HTMLElement | null {
  const mine = session.me?.id;
  const groups = new Map<string, string[]>();
  for (const r of reactions) if (r.message_id === m.id) groups.set(r.emoji, [...(groups.get(r.emoji) ?? []), r.member_id]);
  if (!groups.size) return null;
  return h(
    "div",
    { class: "reacts" },
    [...groups].map(([emoji, who]) => {
      const me = !!mine && who.includes(mine);
      const names = who.map((id) => (id === mine ? "You" : memberName(id))).join(", ");
      return h(
        "button",
        { class: "react-chip" + (me ? " on" : ""), type: "button", title: names, "aria-label": `${emoji} by ${names}`, onclick: () => void react(m, me ? null : emoji) },
        emoji,
        who.length > 1 ? h("span", { class: "react-n" }, String(who.length)) : null,
      );
    }),
  );
}

async function react(m: Msg, emoji: string | null): Promise<void> {
  const me = session.me?.id;
  if (!me || m.local) return;
  const before = reactions;
  reactions = reactions.filter((r) => !(r.message_id === m.id && r.member_id === me));
  if (emoji) reactions = [...reactions, { message_id: m.id, member_id: me, emoji }];
  render();
  try {
    await api(`/api/messages/${m.id}/reaction`, { method: "PUT", body: { emoji } });
  } catch (e) {
    reactions = before;
    render();
    toast(errMsg(e), true);
  }
}

function paintReply(): void {
  if (!replyBar) return;
  replyBar.hidden = !replyTo;
  clear(replyBar);
  if (!replyTo) return;
  const r = replyTo;
  add(
    replyBar,
    h(
      "div",
      { class: "reply-main" },
      h("span", { class: "quote-who" }, "↩ Replying to " + (isMine(r) ? "yourself" : r.author_name || memberName(r.author_id))),
      h("span", { class: "quote-text" }, oneLine(preview(r), 140)),
    ),
    h("button", { class: "btn small ghost", type: "button", "aria-label": "Cancel reply", onclick: () => setReply(null) }, "✕"),
  );
}

function setReply(m: Msg | null): void {
  replyTo = m;
  paintReply();
  if (m) composer?.focus();
}

const refOf = (m: Msg): ReplyRef => ({ id: m.id, author_id: m.author_id, author_name: m.author_name, body: m.body.slice(0, 140), kind: m.kind });

/** Scroll to a message, loading older pages if it is not on screen yet. */
async function jumpTo(id: string): Promise<void> {
  if (scrollToMsg(id)) return;
  for (let i = 0; i < 30 && olderCursor !== null && root; i++) {
    await loadOlder();
    if (scrollToMsg(id)) return;
  }
  toast("That message is no longer in the chat");
}

function highlighted(text: string, q: string): (HTMLElement | string)[] {
  const out: (HTMLElement | string)[] = [];
  const lo = text.toLowerCase();
  const lq = q.toLowerCase();
  let i = 0;
  for (;;) {
    const j = lq ? lo.indexOf(lq, i) : -1;
    if (j < 0) break;
    if (j > i) out.push(text.slice(i, j));
    out.push(h("mark", null, text.slice(j, j + q.length)));
    i = j + q.length;
  }
  out.push(text.slice(i));
  return out;
}

function openSearch(): void {
  const sheet = openSheet("Search messages");
  const input = h("input", { class: "input", type: "search", maxLength: 100, placeholder: "Search…", "aria-label": "Search messages", enterKeyHint: "search" });
  const results = h("div", { class: "search-results", role: "list" });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  const run = async (): Promise<void> => {
    const q = input.value.trim();
    const my = ++seq;
    clear(results);
    if (q.length < 2) return;
    try {
      const r = await api<{ messages: Msg[] }>("/api/messages/search?q=" + encodeURIComponent(q));
      if (my !== seq) return;
      if (!r.messages.length) return void add(results, h("p", { class: "muted" }, "Nothing found"));
      for (const m of r.messages) {
        const at = m.body.toLowerCase().indexOf(q.toLowerCase());
        const from = Math.max(0, at - 40);
        const snippet = (from ? "…" : "") + m.body.slice(from, from + 160) + (m.body.length > from + 160 ? "…" : "");
        add(
          results,
          h(
            "button",
            {
              class: "search-row",
              type: "button",
              role: "listitem",
              onclick: () => {
                sheet.close();
                void jumpTo(m.id);
              },
            },
            h("span", { class: "pin-row-who" }, `${isMine(m) ? "You" : m.author_name || memberName(m.author_id)} · ${dayLabel(m.created_at)} ${timeLabel(m.created_at)}`),
            h("span", { class: "pin-row-text" }, highlighted(snippet, q)),
          ),
        );
      }
    } catch (e) {
      if (my === seq) add(results, h("p", { class: "error" }, errMsg(e)));
    }
  };
  input.addEventListener("input", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (timer) clearTimeout(timer);
      void run();
    }
  });
  add(sheet.body, input, results);
  setTimeout(() => input.focus(), 50);
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
  reactions = p.reactions ?? [];
  olderCursor = p.more ? p.cursor : null;
  lastCursor = msgs.length ? cur(msgs[msgs.length - 1]!) : null;
  addQueuedMessages();
  ready = true;
  paintPin();
  render();
  toBottom();
  scheduleRead();
  const focus = takeFocus("chat"); // a notification tap ("#/chat/<id>"): show that message instead of the bottom
  if (focus) void jumpTo(focus);
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

function localMsg(id: string, body: string, at: number, reply: ReplyRef | null = null): Msg {
  const me = session.me;
  return {
    reply,
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
    const b = (e.body && typeof e.body === "object" ? e.body : {}) as { id?: unknown; body?: unknown; reply_to?: unknown };
    const id = String(b.id ?? "");
    const q = typeof b.reply_to === "string" ? msgs.find((m) => m.id === b.reply_to) : undefined;
    const ref = typeof b.reply_to === "string" ? (q ? refOf(q) : { id: b.reply_to }) : null;
    if (id && !msgs.some((m) => m.id === id)) msgs = [...msgs, localMsg(id, String(b.body ?? ""), e.at, ref)];
  }
}

async function send(text: string): Promise<void> {
  const id = crypto.randomUUID(); // the server stores the row under this id, so the optimistic bubble reconciles by id
  const rt = replyTo;
  try {
    const r = await api<{ message: Msg }>("/api/messages", { method: "POST", body: { id, body: text, ...(rt ? { reply_to: rt.id } : {}) } });
    if (replyTo === rt) setReply(null);
    afterSent(r.message);
  } catch (e) {
    if (!isQueued(e)) throw e;
    if (replyTo === rt) setReply(null);
    // Offline: show the bubble now with a clock. lastCursor is NOT advanced, so messages from others that
    // arrived meanwhile are still fetched by the next "after" refresh.
    merge([localMsg(id, text, Date.now(), rt ? refOf(rt) : null)]);
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
const canEdit = (m: Msg): boolean => isMine(m) && m.kind === "text" && !m.local && Date.now() - m.created_at < EDIT_WINDOW_MS;

function openEditMsg(m: Msg): void {
  const sheet = openSheet("Edit message");
  const ta = h("textarea", { class: "input", rows: 3, maxLength: 2000, "aria-label": "Message text" });
  ta.value = m.body;
  const err = h("p", { class: "error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, "Save");
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const body = ta.value.trim();
        if (!body) return void (err.textContent = "The message can't be empty");
        if (body === m.body) return sheet.close();
        save.disabled = true;
        try {
          const r = await api<{ message: Msg }>("/api/messages/" + m.id, { method: "PATCH", body: { body } });
          msgs = msgs.map((x) => (x.id === m.id ? { ...x, body: r.message.body, edited_at: r.message.edited_at } : x));
          render();
          sheet.close();
        } catch (ex) {
          err.textContent = ex instanceof ApiError && ex.code === "too_late" ? "Messages can only be edited for 15 minutes" : errMsg(ex);
          save.disabled = false;
        }
      },
    },
    h("label", { class: "field" }, ta),
    err,
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Cancel"), save),
  );
  add(sheet.body, form);
  setTimeout(() => {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, 50);
}

async function removeMsg(m: Msg): Promise<void> {
  if (!(await confirmDialog("Delete this message for everyone?", "Delete", true))) return;
  try {
    const r = await api<{ trash_id?: string }>("/api/messages/" + m.id, { method: "DELETE" });
    // A restored message keeps its original time, so reload the window rather than fetching "newer than".
    undoToast("message", r.trash_id ? [r.trash_id] : undefined, () => void loadInitial().catch(() => undefined));
    msgs = msgs.filter((x) => x.id !== m.id);
    pinned = pinned.filter((x) => x.id !== m.id);
    reactions = reactions.filter((r) => r.message_id !== m.id);
    if (replyTo?.id === m.id) setReply(null);
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

/** The time of my pending reminder on a message, or null. */
const reminderAt = (id: string): number | null => {
  const at = myReminders.get(id);
  return at !== undefined && at > Date.now() ? at : null;
};

function whenText(at: number): string {
  const d = new Date(at);
  const day = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === day.toDateString()) return "today " + time;
  day.setDate(day.getDate() + 1);
  if (d.toDateString() === day.toDateString()) return "tomorrow " + time;
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + " " + time;
}

/** A local date-time as the value of a datetime-local input ("2026-01-31T18:00"). */
function localInputValue(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function openRemindSheet(m: Msg): void {
  const sheet = openSheet("Remind me");
  const set = async (at: number) => {
    try {
      await api("/api/messages/" + m.id + "/remind", { method: "PUT", body: { at } });
      myReminders.set(m.id, at);
      sheet.close();
      toast("Reminder set for " + whenText(at));
    } catch (e) {
      toast(e instanceof ApiError && e.code === "bad_at" ? "Pick a time in the future (within 30 days)" : errMsg(e), true);
    }
  };
  const at = (hour: number, daysAhead: number): number => {
    const d = new Date();
    d.setDate(d.getDate() + daysAhead);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };
  const choices: [string, number][] = [["In 1 hour", Date.now() + 3_600_000]];
  choices.push(new Date().getHours() < 18 ? ["This evening (6 PM)", at(18, 0)] : ["Tomorrow evening (6 PM)", at(18, 1)]);
  choices.push(["Tomorrow morning (9 AM)", at(9, 1)]);
  for (const [label, t] of choices) add(sheet.body, h("button", { class: "btn block", type: "button", onclick: () => void set(t) }, label));
  const input = h("input", {
    class: "input",
    type: "datetime-local",
    min: localInputValue(Date.now() + 60_000),
    value: localInputValue(Date.now() + 3_600_000),
    "aria-label": "Custom time",
  });
  add(
    sheet.body,
    h(
      "form",
      {
        class: "stack",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const t = new Date(input.value).getTime();
          if (Number.isNaN(t) || t < Date.now() + 60_000) return void toast("Pick a time in the future", true);
          void set(t);
        },
      },
      field("Or pick a time", input),
      h("div", { class: "actions" }, h("button", { class: "btn primary", type: "submit" }, "Set")),
    ),
  );
  if (reminderAt(m.id) !== null) {
    add(
      sheet.body,
      h(
        "button",
        {
          class: "btn block danger",
          type: "button",
          onclick: () => {
            void api("/api/messages/" + m.id + "/remind", { method: "DELETE" })
              .then(() => {
                myReminders.delete(m.id);
                sheet.close();
                toast("Reminder cancelled");
              })
              .catch((e) => toast(errMsg(e), true));
          },
        },
        "Cancel reminder",
      ),
    );
  }
}

/** "Seen by" / "Not seen yet" lines for one of my own messages. */
function seenBy(m: Msg): HTMLElement | null {
  const others = session.members.filter((x) => x.id !== session.me?.id);
  if (!others.length) return null;
  const hasSeen = (id: string): boolean => reads.some((r) => r.member_id === id && r.read_at >= m.created_at);
  const seen = others.filter((x) => hasSeen(x.id)).map((x) => x.name);
  const not = others.filter((x) => !hasSeen(x.id)).map((x) => x.name);
  const lines: string[] = [];
  if (seen.length) lines.push("Seen by: " + seen.join(", "));
  if (not.length) lines.push(seen.length ? "Not seen yet: " + not.join(", ") : "Not seen yet");
  return h("div", { class: "muted act-seen" }, ...lines.map((l) => h("p", null, l)));
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
  const seenEl = isMine(m) && !m.local ? seenBy(m) : null;
  if (seenEl) add(sheet.body, seenEl);
  add(sheet.body, h("p", { class: "muted act-preview" }, oneLine(preview(m), 140)));
  if (!m.local) {
    const myEmoji = reactions.find((r) => r.message_id === m.id && r.member_id === session.me?.id)?.emoji ?? null;
    add(
      sheet.body,
      h(
        "div",
        { class: "react-pick", role: "group", "aria-label": "React" },
        REACTIONS.map((e) =>
          h(
            "button",
            {
              class: "react-opt" + (e === myEmoji ? " on" : ""),
              type: "button",
              "aria-label": (e === myEmoji ? "Remove reaction " : "React ") + e,
              "aria-pressed": String(e === myEmoji),
              onclick: () => {
                sheet.close();
                void react(m, e === myEmoji ? null : e);
              },
            },
            e,
          ),
        ),
      ),
    );
    act("↩ Reply", () => setReply(m));
  }
  if (m.body) {
    act("\u{1F6D2} Add to shopping list", () => openAddToList(m));
    if (isParent()) act("✅ Make a task", () => openMakeTask(m));
  }
  if (!m.local) {
    const rem = reminderAt(m.id);
    act(rem === null ? "⏰ Remind me" : `⏰ Reminder: ${whenText(rem)} · change`, () => openRemindSheet(m));
  }
  act(isPinned ? "\u{1F4CC} Unpin" : "\u{1F4CC} Pin", () => void setPinned(m, !isPinned));
  if (canEdit(m)) act("✏️ Edit", () => openEditMsg(m));
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
  const rt = replyTo;
  const r = await api<{ message: Msg }>("/api/messages", { method: "POST", body: rt ? { ...body, reply_to: rt.id } : body });
  if (replyTo === rt) setReply(null);
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

async function sendVideo(caption: string): Promise<boolean> {
  const file = await pickVideo();
  if (!file) return false;
  const type = videoType(file);
  if (!type) {
    toast("That video format is not supported", true);
    return false;
  }
  if (file.size > MAX_VIDEO_BYTES) {
    toast("That video is too large", true);
    return false;
  }
  const id = "c" + Math.random().toString(36).slice(2);
  addPending({ id, kind: "video" });
  try {
    const info = await readVideoMeta(file).catch(() => null);
    if (!info) throw new Error("video_unreadable");
    // Phones label a clip "0:30" when it is 30.03 s long: allow half a second over, then report at most 30 s.
    if (info.durationMs > MAX_VIDEO_MS + 500) {
      dropPending(id);
      toast("Videos can be up to 30 seconds", true);
      return false;
    }
    const up = await uploadMedia(type === file.type ? file : new Blob([file], { type }));
    const dims = info.w > 0 && info.h > 0 && info.w <= 20_000 && info.h <= 20_000 ? { w: info.w, h: info.h } : {};
    await postMedia({ kind: "video", media_key: up.key, ...(caption ? { body: caption } : {}), media_meta: { durationMs: Math.max(1, Math.min(MAX_VIDEO_MS, Math.round(info.durationMs))), ...dims } });
    dropPending(id);
    return true;
  } catch (e) {
    dropPending(id);
    const c = e instanceof Error ? e.message : "";
    toast(c === "too_large" ? "That video is too large" : c === "video_unreadable" ? "Could not read that video" : uploadErr(e), true);
    return false;
  }
}

/** One GPS fix, asked for only now (the browser shows its own permission prompt the first time). */
function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("unsupported"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 });
  });
}

function geoErr(e: unknown): string {
  const code = (e as Partial<GeolocationPositionError> | null)?.code;
  if (code === 1) return "Location access was denied";
  if (code === 3) return "Finding your location took too long";
  if (e instanceof Error && e.message === "unsupported") return "Location is not available on this device";
  return "Could not find your location";
}

async function sendLocation(): Promise<boolean> {
  if (!(await confirmDialog("Send your current location to the family chat?", "Send"))) return false;
  const id = "l" + Math.random().toString(36).slice(2);
  addPending({ id, kind: "location" });
  let pos: GeolocationPosition;
  try {
    pos = await currentPosition();
  } catch (e) {
    dropPending(id);
    toast(geoErr(e), true);
    return false;
  }
  try {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    await postMedia({ kind: "location", media_meta: { lat, lng, ...(Number.isFinite(accuracy) ? { acc: Math.min(100_000, Math.round(accuracy)) } : {}) } });
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
    // Deletions and restores (which keep their original time) are invisible to `after`, so also compare
    // against the latest window on every update: deleted-for-everyone messages vanish right away.
    if (!isOffline()) {
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

async function loadReminders(my: number): Promise<void> {
  try {
    const r = await api<{ reminders: { message_id: string; remind_at: number }[] }>("/api/reminders");
    if (my !== gen) return;
    myReminders.clear();
    for (const x of r.reminders) myReminders.set(x.message_id, x.remind_at);
  } catch {
    /* offline: the action just reads "Remind me" */
  }
}

export function mount(el: HTMLElement): () => void {
  root = el;
  msgs = [];
  reads = [];
  pinned = [];
  reactions = [];
  replyTo = null;
  pending = [];
  mediaEls.clear();
  olderCursor = null;
  lastCursor = null;
  ready = false;
  busy = false;
  loadingOlder = false;
  lastReadPosted = 0;
  sig = "";
  gen++;

  msgsEl = h("div", { class: "msgs", role: "log", "aria-live": "polite" });
  typingEl = h("div", { class: "typing", "aria-live": "polite" });
  pillEl = h("button", { class: "new-pill", type: "button", hidden: true, onclick: toBottom }, "New messages ↓");
  pinBar = h("button", { class: "pin-bar", type: "button", hidden: true, "aria-label": "Pinned messages", onclick: openPinnedSheet });

  const ta = h("textarea", { class: "input composer-in", rows: 1, maxLength: 2000, placeholder: "Message…", "aria-label": "Message", enterKeyHint: "send" });
  composer = ta;
  replyBar = h("div", { class: "reply-bar", hidden: true });
  const searchBtn = h("button", { class: "btn small search-btn", type: "button", "aria-label": "Search messages", onclick: openSearch }, "\u{1F50D}");
  const sendBtn = h("button", { class: "btn primary send", type: "submit", disabled: true, "aria-label": "Send" }, "Send ➤");
  const micBtn = h("button", { class: "btn mic", type: "button", "aria-label": "Record voice note", hidden: true }, "\u{1F3A4}");
  const attachBtn = h("button", { class: "btn cam attach", type: "button", "aria-label": "Attach" }, "＋");
  let sending = false;
  let recording = false;
  const useMic = voiceSupported();
  const sync = () => {
    const empty = !ta.value.trim();
    const showMic = useMic && empty;
    micBtn.hidden = !showMic;
    sendBtn.hidden = showMic;
    sendBtn.disabled = sending || empty;
    attachBtn.disabled = sending;
    const off = isOffline();
    for (const [b, what] of [[attachBtn, "Photos, videos and locations"], [micBtn, "Voice notes"]] as const) {
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
  // Runs one attach job with the composer locked; the text box becomes the caption of a photo or video.
  const attach = (job: (caption: string) => Promise<boolean>, usesCaption = true): void => {
    if (sending) return;
    const caption = ta.value.trim().slice(0, 2000);
    sending = true;
    sync();
    void job(caption)
      .then((ok) => {
        if (ok && usesCaption && caption) {
          ta.value = "";
          autoGrow(ta);
        }
      })
      .finally(() => {
        sending = false;
        sync();
      });
  };
  attachBtn.addEventListener("click", () => {
    if (sending) return;
    if (isOffline()) return void toast("You are offline · photos, videos and locations need a connection", true);
    const sheet = openSheet("Attach");
    const opt = (label: string, run: () => void) =>
      add(
        sheet.body,
        h(
          "button",
          {
            class: "btn block attach-opt",
            type: "button",
            onclick: () => {
              sheet.close();
              run();
            },
          },
          label,
        ),
      );
    opt("\u{1F4F7} Photo", () => attach(sendPhoto));
    opt("\u{1F3A5} Video (up to 30 s)", () => attach(sendVideo));
    opt("\u{1F4CD} My location", () => attach(() => sendLocation(), false));
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
    attachBtn,
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
  el.replaceChildren(
    h("div", { class: "view chat" }, h("div", { class: "chat-top" }, pinBar, searchBtn), h("div", { class: "msgs-wrap" }, msgsEl, pillEl), typingEl, replyBar, form, recBar),
  );
  void loadInitial().catch((e) => toast(errMsg(e), true));
  void loadReminders(gen);

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
    replyBar = null;
    composer = null;
    replyTo = null;
    el.replaceChildren();
  };
}

export const view: View = { mount, refresh };
