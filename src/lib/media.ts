import type { Env } from "../env";

/**
 * Marks an uploaded media object as used by a row. False if missing, not owned by ownerId, or already
 * attached: one file belongs to one row, so deleting that row (or its trash entry) can never break another.
 */
export async function attachMedia(env: Env, key: string, ownerId: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE media SET attached = 1 WHERE key = ?1 AND owner_id = ?2 AND attached = 0")
    .bind(key, ownerId)
    .run();
  return r.meta.changes > 0;
}

/** Deletes the R2 object and the media row. Safe to call for unknown keys. */
export async function deleteMedia(env: Env, key: string): Promise<void> {
  await env.MEDIA.delete(key);
  await env.DB.prepare("DELETE FROM media WHERE key = ?1").bind(key).run();
}
