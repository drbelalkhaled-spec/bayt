import { Hono } from "hono";
import { requireMember, requireParent, type AppEnv } from "../lib/auth";
import { reportError } from "../lib/errors";
import { fail, now, readJson } from "../lib/util";

const DAY = 86_400_000;
/** Screen errors one person may send per hour (a looping bug must not flood the log). */
const CLIENT_PER_HOUR = 20;
const LIST_LIMIT = 50;

const errors = new Hono<AppEnv>();

/** Retention deletes for runCleanup: [sql, ...bindings]. */
export function retention(t: number): [string, ...unknown[]][] {
  return [["DELETE FROM error_log WHERE at < ?1", t - 30 * DAY]];
}

/** A screen error from someone's phone. */
errors.post("/errors", requireMember, async (c) => {
  const me = c.get("me");
  const b = await readJson(c);
  if (typeof b.message !== "string" || !b.message.trim()) return fail(c, "bad_message", 400);
  if (b.stack !== undefined && b.stack !== null && typeof b.stack !== "string") return fail(c, "bad_stack", 400);
  if (b.where !== undefined && b.where !== null && typeof b.where !== "string") return fail(c, "bad_where", 400);
  const source = `app · ${me.name}`;
  // Counted by member id, not name: a parent can rename themselves.
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM error_log WHERE member_id = ?1 AND at > ?2")
    .bind(me.id, now() - 3_600_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= CLIENT_PER_HOUR) return fail(c, "too_many", 429);
  const where = typeof b.where === "string" && b.where ? `on ${b.where.slice(0, 60)}\n` : "";
  await reportError(c.env, source, b.message.trim(), where + (typeof b.stack === "string" ? b.stack : ""), me.id);
  return c.json({ ok: true });
});

errors.get("/errors", requireMember, requireParent, async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, at, source, message, detail FROM error_log ORDER BY at DESC, id DESC LIMIT ?1",
  )
    .bind(LIST_LIMIT)
    .all();
  const row = await c.env.DB.prepare("SELECT error_alerts FROM members WHERE id = ?1")
    .bind(c.get("me").id)
    .first<{ error_alerts: number }>();
  return c.json({ errors: results, alerts: !!row?.error_alerts });
});

errors.delete("/errors", requireMember, requireParent, async (c) => {
  await c.env.DB.prepare("DELETE FROM error_log").run();
  return c.json({ ok: true });
});

errors.put("/errors/alerts", requireMember, requireParent, async (c) => {
  const b = await readJson(c);
  if (typeof b.on !== "boolean") return fail(c, "bad_on", 400);
  await c.env.DB.prepare("UPDATE members SET error_alerts = ?1 WHERE id = ?2").bind(b.on ? 1 : 0, c.get("me").id).run();
  return c.json({ alerts: b.on });
});

export default errors;
