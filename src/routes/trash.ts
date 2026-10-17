import { Hono } from "hono";
import { requireMember, type AppEnv } from "../lib/auth";
import { emit } from "../lib/events";
import { deleteMedia } from "../lib/media";
import { scheduleReminders } from "../lib/reminders";
import { TRASH_TTL, canSeeTrash, insertStatement, type TrashData, type TrashRow } from "../lib/trash";
import { fail, now } from "../lib/util";

const trash = new Hono<AppEnv>();

/** Retention deletes for runCleanup. Expired photos/voice notes are then purged by cleanupMedia (no longer referenced). */
export function retention(t: number): [string, ...unknown[]][] {
  return [["DELETE FROM trash WHERE deleted_at < ?1", t - TRASH_TTL]];
}

const SCOPE = { item: "list", task: "tasks", message: "chat" } as const;

async function entry(db: D1Database, id: string): Promise<TrashRow | null> {
  return db.prepare("SELECT * FROM trash WHERE id = ?1 AND deleted_at >= ?2").bind(id, now() - TRASH_TTL).first<TrashRow>();
}

/** What this person may restore, newest first. */
trash.get("/trash", requireMember, async (c) => {
  const me = c.get("me");
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.kind, t.label, t.deleted_by, m.name AS deleted_by_name, t.deleted_at
     FROM trash t LEFT JOIN members m ON m.id = t.deleted_by
     WHERE t.deleted_at >= ?1 ORDER BY t.deleted_at DESC LIMIT 100`,
  )
    .bind(now() - TRASH_TTL)
    .all<Pick<TrashRow, "id" | "kind" | "label" | "deleted_by" | "deleted_at"> & { deleted_by_name: string | null }>();
  return c.json({ trash: results.filter((t) => canSeeTrash(t, me)), keep_ms: TRASH_TTL });
});

trash.post("/trash/:id/restore", requireMember, async (c) => {
  const me = c.get("me");
  const db = c.env.DB;
  const t = await entry(db, c.req.param("id"));
  if (!t || !canSeeTrash(t, me)) return fail(c, "not_found", 404);
  let data: TrashData;
  try {
    data = JSON.parse(t.data) as TrashData;
  } catch {
    return fail(c, "broken", 409);
  }
  const drop = db.prepare("DELETE FROM trash WHERE id = ?1").bind(t.id);

  if (t.kind === "item") {
    // Someone re-added it meanwhile: keep theirs and just empty the trash entry.
    const dup = await db
      .prepare("SELECT id FROM items WHERE bought_at IS NULL AND lower(name) = lower(?1) LIMIT 1")
      .bind(String(data.row.name ?? ""))
      .first<{ id: string }>();
    if (dup) {
      await drop.run();
      return c.json({ ok: true, kind: t.kind, id: dup.id, duplicate: true });
    }
  }
  const table = t.kind === "item" ? "items" : t.kind === "task" ? "tasks" : "messages";
  const stmts = [insertStatement(db, table, data.row), drop];
  for (const r of data.comments ?? []) stmts.push(insertStatement(db, "task_comments", r));
  for (const r of data.reactions ?? []) stmts.push(insertStatement(db, "message_reactions", r));
  try {
    await db.batch(stmts);
  } catch {
    return fail(c, "already_restored", 409);
  }
  await emit(c.env, c.executionCtx, SCOPE[t.kind]);
  if (t.kind === "task" && data.row.remind_at !== null && data.row.remind_at !== undefined) {
    try {
      c.executionCtx.waitUntil(scheduleReminders(c.env));
    } catch (e) {
      console.error("schedule failed", e);
    }
  }
  return c.json({ ok: true, kind: t.kind, id: t.ref_id });
});

/** Empty one entry now (e.g. a message you really want gone) instead of waiting 24 hours. */
trash.delete("/trash/:id", requireMember, async (c) => {
  const me = c.get("me");
  const t = await entry(c.env.DB, c.req.param("id"));
  if (!t || !canSeeTrash(t, me)) return fail(c, "not_found", 404);
  const db = c.env.DB;
  await db.prepare("DELETE FROM trash WHERE id = ?1").bind(t.id).run();
  // Remove the file now only if nothing else still uses it (otherwise the daily cleanup decides later).
  if (t.media_key) {
    const used = await db
      .prepare(
        `SELECT 1 FROM items WHERE photo_key = ?1 UNION ALL SELECT 1 FROM tasks WHERE done_photo_key = ?1
         UNION ALL SELECT 1 FROM messages WHERE media_key = ?1 UNION ALL SELECT 1 FROM trash WHERE media_key = ?1 LIMIT 1`,
      )
      .bind(t.media_key)
      .first();
    if (!used) await deleteMedia(c.env, t.media_key).catch((e) => console.error("deleteMedia failed", e));
  }
  return c.json({ ok: true });
});

export default trash;
