import type { PushIntent } from "./events";
import { validTimeStr, type Quiet } from "./recur";

/** What a person wants to hear about. `quiet` silences pushes (not the in-app badges) between two household-time-zone times. */
export interface NotifyPrefs {
  chat: boolean;
  tasks: boolean;
  list: boolean;
  quiet: Quiet | null;
}

export const DEFAULT_PREFS: NotifyPrefs = { chat: true, tasks: true, list: true, quiet: null };

export type Category = "chat" | "tasks" | "list";

/** The switch that governs a kind. null = always delivered: urgent things, reminders, and the internal test/error notices. */
export function categoryOf(kind: PushIntent["kind"] | "test" | "error"): Category | null {
  switch (kind) {
    case "chat":
      return "chat";
    case "task_new":
    case "task_comment":
    case "task_seen":
    case "task_done":
    case "task_blocked":
      return "tasks";
    case "item":
    case "shopping":
      return "list";
    default:
      return null;
  }
}

/** Strictly validates and canonicalizes prefs. Returns false when invalid (missing or extra keys, wrong types, from === to). */
export function parsePrefs(v: unknown): NotifyPrefs | false {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).sort().join(",") !== "chat,list,quiet,tasks") return false;
  if (typeof o.chat !== "boolean" || typeof o.tasks !== "boolean" || typeof o.list !== "boolean") return false;
  let quiet: Quiet | null = null;
  if (o.quiet !== null) {
    const q = o.quiet;
    if (!q || typeof q !== "object" || Array.isArray(q)) return false;
    const { from, to } = q as Record<string, unknown>;
    if (Object.keys(q).sort().join(",") !== "from,to" || !validTimeStr(from) || !validTimeStr(to) || from === to) return false;
    quiet = { from, to };
  }
  return { chat: o.chat, tasks: o.tasks, list: o.list, quiet };
}

/** A member's stored prefs; the defaults when absent or corrupt. */
export function readPrefs(s: string | null | undefined): NotifyPrefs {
  if (!s) return DEFAULT_PREFS;
  try {
    return parsePrefs(JSON.parse(s)) || DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}
