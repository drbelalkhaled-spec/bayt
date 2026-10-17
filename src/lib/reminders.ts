import type { Env } from "../env";
import { reportError } from "./errors";
import { deliver } from "./push";
import { now } from "./util";

export const REMIND_BEFORE_MS = 15 * 60_000;
const BATCH = 50;

const PENDING = "remind_at IS NOT NULL AND reminded_at IS NULL AND done_at IS NULL AND blocked_at IS NULL";

/** Earliest pending reminder time, or null when nothing is pending. */
export async function nextReminderAt(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(`SELECT MIN(remind_at) AS t FROM tasks WHERE ${PENDING}`).first<{ t: number | null }>();
  return row?.t ?? null;
}

/**
 * Asks the Household DO to (re)arm its alarm for the earliest pending reminder.
 * Call via ctx.waitUntil after any task mutation that may change remind_at. Never throws.
 */
export async function scheduleReminders(env: Env): Promise<void> {
  try {
    const stub = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName("home"));
    const r = await stub.fetch("https://do/schedule", { method: "POST" });
    await r.body?.cancel();
  } catch (e) {
    console.error("scheduleReminders failed", e);
  }
}

interface DueRow {
  id: string;
  title: string;
  assignee_id: string | null;
  created_by: string;
  due_time: string | null;
}

/**
 * Sends every due reminder once (claims reminded_at first, so a retried alarm never double-sends).
 * Returns how many were claimed (reminded_at set). Used by the DO alarm.
 */
export async function sendDueReminders(env: Env, t = now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, title, assignee_id, created_by, due_time FROM tasks WHERE ${PENDING} AND remind_at <= ?1
     ORDER BY remind_at LIMIT ${BATCH}`,
  )
    .bind(t)
    .all<DueRow>();
  if (!results.length) return 0;
  let nannies: string[] | null = null;
  let sent = 0;
  for (const r of results) {
    const claimed = await env.DB.prepare(`UPDATE tasks SET reminded_at = ?1 WHERE id = ?2 AND ${PENDING}`)
      .bind(t, r.id)
      .run();
    if (!claimed.meta.changes) continue;
    sent++;
    let to: string[];
    if (r.assignee_id) to = [r.assignee_id];
    else {
      nannies ??= (
        await env.DB.prepare("SELECT id FROM members WHERE role = 'nanny' AND removed_at IS NULL").all<{ id: string }>()
      ).results.map((m) => m.id);
      to = nannies;
    }
    if (!to.length) continue;
    // deliver() never notifies the actor; a self-assigned reminder must still reach its creator.
    const actorId = to.includes(r.created_by) ? "system" : r.created_by;
    try {
      await deliver(env, { kind: "reminder", to, actorId, text: `Reminder: ${r.title} at ${r.due_time ?? ""}`.trim() });
    } catch (e) {
      await reportError(env, "reminders", e);
    }
  }
  return sent;
}
