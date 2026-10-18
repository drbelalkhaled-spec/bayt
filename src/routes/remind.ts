import { Hono } from "hono";
import { requireMember, type AppEnv } from "../lib/auth";
import { scheduleReminders } from "../lib/reminders";
import { fail, newId, now, readJson } from "../lib/util";

const remind = new Hono<AppEnv>();

const MIN_AHEAD_MS = 60_000;
const MAX_AHEAD_MS = 30 * 86_400_000;
const DAY_MS = 86_400_000;

/** Retention deletes for runCleanup. A deleted message can return from the trash for 24 h, so its reminder is kept a little longer. */
export function retention(t: number): [string, ...unknown[]][] {
  return [
    ["DELETE FROM message_reminders WHERE sent_at IS NOT NULL AND sent_at < ?1", t - 7 * DAY_MS],
    ["DELETE FROM message_reminders WHERE remind_at < ?1 AND message_id NOT IN (SELECT id FROM messages)", t - 2 * DAY_MS],
  ];
}

function reschedule(c: { env: AppEnv["Bindings"]; executionCtx: Pick<ExecutionContext, "waitUntil"> }): void {
  try {
    c.executionCtx.waitUntil(scheduleReminders(c.env));
  } catch (e) {
    console.error("schedule failed", e);
  }
}

remind.put("/messages/:id/remind", requireMember, async (c) => {
  const id = c.req.param("id");
  const me = c.get("me");
  const b = await readJson(c);
  const msg = await c.env.DB.prepare("SELECT id FROM messages WHERE id = ?1").bind(id).first();
  if (!msg) return fail(c, "not_found", 404);
  const t = now();
  const at = b.at;
  if (typeof at !== "number" || !Number.isInteger(at) || at < t + MIN_AHEAD_MS || at > t + MAX_AHEAD_MS) return fail(c, "bad_at", 400);
  await c.env.DB.prepare(
    `INSERT INTO message_reminders(id, member_id, message_id, remind_at, sent_at, created_at) VALUES(?1, ?2, ?3, ?4, NULL, ?5)
     ON CONFLICT(member_id, message_id) DO UPDATE SET remind_at = excluded.remind_at, sent_at = NULL`,
  )
    .bind(newId(), me.id, id, at, t)
    .run();
  reschedule(c);
  return c.json({ reminder: { message_id: id, remind_at: at } });
});

remind.delete("/messages/:id/remind", requireMember, async (c) => {
  await c.env.DB.prepare("DELETE FROM message_reminders WHERE member_id = ?1 AND message_id = ?2")
    .bind(c.get("me").id, c.req.param("id"))
    .run();
  reschedule(c);
  return c.json({ ok: true });
});

remind.get("/reminders", requireMember, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT message_id, remind_at FROM message_reminders WHERE member_id = ?1 AND sent_at IS NULL ORDER BY remind_at LIMIT 200",
  )
    .bind(c.get("me").id)
    .all<{ message_id: string; remind_at: number }>();
  return c.json({ reminders: results });
});

export default remind;
