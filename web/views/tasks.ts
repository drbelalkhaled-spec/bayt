import { ApiError, api, isQueued } from "../lib/api";
import { add, clear, h } from "../lib/dom";
import { compressImage, mediaUrl, pickImage, uploadMedia } from "../lib/media";
import { onEvent } from "../lib/live";
import { onOutboxChange, queuedEntries, queuedIds } from "../lib/outbox";
import { isParent, session } from "../lib/session";
import { kvGet, kvSet } from "../lib/store";
import { undoToast } from "../lib/trash";
import { confirmDialog, openSheet, timeAgo, toast } from "../lib/ui";
import "./views.css";
import "./tasks.css";
import {
  DAY_SHORT,
  SLOTS,
  addDaysStr,
  openRoutineManager,
  recurChip,
  todayStr,
  type Recur,
  type Task,
} from "./routine";
import type { View } from "./types";

interface TasksResponse {
  open: Task[];
  done: Task[];
}

let root: HTMLElement | null = null;
let open: Task[] = [];
let done: Task[] = [];
let mine = false;
let sig = "";
let pending = 0;
let loaded = false;
let showUpcoming = false;
let bodyEl: HTMLElement | null = null;
let segEl: HTMLElement | null = null;
let tick: ReturnType<typeof setInterval> | null = null;
let gen = 0;
/** Task ids with a change still waiting in the offline outbox. */
let waiting = new Set<string>();
let unsubOutbox: (() => void) | null = null;
/** When this device last opened each task's questions (task id -> ms), so new replies stand out. */
let readQs: Record<string, number> = {};
const READ_QS_KEY = "taskQsRead";

const BLOCK_CHIPS = ["Out of supplies", "No time", "Need help", "Kids needed me"];

const errMsg = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (e.code === "network") return "You are offline";
    if (e.status === 403) return "Not allowed";
    if (e.code === "too_large") return "That photo is too large";
  }
  if (e instanceof Error && e.message === "network") return "You are offline";
  return "Something went wrong";
};

/** When a task was posted, in the chat's clock style: "Today 10:32 AM", "Yesterday …", "12 Oct, …". */
function postedLabel(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (x: Date): string => x.toDateString();
  const now = new Date();
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (day(d) === day(now)) return "Today " + time;
  if (day(d) === day(yest)) return "Yesterday " + time;
  const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return date + ", " + time;
}

function dueInfo(due: string): { label: string; overdue: boolean } {
  const today = todayStr();
  if (due < today) return { label: "Overdue", overdue: true };
  if (due === today) return { label: "Today", overdue: false };
  if (due === addDaysStr(today, 1)) return { label: "Tomorrow", overdue: false };
  const [y, m, d] = due.split("-").map(Number);
  return { label: new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }), overdue: false };
}

const meId = (): string | undefined => session.me?.id;
const canTick = (t: Task): boolean => isParent() || !t.assignee_id || t.assignee_id === meId();
const canUndo = (t: Task): boolean => isParent() || t.done_by === meId();
const canBlock = (t: Task): boolean => !t.blocked_at && (!t.assignee_id || t.assignee_id === meId());
const canPhoto = (t: Task): boolean => isParent() || t.done_by === meId();
/** "Will do": anyone who may do the task can claim it first (their own tasks and "Anyone" tasks). */
const canSee = (t: Task): boolean => !t.seen_at && (!t.assignee_id || t.assignee_id === meId());
/** Who clicked, as everyone else should read it. */
const who = (id: string | null, name: string | null): string => (id && id === meId() ? "You" : name || "Someone");

const WAIT_CHIP = (): HTMLElement => h("span", { class: "chip sync-wait" }, "⏳ waiting to sync");

/** Re-apply "done"/"seen" changes still waiting in the outbox so server/cached data does not undo them on screen. */
function overlay(o: Task[], d: Task[]): [Task[], Task[]] {
  const me = session.me;
  for (const e of queuedEntries()) {
    if (e.method !== "PATCH" || !e.path.startsWith("/api/tasks/")) continue;
    const id = decodeURIComponent(e.path.split("/").pop() ?? "");
    const body = e.body as { done?: unknown; seen?: unknown } | null;
    if (body?.seen === true) {
      o = o.map((x) => (x.id === id && !x.seen_at ? { ...x, seen_at: e.at, seen_by: me?.id ?? null, seen_by_name: me?.name ?? null } : x));
      continue;
    }
    const v = body?.done;
    if (typeof v !== "boolean") continue;
    if (v) {
      const t = o.find((x) => x.id === id);
      if (t) {
        o = o.filter((x) => x.id !== id);
        d = [{ ...t, done_by: me?.id ?? null, done_by_name: me?.name ?? null, done_at: e.at, blocked_at: null }, ...d];
      }
    } else {
      const t = d.find((x) => x.id === id);
      if (t) {
        d = d.filter((x) => x.id !== id);
        o = [{ ...t, done_by: null, done_by_name: null, done_at: null, done_photo_key: null }, ...o];
      }
    }
  }
  return [o, d];
}

// ---------- render ----------

function render(force = false): void {
  if (!bodyEl) return;
  const today = todayStr();
  waiting = queuedIds();
  const s = JSON.stringify([open, done, mine, loaded, showUpcoming, today, [...waiting]]);
  if (!force && s === sig) return;
  sig = s;
  clear(bodyEl);

  const tomorrow = addDaysStr(today, 1);
  const routineOpen = open.filter((t) => t.slot && t.due_on && t.due_on <= today);
  const routineDone = done.filter((t) => t.slot && (!t.due_on || t.due_on <= today));
  const regular = open.filter((t) => !t.slot);
  const upcoming = regular.filter((t) => t.due_on && t.due_on > tomorrow);
  const current = regular.filter((t) => !(t.due_on && t.due_on > tomorrow));
  const doneRegular = done.filter((t) => !t.slot);

  const hasRoutine = routineOpen.length + routineDone.length > 0;
  const hasTasks = current.length + upcoming.length + doneRegular.length > 0;
  const both = hasRoutine && hasTasks;

  const tasksBody: HTMLElement[] = [];
  if (!current.length) {
    const msg = !loaded ? "" : routineOpen.length ? "" : doneRegular.length || routineDone.length ? "All done for today \u{1F389}" : "No tasks right now";
    if (msg) tasksBody.push(h("div", { class: "empty" }, msg));
  } else {
    tasksBody.push(h("div", { class: "stack" }, current.map(openCard)));
  }

  if (upcoming.length) {
    tasksBody.push(
      h(
        "button",
        {
          class: "upcoming-toggle",
          type: "button",
          "aria-expanded": String(showUpcoming),
          onclick: () => {
            showUpcoming = !showUpcoming;
            render();
          },
        },
        h("span", { class: "caret", "aria-hidden": "true" }, showUpcoming ? "▾" : "▸"),
        ` Upcoming (${upcoming.length})`,
      ),
    );
    if (showUpcoming) tasksBody.push(h("div", { class: "stack upcoming" }, upcoming.map(openCard)));
  }

  if (doneRegular.length) tasksBody.push(h("h2", { class: "section-h" }, "Done today"), h("div", { class: "stack" }, doneRegular.map(doneCard)));

  const wrap = h("div", { class: "task-groups" + (both ? " two" : "") });
  if (hasRoutine) {
    const sec = routineSection(routineOpen, routineDone, both);
    add(wrap, both ? group("routine", "Today's routine", routineOpen.length, routineDone.length > 0, sec) : sec);
  }
  if (hasTasks) add(wrap, both ? group("tasks", "Tasks", current.length, doneRegular.length > 0, h("div", { class: "group-tasks" }, tasksBody)) : tasksBody);
  else add(wrap, tasksBody);
  add(bodyEl, wrap);
}

const COLLAPSED_KEY = "bayt.tasks.collapsed";

function collapsedMap(): Record<string, boolean> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

function setCollapsed(id: string, on: boolean): void {
  const m = collapsedMap();
  if (on) m[id] = true;
  else delete m[id];
  try {
    if (Object.keys(m).length) localStorage.setItem(COLLAPSED_KEY, JSON.stringify(m));
    else localStorage.removeItem(COLLAPSED_KEY);
  } catch {
    /* storage blocked: still applies for this visit */
  }
}

/** A collapsible group: header button with a pending-count badge, then the body (hidden while collapsed). */
function group(id: string, label: string, pendingN: number, hasDone: boolean, bodyNode: HTMLElement): HTMLElement {
  const collapsed = collapsedMap()[id] === true;
  const bodyId = `task-group-${id}`;
  bodyNode.id = bodyId;
  bodyNode.hidden = collapsed;
  const badge = pendingN
    ? h("span", { class: "group-badge", "aria-label": `${pendingN} pending` }, String(pendingN))
    : hasDone
      ? h("span", { class: "group-badge all-done", "aria-label": "all done" }, "✓")
      : null;
  return h(
    "div",
    { class: "task-group group-" + id },
    h(
      "button",
      {
        class: "group-head",
        type: "button",
        "aria-expanded": String(!collapsed),
        "aria-controls": bodyId,
        onclick: () => {
          setCollapsed(id, !collapsed);
          render(true);
        },
      },
      h("span", { class: "caret", "aria-hidden": "true" }, collapsed ? "▸" : "▾"),
      h("span", { class: "group-label" }, label),
      badge,
    ),
    bodyNode,
  );
}

function routineSection(todo: Task[], finished: Task[], grouped = false): HTMLElement {
  const sec = h("section", { class: "routine", "aria-label": "Today's routine" }, grouped ? null : h("h2", { class: "section-h" }, "Today's routine"));
  for (const s of SLOTS) {
    const rows = [
      ...todo.filter((t) => t.slot === s.id).map((t) => routineRow(t, false)),
      ...finished.filter((t) => t.slot === s.id).map((t) => routineRow(t, true)),
    ];
    if (!rows.length) continue;
    add(sec, h("div", { class: "routine-group" }, h("h3", { class: "routine-slot" }, s.label), rows));
  }
  return sec;
}

function routineRow(t: Task, isDone: boolean): HTMLElement {
  const overdue = !isDone && !!t.due_on && t.due_on < todayStr();
  const allowed = isDone ? canUndo(t) : canTick(t);
  const label = (isDone ? "Not done yet: " : "Done: ") + t.title;
  return h(
    "div",
    { class: "routine-row" + (isDone ? " is-done" : ""), "data-id": t.id },
    h(
      "button",
      {
        class: "check big" + (isDone ? " on" : ""),
        type: "button",
        role: "checkbox",
        "aria-checked": String(isDone),
        "aria-label": label,
        disabled: !allowed,
        onclick: () => void setDone(t.id, !isDone, true),
      },
      h("span", { "aria-hidden": "true" }, isDone ? "✓" : ""),
    ),
    h(
      "div",
      { class: "grow" },
      h("div", { class: "r-title" }, t.title),
      h(
        "div",
        { class: "r-sub" },
        t.due_time ? h("span", null, t.due_time) : null,
        overdue ? h("span", { class: "chip overdue" }, "Overdue") : null,
        isDone && t.done_by_name ? h("span", null, `by ${t.done_by_name}`) : null,
        t.assignee_name && isParent() && !isDone ? h("span", null, t.assignee_name) : null,
        waiting.has(t.id) ? WAIT_CHIP() : null,
      ),
    ),
  );
}

function openCard(t: Task): HTMLElement {
  const due = t.due_on ? dueInfo(t.due_on) : null;
  const parent = isParent();
  const meta = h(
    "div",
    { class: "meta" },
    t.urgent ? h("span", { class: "chip urgent" }, "🔴 Urgent") : null,
    h("span", { class: "chip" }, t.assignee_name || "Anyone"),
    due ? h("span", { class: "chip" + (due.overdue ? " overdue" : "") }, due.label + (t.due_time ? " · " + t.due_time : "")) : null,
    t.recur ? recurChip(t.recur) : null,
    t.seen_at
      ? h("span", { class: "chip seen", title: timeAgo(t.seen_at) }, "✓ Will do · " + who(t.seen_by, t.seen_by_name))
      : parent && t.assignee_id !== meId()
        ? h("span", { class: "chip unseen" }, "Waiting for OK")
        : null,
    questionsChip(t),
    waiting.has(t.id) ? WAIT_CHIP() : null,
  );
  const blocked = t.blocked_at
    ? h(
        "div",
        { class: "blocked-banner", role: "note" },
        h("span", { class: "grow" }, "Couldn't do: ", t.blocked_reason ?? "", " — ", who(t.blocked_by, t.blocked_by_name)),
        parent
          ? h(
              "button",
              {
                class: "btn small",
                type: "button",
                onclick: (e: Event) => {
                  e.stopPropagation();
                  void unblock(t.id);
                },
              },
              "Try again",
            )
          : null,
      )
    : null;
  const body = h(
    "div",
    {
      class: "body",
      role: parent ? "button" : null,
      tabindex: parent ? 0 : null,
      onclick: parent ? () => openEditor(t) : null,
      onkeydown: parent
        ? (e: KeyboardEvent) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openEditor(t);
            }
          }
        : null,
    },
    h("div", { class: "t-title" }, t.title),
    h("div", { class: "posted" }, postedLabel(t.created_at) + " · " + who(t.created_by, t.created_by_name)),
    t.note ? h("div", { class: "note" }, t.note) : null,
    meta,
    blocked,
  );
  const actions = h("div", { class: "task-actions" });
  if (canSee(t))
    add(actions, h("button", { class: "done-btn ok-btn", type: "button", "aria-label": "Will do: " + t.title, onclick: () => void setSeen(t.id) }, "✓", h("span", null, "Will do")));
  if (canTick(t))
    add(actions, h("button", { class: "done-btn", type: "button", "aria-label": "Mark done: " + t.title, onclick: () => void setDone(t.id, true) }, "✓", h("span", null, "Done")));
  if (canBlock(t))
    add(actions, h("button", { class: "cant-btn", type: "button", "aria-label": "Can't do: " + t.title, onclick: () => openBlockSheet(t) }, "Can't do"));
  return h("div", { class: "card task" + (t.blocked_at ? " is-blocked" : "") + (t.urgent ? " is-urgent" : ""), "data-id": t.id }, body, actions);
}

function doneCard(t: Task): HTMLElement {
  const thumb = t.done_photo_key
    ? h(
        "button",
        { class: "thumb-btn", type: "button", "aria-label": "View photo: " + t.title, onclick: () => openViewer(t.done_photo_key!, t.title) },
        h("img", { class: "thumb", src: mediaUrl(t.done_photo_key), alt: "", loading: "lazy", decoding: "async" }),
      )
    : null;
  return h(
    "div",
    { class: "row task-done", "data-id": t.id },
    thumb,
    h(
      "div",
      { class: "grow" },
      h("div", { class: "t-title struck" }, t.title),
      h("div", { class: "sub" }, `done by ${who(t.done_by, t.done_by_name)} · ${t.done_at ? timeAgo(t.done_at) : ""}`, waiting.has(t.id) ? " · ⏳ waiting to sync" : null),
    ),
    t.comment_count ? questionsChip(t) : null,
    !t.done_photo_key && canPhoto(t)
      ? h("button", { class: "btn small ghost photo-add", type: "button", "aria-label": "Add photo: " + t.title, onclick: () => void addPhoto(t.id) }, "📷")
      : null,
    canUndo(t) ? h("button", { class: "btn small", type: "button", onclick: () => void setDone(t.id, false) }, "Undo") : null,
  );
}

const hasNewQs = (t: Task): boolean =>
  !!t.last_comment_at && t.last_comment_by !== meId() && t.last_comment_at > (readQs[t.id] ?? 0);

/** "💬 Ask" / "💬 2" on a task; highlighted when someone else wrote since this device last looked. */
function questionsChip(t: Task): HTMLElement {
  const fresh = hasNewQs(t);
  return h(
    "button",
    {
      class: "chip q-btn" + (fresh ? " unread" : ""),
      type: "button",
      "aria-label": (t.comment_count ? `Questions (${t.comment_count}${fresh ? ", new" : ""}): ` : "Ask about: ") + t.title,
      onclick: (e: Event) => {
        e.stopPropagation();
        openQuestions(t);
      },
    },
    t.comment_count ? `💬 ${t.comment_count}${fresh ? " new" : ""}` : "💬 Ask",
  );
}

interface TaskComment {
  id: string;
  author_id: string;
  author_name: string | null;
  body: string;
  created_at: number;
}

function markQsRead(id: string): void {
  readQs = { ...readQs, [id]: Date.now() };
  void kvSet(READ_QS_KEY, readQs).catch(() => undefined);
}

/** The question thread for one task: everyone can ask and answer. */
function openQuestions(t: Task): void {
  let unsub: (() => void) | null = null;
  const sheet = openSheet("Questions", () => {
    unsub?.();
    markQsRead(t.id);
    render(true);
  });
  const list = h("div", { class: "q-list", role: "log", "aria-live": "polite" });
  const input = h("textarea", { class: "input", rows: 2, maxLength: 500, required: true, placeholder: "Ask or answer…", "aria-label": "Your question or answer" });
  const err = h("p", { class: "error", role: "alert" });
  const send = h("button", { class: "btn primary", type: "submit" }, "Send");
  let comments: TaskComment[] = [];
  const paint = (): void => {
    clear(list);
    if (!comments.length) add(list, h("p", { class: "muted q-empty" }, "No questions yet. Ask anything about this task."));
    for (const c of comments) {
      const mine = c.author_id === meId();
      add(
        list,
        h(
          "div",
          { class: "q-msg" + (mine ? " mine" : "") },
          h("div", { class: "q-head" }, who(c.author_id, c.author_name), " · ", timeAgo(c.created_at)),
          h("div", { class: "q-body" }, c.body),
        ),
      );
    }
    list.scrollTop = list.scrollHeight;
  };
  const loadQs = async (): Promise<void> => {
    try {
      comments = (await api<{ comments: TaskComment[] }>(`/api/tasks/${t.id}/comments`)).comments;
      paint();
      markQsRead(t.id);
    } catch (e) {
      err.textContent = errMsg(e);
    }
  };
  unsub = onEvent((e) => {
    if (e.type === "changed" && e.scope === "tasks") void loadQs();
  });
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const body = input.value.trim();
        if (!body) return;
        send.disabled = true;
        err.textContent = "";
        try {
          const r = await api<{ comment: TaskComment }>(`/api/tasks/${t.id}/comments`, { method: "POST", body: { body } });
          if (!comments.some((c) => c.id === r.comment.id)) comments = [...comments, r.comment];
          input.value = "";
          paint();
          markQsRead(t.id);
          reconcile();
        } catch (ex) {
          err.textContent = errMsg(ex);
        } finally {
          send.disabled = false;
        }
      },
    },
    h("label", { class: "field" }, input),
    err,
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Close"), send),
  );
  add(sheet.body, h("p", { class: "muted block-task" }, t.title), list, form);
  paint();
  void loadQs();
}

function openViewer(key: string, title: string): void {
  const prevFocus = document.activeElement as HTMLElement | null;
  const close = (): void => {
    document.removeEventListener("keydown", onKey);
    viewer.remove();
    prevFocus?.focus?.();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };
  const closeBtn = h("button", { class: "viewer-close", type: "button", "aria-label": "Close photo", onclick: close }, "✕");
  const viewer = h(
    "div",
    { class: "photo-viewer", role: "dialog", "aria-modal": "true", "aria-label": "Photo: " + title, onclick: (e: Event) => e.target !== closeBtn && close() },
    h("img", { src: mediaUrl(key), alt: "Photo for " + title }),
    closeBtn,
  );
  document.addEventListener("keydown", onKey);
  document.body.appendChild(viewer);
  closeBtn.focus();
}

// ---------- data ----------

async function load(): Promise<void> {
  const my = gen;
  const r = await api<TasksResponse>("/api/tasks" + (mine ? "?mine=1" : ""));
  if (!root || pending || my !== gen) return;
  [open, done] = overlay(r.open, r.done);
  loaded = true;
  render();
}

function reconcile(): void {
  if (!pending) void load().catch(() => undefined);
}

async function setDone(id: string, value: boolean, routine = false): Promise<void> {
  const from = value ? open : done;
  const t = from.find((x) => x.id === id);
  if (!t) return;
  const snap = [open, done];
  const me = session.me;
  if (value) {
    open = open.filter((x) => x.id !== id);
    done = [{ ...t, done_by: me?.id ?? null, done_by_name: me?.name ?? null, done_at: Date.now(), blocked_at: null }, ...done];
  } else {
    done = done.filter((x) => x.id !== id);
    open = [{ ...t, done_by: null, done_by_name: null, done_at: null, done_photo_key: null }, ...open];
  }
  render();
  pending++;
  let ok = false;
  try {
    await api("/api/tasks/" + id, { method: "PATCH", body: { done: value } });
    ok = true;
  } catch (e) {
    if (isQueued(e)) {
      // Offline: stays applied (with a clock) and is sent when the connection is back.
      render();
      if (value && !routine) toast("Done ✓ · will sync when you are online");
    } else {
      [open, done] = snap;
      render();
      toast(errMsg(e), true);
    }
  } finally {
    pending--;
    reconcile();
  }
  if (ok && value && !routine) toast("Done ✓", { action: { label: "📷 Add photo", run: () => void addPhoto(id) }, ms: 6000 });
}

async function setSeen(id: string): Promise<void> {
  const t = open.find((x) => x.id === id);
  if (!t || t.seen_at) return;
  const snap = open;
  const me = session.me;
  open = open.map((x) => (x.id === id ? { ...x, seen_at: Date.now(), seen_by: me?.id ?? null, seen_by_name: me?.name ?? null } : x));
  render();
  pending++;
  try {
    await api("/api/tasks/" + id, { method: "PATCH", body: { seen: true } });
  } catch (e) {
    if (isQueued(e)) render();
    else {
      open = snap;
      render();
      toast(errMsg(e), true);
    }
  } finally {
    pending--;
    reconcile();
  }
}

async function addPhoto(id: string): Promise<void> {
  let file: File | null;
  try {
    file = await pickImage();
  } catch {
    return;
  }
  if (!file) return;
  pending++;
  try {
    const blob = await compressImage(file);
    const up = await uploadMedia(blob);
    await api("/api/tasks/" + id, { method: "PATCH", body: { done_photo_key: up.key } });
    toast("Photo added");
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    pending--;
    reconcile();
  }
}

async function unblock(id: string): Promise<void> {
  pending++;
  try {
    await api("/api/tasks/" + id, { method: "PATCH", body: { blocked: null } });
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    pending--;
    reconcile();
  }
}

// ---------- sheets ----------

function openBlockSheet(t: Task): void {
  const sheet = openSheet("Couldn't do it");
  const reason = h("textarea", { class: "input", rows: 2, maxLength: 200, required: true, "aria-label": "Reason" });
  const chips = BLOCK_CHIPS.map((c) =>
    h(
      "button",
      {
        class: "chip-btn",
        type: "button",
        onclick: () => {
          reason.value = c;
          reason.focus();
        },
      },
      c,
    ),
  );
  const item = h("input", { class: "input", maxLength: 80, placeholder: "e.g. Flour", "aria-label": "Add to shopping list" });
  const err = h("p", { class: "error", role: "alert" });
  const send = h("button", { class: "btn primary", type: "submit" }, "Send");
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const r = reason.value.trim();
        if (!r) return void (err.textContent = "Please say why");
        const addItem = item.value.trim();
        send.disabled = true;
        pending++;
        try {
          await api("/api/tasks/" + t.id, { method: "PATCH", body: { blocked: addItem ? { reason: r, add_item: addItem } : { reason: r } } });
          sheet.close();
          toast(addItem ? `Told the parents · "${addItem}" added to the list` : "Told the parents");
        } catch (ex) {
          err.textContent = errMsg(ex);
          send.disabled = false;
        } finally {
          pending--;
          reconcile();
        }
      },
    },
    h("p", { class: "muted block-task" }, t.title),
    h("div", { class: "chip-row", role: "group", "aria-label": "Quick reasons" }, chips),
    h("label", { class: "field" }, h("span", null, "Why?"), reason),
    h("label", { class: "field" }, h("span", null, "Add to shopping list: (optional)"), item),
    err,
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Cancel"), send),
  );
  add(sheet.body, form);
}

function assigneeSelect(selected: string | null): HTMLSelectElement {
  const opts = [h("option", { value: "" }, "Anyone"), ...session.members.map((m) => h("option", { value: m.id }, m.name))];
  const sel = h("select", { class: "input", "aria-label": "Assignee" }, opts);
  sel.value = selected ?? "";
  return sel;
}

/** Repeat control for regular tasks: none / every day / every N days / weekly on chosen days. */
function repeatControl(initial: Recur | null): { el: HTMLElement; value: () => Recur | null | false } {
  const mode = h(
    "select",
    { class: "input", "aria-label": "Repeat" },
    h("option", { value: "" }, "Doesn't repeat"),
    h("option", { value: "daily" }, "Every day"),
    h("option", { value: "every" }, "Every few days"),
    h("option", { value: "weekly" }, "On certain weekdays"),
  );
  mode.value = initial?.freq ?? "";
  const days = h("input", { class: "input every-n", type: "number", min: 2, max: 30, step: 1, inputMode: "numeric", "aria-label": "Every how many days" });
  days.value = String(initial?.freq === "every" ? initial.days : 2);
  const everyRow = h("label", { class: "every-row" }, "Every ", days, " days");
  const picked = new Set<number>(initial?.freq === "weekly" ? initial.weekdays : []);
  const dayBtns = DAY_SHORT.map((label, i) =>
    h(
      "button",
      {
        type: "button",
        class: "day-btn",
        "aria-label": label,
        onclick: () => {
          if (picked.has(i)) picked.delete(i);
          else picked.add(i);
          paint();
        },
      },
      label.slice(0, 2),
    ),
  );
  const weekRow = h("div", { class: "day-row", role: "group", "aria-label": "Weekdays" }, dayBtns);
  const paint = (): void => {
    everyRow.hidden = mode.value !== "every";
    weekRow.hidden = mode.value !== "weekly";
    dayBtns.forEach((b, i) => {
      b.classList.toggle("on", picked.has(i));
      b.setAttribute("aria-pressed", String(picked.has(i)));
    });
  };
  mode.addEventListener("change", paint);
  paint();
  return {
    el: h("div", { class: "stack repeat-ctl" }, mode, everyRow, weekRow),
    value: () => {
      switch (mode.value) {
        case "daily":
          return { freq: "daily" };
        case "every": {
          const n = Number(days.value);
          return Number.isInteger(n) && n >= 2 && n <= 30 ? { freq: "every", days: n } : false;
        }
        case "weekly":
          return picked.size ? { freq: "weekly", weekdays: [...picked].sort((a, b) => a - b) } : false;
        default:
          return null;
      }
    },
  };
}

function openEditor(t: Task | null): void {
  const sheet = openSheet(t ? "Edit task" : "Add task");
  const title = h("input", { class: "input", value: t?.title ?? "", maxLength: 120, required: true, "aria-label": "Title" });
  const note = h("textarea", { class: "input", rows: 3, maxLength: 500, "aria-label": "Note" });
  note.value = t?.note ?? "";
  let defAssignee: string | null = t ? t.assignee_id : null;
  if (!t) {
    const nannies = session.members.filter((m) => m.role === "nanny");
    if (nannies.length === 1) defAssignee = nannies[0].id;
  }
  const assignee = assigneeSelect(defAssignee);
  const due = h("input", { class: "input dt", type: "date", value: t?.due_on ?? "", "aria-label": "Due date" });
  const time = h("input", { class: "input dt", type: "time", value: t?.due_time ?? "", "aria-label": "Time" });
  const repeat = repeatControl(t?.recur ?? null);
  const urgent = h("input", { type: "checkbox", "aria-label": "Urgent" });
  urgent.checked = !!t?.urgent;
  const err = h("p", { class: "error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, t ? "Save" : "Add");
  const actions = h("div", { class: "actions" });
  const del = async (series: boolean): Promise<void> => {
    if (!t) return;
    const msg = series ? `Delete "${t.title}" and all its upcoming repeats?` : `Delete "${t.title}"?`;
    if (!(await confirmDialog(msg, "Delete", true))) return;
    try {
      const r = await api<{ trash_ids?: string[] }>(`/api/tasks/${t.id}${series ? "?series=1" : ""}`, { method: "DELETE" });
      open = open.filter((x) => x.id !== t.id && !(series && (x.series_id ?? x.id) === (t.series_id ?? t.id)));
      render();
      sheet.close();
      reconcile();
      undoToast(`"${t.title}"`, r.trash_ids, reconcile);
    } catch (ex) {
      toast(errMsg(ex), true);
    }
  };
  if (t) {
    add(actions, h("button", { class: "btn danger", type: "button", onclick: () => void del(false) }, t.recur ? "Delete this one" : "Delete"));
    if (t.recur) add(actions, h("button", { class: "btn danger", type: "button", onclick: () => void del(true) }, "Delete all"));
  }
  add(actions, save);
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const ttl = title.value.trim();
        if (!ttl) return void (err.textContent = "Title is required");
        const recur = repeat.value();
        if (recur === false) return void (err.textContent = "Check the repeat settings");
        if (time.value && !due.value && !recur) return void (err.textContent = "Pick a date for the time");
        const body: Record<string, unknown> = {
          title: ttl,
          note: note.value.trim() || null,
          assignee_id: assignee.value || null,
          due_on: due.value || null,
          due_time: time.value || null,
          recur,
          urgent: urgent.checked,
        };
        if (recur && !due.value) body.due_on = todayStr();
        save.disabled = true;
        try {
          if (t) await api("/api/tasks/" + t.id, { method: "PATCH", body });
          else await api("/api/tasks", { method: "POST", body });
          sheet.close();
          await load();
        } catch (ex) {
          err.textContent = errMsg(ex);
          save.disabled = false;
        }
      },
    },
    h("label", { class: "field" }, h("span", null, "Title"), title),
    h("label", { class: "field" }, h("span", null, "Note (optional)"), note),
    h("label", { class: "field" }, h("span", null, "Assignee"), assignee),
    h(
      "div",
      { class: "dt-row" },
      h("label", { class: "field" }, h("span", null, "Date (optional)"), due),
      h("label", { class: "field" }, h("span", null, "Time (optional)"), time),
    ),
    h("div", { class: "field" }, h("span", null, "Repeat"), repeat.el),
    h("label", { class: "check-row urgent-row" }, urgent, h("span", null, "🔴 Urgent — goes to the top; the alert stays on screen until opened")),
    err,
    actions,
  );
  add(sheet.body, form);
  if (!t) title.focus();
}

function paintSeg(): void {
  if (!segEl) return;
  for (const b of Array.from(segEl.children)) {
    const on = (b as HTMLElement).dataset.v === (mine ? "mine" : "all");
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
}

export function mount(el: HTMLElement): () => void {
  root = el;
  open = [];
  done = [];
  loaded = false;
  sig = "";
  pending = 0;
  showUpcoming = false;
  gen++;
  const parent = isParent();
  mine = !parent;
  bodyEl = h("div", { class: "tasks-body" });
  const head = h("div", { class: "tasks-head" });
  if (parent) {
    add(
      head,
      h("button", { class: "btn", type: "button", onclick: () => openRoutineManager(() => reconcile()) }, "↻ Manage routine"),
      h("button", { class: "btn primary", type: "button", onclick: () => openEditor(null) }, "+ Add task"),
    );
  } else {
    const pick = (v: boolean) => () => {
      if (mine === v) return;
      mine = v;
      gen++;
      paintSeg();
      void load().catch((e) => toast(errMsg(e), true));
    };
    segEl = h(
      "div",
      { class: "seg", role: "group", "aria-label": "Filter tasks" },
      h("button", { type: "button", "data-v": "mine", onclick: pick(true) }, "Mine"),
      h("button", { type: "button", "data-v": "all", onclick: pick(false) }, "All"),
    );
    add(head, segEl);
    paintSeg();
  }
  el.replaceChildren(h("div", { class: "view" }, head, bodyEl));
  void kvGet<Record<string, number>>(READ_QS_KEY)
    .then((v) => {
      readQs = v && typeof v === "object" ? v : {};
      render(true);
    })
    .catch(() => undefined);
  void load().catch((e) => toast(errMsg(e), true));
  tick = setInterval(() => render(true), 60000);
  unsubOutbox = onOutboxChange(() => render());
  return () => {
    unsubOutbox?.();
    unsubOutbox = null;
    if (tick) clearInterval(tick);
    tick = null;
    root = null;
    bodyEl = null;
    segEl = null;
    gen++;
    el.replaceChildren();
  };
}

export async function refresh(): Promise<void> {
  if (!root) return;
  if (pending) {
    return;
  }
  await load();
}

export const view: View = { mount, refresh };
