import type { Env } from "../env";
import { retention as itemsRetention } from "../routes/items";
import { retention as messagesRetention } from "../routes/messages";
import { retention as tasksRetention } from "../routes/tasks";

const DAY = 86_400_000;

/** Each entry is [sql, ...bindings]; all run in one DB.batch. Feature modules export retention(now). */
function statements(now: number): [string, ...unknown[]][] {
  return [
    ["DELETE FROM invites WHERE expires_at < ?1", now - 7 * DAY],
    ["DELETE FROM config WHERE k LIKE 'rl:%' AND json_valid(v) AND json_extract(v, '$.until') < ?1", now - DAY],
    ...itemsRetention(now),
    ...tasksRetention(now),
    ...messagesRetention(now),
  ];
}

export async function runCleanup(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch(statements(now).map(([sql, ...args]) => env.DB.prepare(sql).bind(...args)));
}

const MEDIA_GRACE = DAY;

async function purge(env: Env, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    await env.MEDIA.delete(chunk);
    const ph = chunk.map((_, j) => "?" + (j + 1)).join(",");
    await env.DB.prepare(`DELETE FROM media WHERE key IN (${ph})`).bind(...chunk).run();
  }
}

/** Deletes (R2 + row) unattached media older than 24 h, and attached media no longer referenced by any row. Run after runCleanup. */
export async function cleanupMedia(env: Env, now = Date.now()): Promise<void> {
  const stale = await env.DB.prepare("SELECT key FROM media WHERE attached = 0 AND created_at < ?1 LIMIT 1000")
    .bind(now - MEDIA_GRACE)
    .all<{ key: string }>();
  await purge(env, stale.results.map((r) => r.key));
  const orphans = await env.DB.prepare(
    `SELECT key FROM media WHERE attached = 1
       AND key NOT IN (SELECT photo_key FROM items WHERE photo_key IS NOT NULL)
       AND key NOT IN (SELECT done_photo_key FROM tasks WHERE done_photo_key IS NOT NULL)
       AND key NOT IN (SELECT media_key FROM messages WHERE media_key IS NOT NULL)
     LIMIT 1000`,
  ).all<{ key: string }>();
  await purge(env, orphans.results.map((r) => r.key));
}
