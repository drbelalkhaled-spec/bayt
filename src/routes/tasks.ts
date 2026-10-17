import { Hono } from "hono";
import { requireMember, requireParent, type AppEnv } from "../lib/auth";
import { emit, type PushIntent } from "../lib/events";
import { attachMedia, deleteMedia } from "../lib/media";
import { newTrashId, trashStatement } from "../lib/trash";
import {
  SLOTS,
  nextDue,
  parseRecur,
  readRecur,
  todayIn,
  validDateStr,
  validTimeStr,
  zonedToEpoch,
  type Recur,
} from "../lib/recur";
import { REMIND_BEFORE_MS, scheduleReminders } from "../lib/reminders";
import { fail, householdTz, newId, now, readJson } from "../lib/util";

const DAY = 86_400_000;
const MAX_TITLE = 120;
const MAX_NOTE = 500;
const MAX_REASON = 200;
const MAX_ITEM = 80;
const MAX_COMMENT = 500;

const tasks = new Hono<AppEnv>();

/** Retention deletes for runCleanup: [sql, ...bindings]. */
export function retention(t: number): [string, ...unknown[]][] {
  return [
    ["DELETE FROM tasks WHERE done_at IS NOT NULL AND done_at < ?1", t - 30 * DAY],
    ["DELETE FROM task_comments WHERE task_id NOT IN (SELECT id FROM tasks)"],
  ];
}

interface TaskRow {
  id: string;
  title: string;
  note: string | null;
  assignee_id: string | null;
  due_on: string | null;
  due_time: string | null;
  remind_at: number | null;
  reminded_at: number | null;
  recur: string | null;
  slot: string | null;
  series_id: string | null;
  done_photo_key: string | null;
  blocked_at: number | null;
  blocked_by: string | null;
  blocked_reason: string | null;
  seen_at: number | null;
  seen_by: string | null;
  urgent: number;
  created_by: string;
  created_at: number;
  done_by: string | null;
  done_at: number | null;
}

const SELECT = `SELECT t.id, t.title, t.note, t.assignee_id, a.name AS assignee_name, t.due_on, t.due_time,
    t.remind_at, t.reminded_at, t.recur, t.slot, t.series_id, t.done_photo_key,
    t.blocked_at, t.blocked_by, bb.name AS blocked_by_name, t.blocked_reason,
    t.seen_at, t.seen_by, sb.name AS seen_by_name, t.urgent,
    (SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id) AS comment_count,
    (SELECT c.created_at FROM task_comments c WHERE c.task_id = t.id ORDER BY c.created_at DESC LIMIT 1) AS last_comment_at,
    (SELECT c.author_id FROM task_comments c WHERE c.task_id = t.id ORDER BY c.created_at DESC LIMIT 1) AS last_comment_by,
    t.created_by, cb.name AS created_by_name, t.created_at, t.done_by, db.name AS done_by_name, t.done_at
  FROM tasks t
  LEFT JOIN members a ON a.id = t.assignee_id
  LEFT JOIN members cb ON cb.id = t.created_by
  LEFT JOIN members db ON db.id = t.done_by
  LEFT JOIN members bb ON bb.id = t.blocked_by
  LEFT JOIN members sb ON sb.id = t.seen_by`;

/** API shape: recur is returned as an object (or null), not the stored JSON string; urgent as a boolean. */
const out = (r: Record<string, unknown> | null) =>
  r ? { ...r, recur: readRecur(r.recur as string | null), urgent: !!r.urgent } : null;

const validTitle = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length >= 1 && v.trim().length <= MAX_TITLE;
const validNote = (v: unknown): v is string | null => v === null || (typeof v === "string" && v.length <= MAX_NOTE);
const validDate = (v: unknown): v is string | null => v === null || validDateStr(v);
const validTime = (v: unknown): v is string | null => v === null || validTimeStr(v);
const validSlot = (v: unknown): v is string | null => v === null || (SLOTS as readonly unknown[]).includes(v);
const EDIT_KEYS = ["title", "note", "assignee_id", "due_on", "due_time", "recur", "slot", "urgent"];
const NANNY_KEYS = new Set(["done", "done_photo_key", "blocked", "seen"]);

async function activeMember(db: D1Database, id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !id) return false;
  return !!(await db.prepare("SELECT 1 FROM members WHERE id = ?1 AND removed_at IS NULL").bind(id).first());
}

async function activeIds(db: D1Database, role: "parent" | "nanny", exceptId?: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM members WHERE role = ?1 AND removed_at IS NULL")
    .bind(role)
    .all<{ id: string }>();
  return results.map((r) => r.id).filter((id) => id !== exceptId);
}

const getTask = async (db: D1Database, id: string) =>
  out(await db.prepare(SELECT + " WHERE t.id = ?1").bind(id).first());

/** remind_at / reminded_at for a date+time: 15 min before; already-past due moments are marked reminded. */
function reminder(due: string | null, time: string | null, tz: string, t: number): [number | null, number | null] {
  if (!due || !time) return [null, null];
  const at = zonedToEpoch(due, time, tz);
  return [at - REMIND_BEFORE_MS, at <= t ? t : null];
}

/** True when the uploaded media exists, is an image and belongs to ownerId. */
async function ownImage(db: D1Database, key: unknown, ownerId: string): Promise<boolean> {
  if (typeof key !== "string" || !key || key.length > 64) return false;
  const m = await db
    .prepare("SELECT content_type FROM media WHERE key = ?1 AND owner_id = ?2")
    .bind(key, ownerId)
    .first<{ content_type: string }>();
  return !!m && m.content_type.startsWith("image/");
}

function reschedule(c: { env: AppEnv["Bindings"]; executionCtx: Pick<ExecutionContext, "waitUntil"> }): void {
  try {
    c.executionCtx.waitUntil(scheduleReminders(c.env));
  } catch (e) {
    console.error("schedule failed", e);
  }
}

tasks.get("/tasks", requireMember, async (c) => {
  const me = c.get("me");
  const mine = c.req.query("mine") === "1";
  const filter = mine ? " AND (t.assignee_id = ?2 OR t.assignee_id IS NULL)" : "";
  const run = (sql: string, first: unknown) => {
    const s = c.env.DB.prepare(sql);
    return (mine ? s.bind(first, me.id) : s.bind(first)).all<Record<string, unknown>>();
  };
  const open = await run(
    SELECT +
      ` WHERE t.done_at IS NULL AND ?1 = ?1${filter}
        ORDER BY t.urgent DESC, (t.due_on IS NULL), t.due_on ASC, (t.due_time IS NULL), t.due_time ASC, t.created_at ASC`,
    0,
  );
  const done = await run(
    SELECT + ` WHERE t.done_at IS NOT NULL AND t.done_at >= ?1${filter} ORDER BY t.done_at DESC`,
    now() - DAY,
  );
  return c.json({ open: open.results.map(out), done: done.results.map(out) });
});

tasks.post("/tasks", requireMember, requireParent, async (c) => {
  const b = await readJson(c);
  const me = c.get("me");
  if (!validTitle(b.title)) return fail(c, "bad_title", 400);
  const note = b.note === undefined ? null : b.note;
  if (!validNote(note)) return fail(c, "bad_note", 400);
  const dueIn = b.due_on === undefined ? null : b.due_on;
  if (!validDate(dueIn)) return fail(c, "bad_due_on", 400);
  let due: string | null = dueIn;
  const time = b.due_time === undefined ? null : b.due_time;
  if (!validTime(time)) return fail(c, "bad_due_time", 400);
  const recur = b.recur === undefined ? null : parseRecur(b.recur);
  if (recur === false) return fail(c, "bad_recur", 400);
  const slot = b.slot === undefined ? null : b.slot;
  if (!validSlot(slot) || (slot !== null && !recur)) return fail(c, "bad_slot", 400);
  const assignee = b.assignee_id === undefined ? null : b.assignee_id;
  if (assignee !== null && !(await activeMember(c.env.DB, assignee))) return fail(c, "bad_assignee", 400);
  if (b.urgent !== undefined && typeof b.urgent !== "boolean") return fail(c, "bad_urgent", 400);
  const urgent = b.urgent === true;
  const t = now();
  const tz = recur || time ? await householdTz(c.env) : "UTC";
  if (recur && !due) due = todayIn(tz, t);
  if (time && !due) return fail(c, "bad_due_time", 400);
  const [remindAt, remindedAt] = reminder(due, time, tz, t);
  const id = newId();
  await c.env.DB.prepare(
    `INSERT INTO tasks(id, title, note, assignee_id, due_on, due_time, remind_at, reminded_at, recur, slot, series_id,
       created_by, created_at, urgent) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
  )
    .bind(
      id,
      b.title.trim(),
      note || null,
      assignee,
      due,
      time,
      remindAt,
      remindedAt,
      recur ? JSON.stringify(recur) : null,
      slot,
      recur ? id : null,
      me.id,
      t,
      urgent ? 1 : 0,
    )
    .run();
  const to = assignee ? (assignee === me.id ? [] : [assignee as string]) : await activeIds(c.env.DB, "nanny");
  const push: PushIntent | undefined = !to.length
    ? undefined
    : urgent
      ? { kind: "task_urgent", to, actorId: me.id, text: `Urgent from ${me.name}: ${b.title.trim()}` }
      : { kind: "task_new", to, actorId: me.id };
  await emit(c.env, c.executionCtx, "tasks", push);
  if (remindAt !== null) reschedule(c);
  return c.json({ task: await getTask(c.env.DB, id) });
});

tasks.patch("/tasks/:id", requireMember, async (c) => {
  const id = c.req.param("id");
  const me = c.get("me");
  const parent = me.role === "parent";
  const b = await readJson(c);
  const db = c.env.DB;
  const row = await db.prepare("SELECT * FROM tasks WHERE id = ?1").bind(id).first<TaskRow>();
  if (!row) return fail(c, "not_found", 404);

  if (!parent) {
    if (Object.keys(b).some((k) => !NANNY_KEYS.has(k))) return fail(c, "forbidden", 403);
    if (row.assignee_id && row.assignee_id !== me.id) return fail(c, "forbidden", 403);
  }
  if (b.done !== undefined && typeof b.done !== "boolean") return fail(c, "bad_done", 400);
  if (b.seen !== undefined && b.seen !== true) return fail(c, "bad_seen", 400);

  const t = now();
  const sets: string[] = [];
  const args: unknown[] = [];
  const set = (col: string, v: unknown) => {
    args.push(v);
    sets.push(`${col} = ?${args.length}`);
  };

  // ---- field edits (parents only; nanny keys were filtered above) ----
  if (b.title !== undefined) {
    if (!validTitle(b.title)) return fail(c, "bad_title", 400);
    set("title", b.title.trim());
  }
  if (b.note !== undefined) {
    if (!validNote(b.note)) return fail(c, "bad_note", 400);
    set("note", b.note || null);
  }
  if (b.assignee_id !== undefined) {
    if (b.assignee_id !== null && !(await activeMember(db, b.assignee_id))) return fail(c, "bad_assignee", 400);
    set("assignee_id", b.assignee_id);
  }
  let becameUrgent = false;
  if (b.urgent !== undefined) {
    if (typeof b.urgent !== "boolean") return fail(c, "bad_urgent", 400);
    if (b.urgent !== !!row.urgent) {
      set("urgent", b.urgent ? 1 : 0);
      becameUrgent = b.urgent && row.done_at === null;
    }
  }
  if (b.due_on !== undefined && !validDate(b.due_on)) return fail(c, "bad_due_on", 400);
  if (b.due_time !== undefined && !validTime(b.due_time)) return fail(c, "bad_due_time", 400);
  let recur: Recur | null = readRecur(row.recur);
  if (b.recur !== undefined) {
    const r = parseRecur(b.recur);
    if (r === false) return fail(c, "bad_recur", 400);
    recur = r;
  }
  const slot = b.slot !== undefined ? b.slot : row.slot;
  if (!validSlot(slot) || (slot !== null && !recur)) return fail(c, "bad_slot", 400);
  let due = (b.due_on !== undefined ? b.due_on : row.due_on) as string | null;
  const time = (b.due_time !== undefined ? b.due_time : row.due_time) as string | null;
  const needTz = !!recur || !!time;
  const tz = needTz ? await householdTz(c.env) : "UTC";
  if (recur && !due) due = todayIn(tz, t);
  if (time && !due) return fail(c, "bad_due_time", 400);
  if (b.recur !== undefined) {
    set("recur", recur ? JSON.stringify(recur) : null);
    if (recur && !row.series_id) set("series_id", row.id);
  }
  if (b.slot !== undefined) set("slot", slot);
  if (due !== row.due_on) set("due_on", due);
  if (time !== row.due_time) set("due_time", time);
  let remindAt = row.remind_at;
  if (due !== row.due_on || time !== row.due_time) {
    const [ra, rd] = reminder(due, time, tz, t);
    remindAt = ra;
    set("remind_at", ra);
    set("reminded_at", rd);
  }

  // ---- blocked ("couldn't do it") ----
  let blockReason: string | null = null;
  let blockItem: string | null = null;
  let clearBlock = parent && EDIT_KEYS.some((k) => b[k] !== undefined);
  if (b.blocked !== undefined) {
    if (b.blocked === null) {
      if (!parent && row.blocked_by !== me.id) return fail(c, "forbidden", 403);
      clearBlock = true;
    } else {
      const bl = b.blocked as Record<string, unknown>;
      if (!bl || typeof bl !== "object" || Array.isArray(bl)) return fail(c, "bad_blocked", 400);
      if (typeof bl.reason !== "string" || !bl.reason.trim() || bl.reason.trim().length > MAX_REASON)
        return fail(c, "bad_reason", 400);
      if (bl.add_item !== undefined && bl.add_item !== null) {
        if (typeof bl.add_item !== "string" || bl.add_item.trim().length > MAX_ITEM) return fail(c, "bad_item", 400);
        blockItem = bl.add_item.trim() || null;
      }
      if (row.assignee_id && row.assignee_id !== me.id) return fail(c, "forbidden", 403);
      if (row.done_at !== null || b.done === true) return fail(c, "already_done", 400);
      blockReason = bl.reason.trim();
      clearBlock = false;
    }
  }

  // ---- seen ("OK, I'll do it", before doing it) ----
  // A parent's real change to what the task says asks the helper to look again.
  const edited =
    parent &&
    ((b.title !== undefined && (b.title as string).trim() !== row.title) ||
      (b.note !== undefined && (b.note || null) !== row.note) ||
      (b.assignee_id !== undefined && b.assignee_id !== row.assignee_id) ||
      due !== row.due_on ||
      time !== row.due_time);
  let becameSeen = false;
  if (b.seen === true) {
    if (row.assignee_id && row.assignee_id !== me.id) return fail(c, "forbidden", 403);
    if (row.done_at !== null) return fail(c, "already_done", 400);
    if (row.seen_at === null || edited) {
      set("seen_at", t);
      set("seen_by", me.id);
      becameSeen = true;
    }
  } else if (edited && row.seen_at !== null) {
    set("seen_at", null);
    set("seen_by", null);
  }

  // ---- done / undo ----
  let becameDone = false;
  let undone = false;
  if (b.done === true && row.done_at === null) {
    set("done_by", me.id);
    set("done_at", t);
    if (row.seen_at === null && !becameSeen) {
      set("seen_at", t);
      set("seen_by", me.id);
    }
    becameDone = true;
    clearBlock = true;
  } else if (b.done === false) {
    // Helpers may only undo their own completions (matches the client's Undo rule).
    if (!parent && row.done_at !== null && row.done_by !== me.id) return fail(c, "forbidden", 403);
    set("done_by", null);
    set("done_at", null);
    undone = row.done_at !== null;
    if (row.done_photo_key && b.done_photo_key === undefined) set("done_photo_key", null);
  }
  if (blockReason !== null) {
    set("blocked_at", t);
    set("blocked_by", me.id);
    set("blocked_reason", blockReason);
  } else if (clearBlock && row.blocked_at !== null) {
    set("blocked_at", null);
    set("blocked_by", null);
    set("blocked_reason", null);
  }

  // ---- done photo ----
  let oldPhoto: string | null = undone ? row.done_photo_key : null;
  if (b.done_photo_key !== undefined) {
    const isDone = becameDone || (row.done_at !== null && !undone);
    const completer = becameDone || row.done_by === me.id;
    if (!parent && !completer) return fail(c, "forbidden", 403);
    if (b.done_photo_key !== null) {
      if (!isDone) return fail(c, "not_done", 400);
      if (b.done_photo_key !== row.done_photo_key) {
        if (!(await ownImage(db, b.done_photo_key, me.id))) return fail(c, "bad_photo", 400);
        if (!(await attachMedia(c.env, b.done_photo_key as string, me.id))) return fail(c, "bad_photo", 400);
        set("done_photo_key", b.done_photo_key);
        oldPhoto = row.done_photo_key;
      }
    } else {
      set("done_photo_key", null);
      oldPhoto = row.done_photo_key;
    }
  }

  // ---- write ----
  const stmts: D1PreparedStatement[] = [];
  if (sets.length) {
    args.push(id);
    stmts.push(db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?${args.length}`).bind(...args));
  }
  let nextRemind: number | null = null;
  if (becameDone && recur && due) {
    const series = row.series_id ?? row.id;
    const today = todayIn(tz, t);
    const nd = nextDue(recur, due > today ? due : today);
    const [ra, rd] = reminder(nd, time, tz, t);
    nextRemind = ra;
    const title = b.title !== undefined ? (b.title as string).trim() : row.title;
    const note = b.note !== undefined ? (b.note as string | null) || null : row.note;
    const assignee = b.assignee_id !== undefined ? (b.assignee_id as string | null) : row.assignee_id;
    stmts.push(
      db
        .prepare(
          `INSERT INTO tasks(id, title, note, assignee_id, due_on, due_time, remind_at, reminded_at, recur, slot, series_id,
             created_by, created_at, urgent)
           SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?15
           WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE series_id = ?11 AND due_on = ?5 AND done_at IS NULL AND id != ?14)`,
        )
        .bind(newId(), title, note, assignee, nd, time, ra, rd, JSON.stringify(recur), slot, series, row.created_by, t, id, (b.urgent ?? !!row.urgent) ? 1 : 0),
    );
    if (!row.series_id && b.recur === undefined) stmts.push(db.prepare("UPDATE tasks SET series_id = ?1 WHERE id = ?1").bind(id));
  }
  if (undone && row.done_at !== null && (row.series_id || row.recur)) {
    // Remove the occurrence auto-created when this one was ticked, if nobody has touched it since.
    stmts.push(
      db
        .prepare(
          `DELETE FROM tasks WHERE series_id = ?1 AND created_at = ?2 AND id != ?3 AND done_at IS NULL AND blocked_at IS NULL
             AND title = ?4 AND note IS ?5 AND assignee_id IS ?6 AND due_time IS ?7 AND slot IS ?8 AND recur IS ?9`,
        )
        .bind(row.series_id ?? row.id, row.done_at, id, row.title, row.note, row.assignee_id, row.due_time, row.slot, row.recur),
    );
  }
  let itemAdded = false;
  if (blockItem) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO items(id, name, added_by, added_at) SELECT ?1, ?2, ?3, ?4
           WHERE NOT EXISTS (SELECT 1 FROM items WHERE bought_at IS NULL AND lower(name) = lower(?2))`,
        )
        .bind(newId(), blockItem, me.id, t),
    );
  }
  if (stmts.length) {
    const res = await db.batch(stmts);
    if (blockItem) itemAdded = (res[res.length - 1]?.meta.changes ?? 0) > 0;
  }
  if (oldPhoto) {
    try {
      await deleteMedia(c.env, oldPhoto);
    } catch (e) {
      console.error("photo delete failed", e);
    }
  }

  // ---- notify ----
  let push: PushIntent | undefined;
  if (becameDone) {
    const to = await activeIds(db, "parent", me.id);
    if (to.length) push = { kind: "task_done", to, actorId: me.id };
  } else if (blockReason !== null) {
    const to = await activeIds(db, "parent", me.id);
    const title = b.title !== undefined ? (b.title as string).trim() : row.title;
    if (to.length)
      push = { kind: "task_blocked", to, actorId: me.id, text: `${me.name} couldn't do "${title}": ${blockReason}` };
  } else if (becameSeen) {
    const to = await activeIds(db, "parent", me.id);
    if (to.length) push = { kind: "task_seen", to, actorId: me.id, text: `${me.name} will do "${row.title}"` };
  } else if (becameUrgent) {
    const assignee = (b.assignee_id !== undefined ? b.assignee_id : row.assignee_id) as string | null;
    const to = assignee ? (assignee === me.id ? [] : [assignee]) : await activeIds(db, "nanny");
    const title = b.title !== undefined ? (b.title as string).trim() : row.title;
    if (to.length) push = { kind: "task_urgent", to, actorId: me.id, text: `Urgent from ${me.name}: ${title}` };
  }
  await emit(c.env, c.executionCtx, "tasks", push);
  if (itemAdded) await emit(c.env, c.executionCtx, "list");
  if (row.remind_at !== null || remindAt !== null || nextRemind !== null) reschedule(c);
  return c.json({ task: await getTask(db, id) });
});

tasks.delete("/tasks/:id", requireMember, requireParent, async (c) => {
  const id = c.req.param("id");
  const db = c.env.DB;
  const row = await db.prepare("SELECT id, series_id FROM tasks WHERE id = ?1").bind(id).first<{
    id: string;
    series_id: string | null;
  }>();
  if (!row) return fail(c, "not_found", 404);
  const where =
    c.req.query("series") === "1"
      ? ["id = ?1 OR (series_id = ?2 AND done_at IS NULL)", [id, row.series_id ?? id]]
      : ["id = ?1", [id]];
  const victims = await db
    .prepare(`SELECT * FROM tasks WHERE ${where[0]}`)
    .bind(...(where[1] as string[]))
    .all<Record<string, unknown>>();
  // Each deleted task (with its questions) goes to the trash for 24 hours; photos stay until it expires.
  const me = c.get("me");
  const trashIds: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const row of victims.results) {
    const comments = (
      await db.prepare("SELECT * FROM task_comments WHERE task_id = ?1").bind(row.id).all<Record<string, unknown>>()
    ).results;
    const tid = newTrashId();
    trashIds.push(tid);
    stmts.push(
      trashStatement(db, {
        id: tid,
        kind: "task",
        refId: String(row.id),
        label: String(row.title ?? "Task"),
        data: { row, comments },
        mediaKey: (row.done_photo_key as string | null) ?? null,
        by: me.id,
      }),
    );
  }
  stmts.push(db.prepare(`DELETE FROM tasks WHERE ${where[0]}`).bind(...(where[1] as string[])));
  stmts.push(db.prepare("DELETE FROM task_comments WHERE task_id NOT IN (SELECT id FROM tasks)"));
  await db.batch(stmts);
  await emit(c.env, c.executionCtx, "tasks");
  if (victims.results.some((v) => v.remind_at !== null)) reschedule(c);
  return c.json({ ok: true, deleted: victims.results.length, trash_ids: trashIds });
});

// ---- questions: a short thread on one task ----

const COMMENT_SELECT = `SELECT c.id, c.task_id, c.author_id, m.name AS author_name, c.body, c.created_at
  FROM task_comments c LEFT JOIN members m ON m.id = c.author_id`;

tasks.get("/tasks/:id/comments", requireMember, async (c) => {
  const id = c.req.param("id");
  if (!(await c.env.DB.prepare("SELECT 1 FROM tasks WHERE id = ?1").bind(id).first())) return fail(c, "not_found", 404);
  const { results } = await c.env.DB.prepare(COMMENT_SELECT + " WHERE c.task_id = ?1 ORDER BY c.created_at ASC, c.id ASC")
    .bind(id)
    .all();
  return c.json({ comments: results });
});

tasks.post("/tasks/:id/comments", requireMember, async (c) => {
  const id = c.req.param("id");
  const me = c.get("me");
  const b = await readJson(c);
  const body = typeof b.body === "string" ? b.body.trim() : "";
  if (!body || body.length > MAX_COMMENT) return fail(c, "bad_body", 400);
  const db = c.env.DB;
  const task = await db.prepare("SELECT title, assignee_id FROM tasks WHERE id = ?1").bind(id).first<{
    title: string;
    assignee_id: string | null;
  }>();
  if (!task) return fail(c, "not_found", 404);
  const cid = newId();
  await db
    .prepare("INSERT INTO task_comments(id, task_id, author_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(cid, id, me.id, body, now())
    .run();
  // Parents always hear; so does whoever the task is for (every helper when it is for anyone).
  const to = [
    ...(await activeIds(db, "parent", me.id)),
    ...(task.assignee_id ? [task.assignee_id] : await activeIds(db, "nanny", me.id)),
  ];
  const short = body.length > 100 ? body.slice(0, 99) + "…" : body;
  await emit(c.env, c.executionCtx, "tasks", {
    kind: "task_comment",
    to,
    actorId: me.id,
    text: `${me.name} on "${task.title}": ${short}`,
  });
  return c.json({ comment: await db.prepare(COMMENT_SELECT + " WHERE c.id = ?1").bind(cid).first() });
});

export default tasks;
