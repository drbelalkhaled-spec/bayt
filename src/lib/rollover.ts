import type { Env } from "../env";
import { emit } from "./events";
import { nextDue, readRecur, todayIn } from "./recur";
import { reminderTimes, scheduleReminders } from "./reminders";
import { householdTz, newId, now } from "./util";

const MAX_STEPS = 400;

interface StaleRow {
  id: string;
  series_id: string | null;
  due_on: string;
  due_time: string | null;
  recur: string;
}

/**
 * A routine item nobody ticked stays open on its old day. Moves each such item to its next due date on or after
 * today (keeping the cadence), records every skipped date in task_misses, and re-arms today's reminders.
 * Returns how many tasks rolled. Idempotent; a no-op (two reads) when nothing is stale.
 */
export async function rollRoutines(env: Env, ctx: Pick<ExecutionContext, "waitUntil">, t = now()): Promise<number> {
  const tz = await householdTz(env);
  const today = todayIn(tz, t);
  const { results } = await env.DB.prepare(
    `SELECT id, series_id, due_on, due_time, recur FROM tasks
     WHERE done_at IS NULL AND slot IS NOT NULL AND recur IS NOT NULL AND due_on IS NOT NULL AND due_on < ?1`,
  )
    .bind(today)
    .all<StaleRow>();
  if (!results.length) return 0;
  const stmts: D1PreparedStatement[] = [];
  for (const r of results) {
    const recur = readRecur(r.recur);
    if (!recur) continue;
    const misses: { id: string; on: string }[] = [];
    let d = r.due_on;
    for (let i = 0; i < MAX_STEPS && d < today; i++) {
      misses.push({ id: newId(), on: d });
      d = nextDue(recur, d);
    }
    const [ra, rd] = reminderTimes(d, r.due_time, tz, t);
    // Every statement re-checks that the task is still open and untouched on its old day, so a tick racing us wins.
    stmts.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO task_misses(id, series_id, task_id, title, assignee_id, slot, due_on, created_at)
         SELECT json_extract(j.value, '$.id'), ?1, k.id, k.title, k.assignee_id, k.slot, json_extract(j.value, '$.on'), ?2
         FROM tasks k, json_each(?3) j WHERE k.id = ?4 AND k.done_at IS NULL AND k.due_on = ?5`,
      ).bind(r.series_id ?? r.id, t, JSON.stringify(misses), r.id, r.due_on),
      env.DB.prepare(
        `UPDATE tasks SET due_on = ?1, remind_at = ?2, reminded_at = ?3, seen_at = NULL, seen_by = NULL,
           blocked_at = NULL, blocked_by = NULL, blocked_reason = NULL
         WHERE id = ?4 AND done_at IS NULL AND due_on = ?5
           AND NOT EXISTS (SELECT 1 FROM tasks o WHERE o.series_id = ?6 AND o.due_on = ?1 AND o.done_at IS NULL AND o.id != ?4)`,
      ).bind(d, ra, rd, r.id, r.due_on, r.series_id ?? r.id),
      // Still on its old day means the UPDATE was skipped because the series already has an open item on `d`.
      env.DB.prepare("DELETE FROM tasks WHERE id = ?1 AND done_at IS NULL AND due_on = ?2").bind(r.id, r.due_on),
    );
  }
  if (!stmts.length) return 0;
  const res = await env.DB.batch(stmts);
  let rolled = 0;
  for (let i = 0; i < res.length; i += 3) if ((res[i + 1]?.meta.changes ?? 0) + (res[i + 2]?.meta.changes ?? 0) > 0) rolled++;
  if (rolled) {
    await emit(env, ctx, "tasks");
    ctx.waitUntil(scheduleReminders(env));
  }
  return rolled;
}
