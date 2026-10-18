import type { Env } from "../env";
import { claim, ensureVapid, pushMember, storeNotice } from "./push";
import { newId, now } from "./util";

/** At most one problem alert per parent per hour, however many errors happen. */
export const ALERT_EVERY_MS = 3_600_000;
const MAX_SOURCE = 120;
const MAX_MESSAGE = 300;
const MAX_DETAIL = 2000;
/** The log never grows past this many rows; the oldest go first. */
export const MAX_ROWS = 500;

const messageOf = (e: unknown): string => (e instanceof Error ? e.message || e.name : String(e ?? ""));

/**
 * Records a problem in error_log and pushes a short alert to parents who turned alerts on.
 * Never throws: it runs inside error handlers.
 */
export async function reportError(
  env: Env,
  source: string,
  err: unknown,
  detail?: string | null,
  memberId: string | null = null,
): Promise<void> {
  try {
    console.error(source, err);
    const message = messageOf(err).slice(0, MAX_MESSAGE) || "Unknown error";
    const extra = (detail ?? (err instanceof Error ? err.stack : null) ?? "").slice(0, MAX_DETAIL) || null;
    const t = now();
    const where = source.slice(0, MAX_SOURCE);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO error_log(id, at, source, message, detail, member_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(
        newId(),
        t,
        where,
        message,
        extra,
        memberId,
      ),
      env.DB.prepare(
        "DELETE FROM error_log WHERE id NOT IN (SELECT id FROM error_log ORDER BY at DESC, id DESC LIMIT ?1)",
      ).bind(MAX_ROWS),
    ]);
    const { results } = await env.DB.prepare(
      `SELECT id FROM members
       WHERE role = 'parent' AND error_alerts = 1 AND removed_at IS NULL
         AND EXISTS (SELECT 1 FROM push_devices WHERE member_id = members.id)`,
    ).all<{ id: string }>();
    if (!results.length) return;
    const vapid = await ensureVapid(env);
    const text = `Bayt had a problem (${where}): ${message}`.slice(0, 180);
    for (const m of results) {
      if (!(await claim(env, m.id, "error", t, ALERT_EVERY_MS))) continue;
      await storeNotice(env, m.id, { kind: "error", actorName: "Bayt", text, at: t });
      await pushMember(env, m.id, vapid, false); // false: a failing alert must not report itself again
    }
  } catch (e) {
    console.error("reportError failed", e);
  }
}
