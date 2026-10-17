// Daily routine: shared task types/helpers and the parents' "Manage routine" sheet.
import { ApiError, api } from "../lib/api";
import { add, clear, h } from "../lib/dom";
import { undoToast } from "../lib/trash";
import { confirmDialog, openSheet, toast } from "../lib/ui";

export type Recur = { freq: "daily" } | { freq: "every"; days: number } | { freq: "weekly"; weekdays: number[] };
export type Slot = "morning" | "afternoon" | "evening";

export interface Task {
  id: string;
  title: string;
  note: string | null;
  assignee_id: string | null;
  assignee_name: string | null;
  due_on: string | null;
  due_time: string | null;
  recur: Recur | null;
  slot: Slot | null;
  series_id: string | null;
  done_photo_key: string | null;
  blocked_at: number | null;
  blocked_by: string | null;
  blocked_by_name: string | null;
  blocked_reason: string | null;
  seen_at: number | null;
  seen_by: string | null;
  seen_by_name: string | null;
  urgent: boolean;
  comment_count: number;
  last_comment_at: number | null;
  last_comment_by: string | null;
  created_by: string;
  created_by_name: string | null;
  created_at: number;
  done_by: string | null;
  done_by_name: string | null;
  done_at: number | null;
}

export const SLOTS: { id: Slot; label: string }[] = [
  { id: "morning", label: "Morning" },
  { id: "afternoon", label: "Afternoon" },
  { id: "evening", label: "Evening" },
];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const pad = (n: number): string => String(n).padStart(2, "0");
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = (): string => ymd(new Date());
export function addDaysStr(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + n));
}
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** "Every day", "Every 3 days", "Sun, Tue, Thu". */
export function recurText(r: Recur): string {
  if (r.freq === "daily") return "Every day";
  if (r.freq === "every") return `Every ${r.days} days`;
  if (r.weekdays.length === 7) return "Every day";
  return r.weekdays.map((d) => DAY_SHORT[d]).join(", ");
}

/** First date >= from that the recurrence lands on (weekly honours its weekdays; others start on `from`). */
export function firstDue(r: Recur, from: string): string {
  if (r.freq !== "weekly") return from;
  for (let i = 0; i < 7; i++) {
    const d = addDaysStr(from, i);
    if (r.weekdays.includes(weekdayOf(d))) return d;
  }
  return from;
}

/** Small chalk "↻ Every day" label. */
export const recurChip = (r: Recur): HTMLElement =>
  h("span", { class: "chip recur" }, h("span", { class: "recur-ico", "aria-hidden": "true" }, "↻"), " ", recurText(r));

const errMsg = (e: unknown): string => {
  if (e instanceof ApiError) {
    if (e.code === "network") return "You are offline";
    if (e.status === 403) return "Not allowed";
  }
  return "Something went wrong";
};

/** Day picker: "Every day" or chosen weekdays. Returns the element and a getter (null = no weekday picked). */
export function daysPicker(initial: Recur | null): { el: HTMLElement; value: () => Recur | null } {
  let everyDay = !initial || initial.freq === "daily" || (initial.freq === "weekly" && initial.weekdays.length === 7);
  const picked = new Set<number>(initial && initial.freq === "weekly" && !everyDay ? initial.weekdays : []);
  if (initial && initial.freq === "every") everyDay = false;
  const keepEvery = initial && initial.freq === "every" ? initial : null;
  const modeAll = h("button", { type: "button", class: "day-mode" }, "Every day");
  const modePick = h("button", { type: "button", class: "day-mode" }, keepEvery ? recurText(keepEvery) : "Pick days");
  const days = DAY_SHORT.map((label, i) =>
    h(
      "button",
      {
        type: "button",
        class: "day-btn",
        "aria-label": label,
        onclick: () => {
          if (picked.has(i)) picked.delete(i);
          else picked.add(i);
          everyDay = false;
          paint();
        },
      },
      label.slice(0, 2),
    ),
  );
  const daysRow = h("div", { class: "day-row", role: "group", "aria-label": "Days" }, days);
  let keep = !!keepEvery;
  const paint = (): void => {
    modeAll.classList.toggle("on", everyDay);
    modeAll.setAttribute("aria-pressed", String(everyDay));
    modePick.classList.toggle("on", !everyDay);
    modePick.setAttribute("aria-pressed", String(!everyDay));
    daysRow.hidden = everyDay || keep;
    days.forEach((b, i) => {
      b.classList.toggle("on", picked.has(i));
      b.setAttribute("aria-pressed", String(picked.has(i)));
    });
  };
  modeAll.addEventListener("click", () => {
    everyDay = true;
    keep = false;
    paint();
  });
  modePick.addEventListener("click", () => {
    everyDay = false;
    keep = false;
    modePick.textContent = "Pick days";
    paint();
  });
  paint();
  return {
    el: h("div", { class: "stack days-picker" }, h("div", { class: "seg day-modes" }, modeAll, modePick), daysRow),
    value: () => {
      if (everyDay) return { freq: "daily" };
      if (keep && keepEvery) return keepEvery;
      return picked.size ? { freq: "weekly", weekdays: [...picked].sort((a, b) => a - b) } : null;
    },
  };
}

/** Add/edit one routine item. */
function openItemEditor(t: Task | null, onSaved: () => void): void {
  const sheet = openSheet(t ? "Edit routine item" : "Add routine item");
  const title = h("input", { class: "input", value: t?.title ?? "", maxLength: 120, required: true, "aria-label": "Title" });
  let slot: Slot = t?.slot ?? "morning";
  const slotBtns = SLOTS.map((s) =>
    h(
      "button",
      {
        type: "button",
        "data-v": s.id,
        onclick: () => {
          slot = s.id;
          paintSlot();
        },
      },
      s.label,
    ),
  );
  const paintSlot = (): void =>
    slotBtns.forEach((b) => {
      const on = b.dataset.v === slot;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    });
  paintSlot();
  const picker = daysPicker(t?.recur ?? null);
  const time = h("input", { class: "input dt", type: "time", value: t?.due_time ?? "", "aria-label": "Time (optional)" });
  const err = h("p", { class: "error", role: "alert" });
  const save = h("button", { class: "btn primary", type: "submit" }, t ? "Save" : "Add");
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const ttl = title.value.trim();
        const recur = picker.value();
        if (!ttl) return void (err.textContent = "Title is required");
        if (!recur) return void (err.textContent = "Pick at least one day");
        const today = todayStr();
        const body: Record<string, unknown> = { title: ttl, slot, recur, due_time: time.value || null };
        if (!t) body.due_on = firstDue(recur, today);
        else if (recur.freq === "weekly" && t.due_on && !recur.weekdays.includes(weekdayOf(t.due_on)))
          body.due_on = firstDue(recur, t.due_on > today ? t.due_on : today);
        save.disabled = true;
        try {
          if (t) await api("/api/tasks/" + t.id, { method: "PATCH", body });
          else await api("/api/tasks", { method: "POST", body });
          sheet.close();
          onSaved();
        } catch (ex) {
          err.textContent = errMsg(ex);
          save.disabled = false;
        }
      },
    },
    h("label", { class: "field" }, h("span", null, "What"), title),
    h("div", { class: "field" }, h("span", null, "When in the day"), h("div", { class: "seg", role: "group", "aria-label": "Part of day" }, slotBtns)),
    h("div", { class: "field" }, h("span", null, "Days"), picker.el),
    h("label", { class: "field" }, h("span", null, "Time (optional, sends a reminder)"), time),
    err,
    h("div", { class: "actions" }, h("button", { class: "btn", type: "button", onclick: () => sheet.close() }, "Cancel"), save),
  );
  add(sheet.body, form);
  if (!t) title.focus();
}

/** Parents' routine manager. `onChange` reloads the tasks view. */
export function openRoutineManager(onChange: () => void): void {
  let alive = true;
  const sheet = openSheet("Daily routine", () => {
    alive = false;
  });
  const listEl = h("div", { class: "stack routine-manage" });
  const changed = (): void => {
    onChange();
    void load();
  };
  async function load(): Promise<void> {
    let open: Task[];
    try {
      open = (await api<{ open: Task[] }>("/api/tasks")).open;
    } catch (e) {
      toast(errMsg(e), true);
      return;
    }
    if (!alive) return;
    // one row per series: its earliest open occurrence
    const bySeries = new Map<string, Task>();
    for (const t of open) {
      if (!t.slot || !t.recur) continue;
      const k = t.series_id ?? t.id;
      const cur = bySeries.get(k);
      if (!cur || (t.due_on ?? "") < (cur.due_on ?? "")) bySeries.set(k, t);
    }
    const items = [...bySeries.values()].sort((a, b) => (a.due_time ?? "99").localeCompare(b.due_time ?? "99") || a.title.localeCompare(b.title));
    clear(listEl);
    if (!items.length) add(listEl, h("p", { class: "muted" }, "No routine items yet."));
    for (const s of SLOTS) {
      const group = items.filter((t) => t.slot === s.id);
      if (!group.length) continue;
      add(
        listEl,
        h("h3", null, s.label),
        group.map((t) =>
          h(
            "div",
            { class: "row routine-item" },
            h(
              "div",
              { class: "grow" },
              h("div", { class: "title" }, t.title),
              h("div", { class: "sub" }, [t.recur ? recurText(t.recur) : "", t.due_time ? "at " + t.due_time : ""].filter(Boolean).join(" · ")),
            ),
            h("button", { class: "btn small", type: "button", onclick: () => openItemEditor(t, changed) }, "Edit"),
            h(
              "button",
              {
                class: "btn small danger",
                type: "button",
                "aria-label": "Delete " + t.title,
                onclick: async () => {
                  if (!(await confirmDialog(`Remove "${t.title}" from the routine?`, "Remove", true))) return;
                  try {
                    const r = await api<{ trash_ids?: string[] }>(`/api/tasks/${t.id}?series=1`, { method: "DELETE" });
                    changed();
                    undoToast(`"${t.title}"`, r.trash_ids, changed);
                  } catch (e) {
                    toast(errMsg(e), true);
                  }
                },
              },
              "Delete",
            ),
          ),
        ),
      );
    }
  }
  add(
    sheet.body,
    h("p", { class: "muted" }, "Things that happen every day (or on set days). They show as a checklist at the top of Tasks."),
    listEl,
    h("button", { class: "btn primary block", type: "button", onclick: () => openItemEditor(null, changed) }, "+ Add routine item"),
  );
  void load();
}
