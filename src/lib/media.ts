import type { Env } from "../env";

/** Marks an uploaded media object as used by a row. False if missing or not owned by ownerId. */
export async function attachMedia(env: Env, key: string, ownerId: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE media SET attached = 1 WHERE key = ?1 AND owner_id = ?2")
    .bind(key, ownerId)
    .run();
  return r.meta.changes > 0;
}

/** Deletes the R2 object and the media row. Safe to call for unknown keys. */
export async function deleteMedia(env: Env, key: string): Promise<void> {
  await env.MEDIA.delete(key);
  await env.DB.prepare("DELETE FROM media WHERE key = ?1").bind(key).run();
}
