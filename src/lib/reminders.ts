import type { Env } from "../env";
import { reportError } from "./errors";
import { deliver } from "./push";
import { now } from "./util";

export const REMIND_BEFORE_MS = 15 * 60_000;
const BATCH = 50;

const PENDING = "remind_at IS NOT NULL AND reminded_at IS NULL AND done_at IS NULL AND blocked_at IS NULL";

/** Earliest pending task or message reminder time, or null when nothing is pending. */
export async function nextReminderAt(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT MIN(t) AS t FROM (
       SELECT MIN(remind_at) AS t FROM tasks WHERE ${PENDING}
       UNION ALL SELECT MIN(remind_at) FROM message_reminders WHERE sent_at IS NULL
     )`,
  ).first<{ t: number | null }>();
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

interface DueMessageRow {
  id: string;
  member_id: string;
  body: string | null;
  kind: string | null;
  author_name: string | null;
}

const oneLine = (s: string, max: number): string => s.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Sends every due "remind me" on a chat message to the member who set it, once (claims sent_at first).
 * A message deleted meanwhile is marked sent and skipped. Returns how many were claimed. Used by the DO alarm.
 */
export async function sendDueMessageReminders(env: Env, t = now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT r.id, r.member_id, m.body, m.kind, a.name AS author_name
     FROM message_reminders r LEFT JOIN messages m ON m.id = r.message_id LEFT JOIN members a ON a.id = m.author_id
     WHERE r.sent_at IS NULL AND r.remind_at <= ?1 ORDER BY r.remind_at LIMIT ${BATCH}`,
  )
    .bind(t)
    .all<DueMessageRow>();
  let sent = 0;
  for (const r of results) {
    const claimed = await env.DB.prepare("UPDATE message_reminders SET sent_at = ?1 WHERE id = ?2 AND sent_at IS NULL")
      .bind(t, r.id)
      .run();
    if (!claimed.meta.changes) continue;
    sent++;
    if (r.kind === null) continue; // the message is gone
    const caption = oneLine(r.body ?? "", 80);
    const what =
      r.kind === "photo"
        ? "📷 Photo"
        : r.kind === "voice"
          ? "🎤 Voice note"
          : r.kind === "location"
            ? "📍 Location"
            : r.kind === "video"
              ? `🎬 ${caption || "Video"}`
              : caption;
    try {
      await deliver(env, {
        kind: "msg_reminder",
        to: [r.member_id],
        actorId: "system",
        text: `Reminder: "${what}" — from ${r.author_name || "Someone"}`,
      });
    } catch (e) {
      await reportError(env, "reminders", e);
    }
  }
  return sent;
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
