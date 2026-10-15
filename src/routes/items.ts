import { Hono, type Context } from "hono";
import { requireMember, type AppEnv } from "../lib/auth";
import { CATEGORIES, guessCategory, isCategory } from "../lib/categories";
import { emit } from "../lib/events";
import { attachMedia, deleteMedia } from "../lib/media";
import { clientId, fail, newId, now, readJson } from "../lib/util";

const BOUGHT_TTL = 48 * 3_600_000; // bought items are hidden after this...
const HISTORY_TTL = 90 * 24 * 3_600_000; // ...but kept as history (for "usual items") until this
const SUGGEST_WINDOW = 60 * 24 * 3_600_000;
const USUAL_WINDOW = 90 * 24 * 3_600_000;
const SHOPPING_TTL = 3 * 3_600_000;
const MAX_NAME = 80;
const MAX_QTY = 20;
const MAX_NOTE = 200;

const items = new Hono<AppEnv>();

/** Retention deletes for runCleanup: [sql, ...bindings]. Orphaned photos are purged by cleanupMedia. */
export function retention(nowMs: number): [string, ...unknown[]][] {
  return [["DELETE FROM items WHERE bought_at IS NOT NULL AND bought_at < ?", nowMs - HISTORY_TTL]];
}

const SELECT = `SELECT i.id, i.name, i.qty, i.note, i.added_by, a.name AS added_by_name, i.added_at,
    i.bought_by, b.name AS bought_by_name, i.bought_at, i.category, i.photo_key
  FROM items i
  LEFT JOIN members a ON a.id = i.added_by
  LEFT JOIN members b ON b.id = i.bought_by`;

const withCat = (r: Record<string, unknown>): Record<string, unknown> => ({
  ...r,
  category: typeof r.category === "string" && isCategory(r.category) ? r.category : guessCategory(String(r.name ?? "")),
});

const getItem = async (c: Context<AppEnv>, id: string) => {
  const r = await c.env.DB.prepare(`${SELECT} WHERE i.id = ?1`).bind(id).first<Record<string, unknown>>();
  return r ? withCat(r) : r;
};

/** Photo key must be an image uploaded by `ownerId`. Marks it attached. */
async function claimPhoto(c: Context<AppEnv>, key: string, ownerId: string): Promise<boolean> {
  const m = await c.env.DB.prepare("SELECT content_type FROM media WHERE key = ?1 AND owner_id = ?2")
    .bind(key, ownerId)
    .first<{ content_type: string }>();
  if (!m || !m.content_type.toLowerCase().startsWith("image/")) return false;
  return attachMedia(c.env, key, ownerId);
}

async function shoppingStatus(c: Context<AppEnv>): Promise<{ member_id: string; name: string; since: number } | null> {
  const row = await c.env.DB.prepare("SELECT v FROM config WHERE k = 'shopping'").first<{ v: string }>();
  if (!row) return null;
  let s: { member_id?: unknown; since?: unknown } | null;
  try {
    s = JSON.parse(row.v) as { member_id?: unknown; since?: unknown } | null;
  } catch {
    return null;
  }
  if (!s || typeof s.since !== "number" || typeof s.member_id !== "string" || now() - s.since > SHOPPING_TTL) return null;
  const m = await c.env.DB.prepare("SELECT name FROM members WHERE id = ?1 AND removed_at IS NULL")
    .bind(s.member_id)
    .first<{ name: string }>();
  return m ? { member_id: s.member_id, name: m.name, since: s.since } : null;
}

/** Optional text field: undefined = absent, null = cleared, string = trimmed value; false = invalid. */
function optText(v: unknown, max: number): string | null | undefined | false {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") return false;
  const t = v.trim();
  if (t.length > max) return false;
  return t || null;
}

const validName = (v: unknown): string | false => {
  if (typeof v !== "string") return false;
  const t = v.trim();
  return t.length >= 1 && t.length <= MAX_NAME ? t : false;
};

items.get("/items", requireMember, async (c) => {
  const t = now();
  const list = await c.env.DB.prepare(
    `${SELECT}
     WHERE i.bought_at IS NULL OR i.bought_at >= ?1
     ORDER BY (i.bought_at IS NOT NULL), CASE WHEN i.bought_at IS NULL THEN i.added_at END DESC, i.bought_at DESC`,
  )
    .bind(t - BOUGHT_TTL)
    .all<Record<string, unknown>>();
  const sug = await c.env.DB.prepare(
    `SELECT name, MAX(added_at) AS last_at FROM items
     WHERE added_at >= ?1
     GROUP BY lower(name)
     HAVING SUM(CASE WHEN bought_at IS NULL THEN 1 ELSE 0 END) = 0
     ORDER BY last_at DESC LIMIT 20`,
  )
    .bind(t - SUGGEST_WINDOW)
    .all<{ name: string }>();
  // SQLite returns the bare columns (name) of the row holding MAX(added_at): the latest casing.
  const usual = await c.env.DB.prepare(
    `SELECT name, qty, COUNT(*) AS n, MAX(added_at) AS last_at FROM items
     WHERE added_at >= ?1
     GROUP BY lower(name)
     HAVING SUM(CASE WHEN bought_at IS NULL THEN 1 ELSE 0 END) = 0
     ORDER BY n DESC, last_at DESC LIMIT 10`,
  )
    .bind(t - USUAL_WINDOW)
    .all<{ name: string; qty: string | null }>();
  return c.json({
    items: list.results.map(withCat),
    suggestions: sug.results.map((r) => r.name),
    usual: usual.results.map((r) => r.name),
    usual_qty: Object.fromEntries(usual.results.filter((r) => r.qty).map((r) => [r.name, r.qty])),
    categories: CATEGORIES,
    shopping: await shoppingStatus(c),
  });
});

items.post("/items", requireMember, async (c) => {
  const b = await readJson(c);
  const name = validName(b.name);
  if (name === false) return fail(c, "bad_name", 400);
  const qty = optText(b.qty, MAX_QTY);
  if (qty === false) return fail(c, "bad_qty", 400);
  const note = optText(b.note, MAX_NOTE);
  if (note === false) return fail(c, "bad_note", 400);
  let category: string = guessCategory(name);
  if (b.category !== undefined) {
    if (!isCategory(b.category)) return fail(c, "bad_category", 400);
    category = b.category;
  }
  if (b.photo_key !== undefined && b.photo_key !== null && typeof b.photo_key !== "string") return fail(c, "bad_photo", 400);
  const photo = typeof b.photo_key === "string" && b.photo_key ? b.photo_key : null;
  const me = c.get("me");

  // Idempotent replay: a client-generated id that already exists is the same request retried.
  const cid = clientId(b.id);
  if (cid === false) return fail(c, "bad_id", 400);
  if (cid) {
    const prior = await c.env.DB.prepare("SELECT added_by FROM items WHERE id = ?1").bind(cid).first<{ added_by: string | null }>();
    if (prior) return prior.added_by === me.id ? c.json({ item: await getItem(c, cid) }) : fail(c, "id_taken", 409);
  }

  const dup = await c.env.DB.prepare("SELECT id FROM items WHERE bought_at IS NULL AND lower(name) = lower(?1) LIMIT 1")
    .bind(name)
    .first<{ id: string }>();
  if (dup) return c.json({ item: await getItem(c, dup.id), duplicate: true });

  if (photo !== null && !(await claimPhoto(c, photo, me.id))) return fail(c, "bad_photo", 400);

  const id = cid ?? newId();
  await c.env.DB.prepare(
    "INSERT INTO items(id, name, qty, note, added_by, added_at, category, photo_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  )
    .bind(id, name, qty ?? null, note ?? null, me.id, now(), category, photo)
    .run();
  const others = (
    await c.env.DB.prepare("SELECT id FROM members WHERE removed_at IS NULL AND id != ?1").bind(me.id).all<{ id: string }>()
  ).results.map((r) => r.id);
  await emit(c.env, c.executionCtx, "list", { kind: "item", to: others, actorId: me.id });
  return c.json({ item: await getItem(c, id) });
});

items.patch("/items/:id", requireMember, async (c) => {
  const id = c.req.param("id");
  const b = await readJson(c);
  let name: string | undefined;
  if (b.name !== undefined) {
    const n = validName(b.name);
    if (n === false) return fail(c, "bad_name", 400);
    name = n;
  }
  const qty = optText(b.qty, MAX_QTY);
  if (qty === false) return fail(c, "bad_qty", 400);
  const note = optText(b.note, MAX_NOTE);
  if (note === false) return fail(c, "bad_note", 400);
  if (b.bought !== undefined && typeof b.bought !== "boolean") return fail(c, "bad_request", 400);
  if (b.category !== undefined && !isCategory(b.category)) return fail(c, "bad_category", 400);
  if (b.photo_key !== undefined && b.photo_key !== null && typeof b.photo_key !== "string") return fail(c, "bad_photo", 400);

  const cur = await c.env.DB.prepare("SELECT id, bought_at, photo_key FROM items WHERE id = ?1").bind(id).first<{
    id: string;
    bought_at: number | null;
    photo_key: string | null;
  }>();
  if (!cur) return fail(c, "not_found", 404);

  const me = c.get("me");
  let photoSet: string | null | undefined;
  let oldPhoto: string | null = null;
  if (b.photo_key !== undefined) {
    const next = b.photo_key ? (b.photo_key as string) : null;
    if (next !== cur.photo_key) {
      if (next !== null && !(await claimPhoto(c, next, me.id))) return fail(c, "bad_photo", 400);
      oldPhoto = cur.photo_key;
      photoSet = next;
    }
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = ?${vals.length}`);
  };
  if (name !== undefined) add("name", name);
  if (qty !== undefined) add("qty", qty);
  if (note !== undefined) add("note", note);
  if (b.category !== undefined) add("category", b.category);
  if (photoSet !== undefined) add("photo_key", photoSet);
  if (b.bought === true && cur.bought_at === null) {
    add("bought_by", me.id);
    add("bought_at", now());
  } else if (b.bought === false) {
    add("bought_by", null);
    add("bought_at", null);
  }
  if (sets.length) {
    vals.push(id);
    await c.env.DB.prepare(`UPDATE items SET ${sets.join(", ")} WHERE id = ?${vals.length}`).bind(...vals).run();
  }
  if (oldPhoto) await deleteMedia(c.env, oldPhoto);
  await emit(c.env, c.executionCtx, "list");
  return c.json({ item: await getItem(c, id) });
});

items.delete("/items/:id", requireMember, async (c) => {
  const id = c.req.param("id");
  const cur = await c.env.DB.prepare("SELECT photo_key FROM items WHERE id = ?1").bind(id).first<{ photo_key: string | null }>();
  const r = await c.env.DB.prepare("DELETE FROM items WHERE id = ?1").bind(id).run();
  if (!r.meta.changes) return fail(c, "not_found", 404);
  if (cur?.photo_key) await deleteMedia(c.env, cur.photo_key);
  await emit(c.env, c.executionCtx, "list");
  return c.json({ ok: true });
});

items.post("/shopping", requireMember, async (c) => {
  const me = c.get("me");
  const since = now();
  await c.env.DB.prepare("INSERT INTO config(k, v) VALUES('shopping', ?1) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(JSON.stringify({ member_id: me.id, since }))
    .run();
  const others = (
    await c.env.DB.prepare("SELECT id FROM members WHERE removed_at IS NULL AND id != ?1").bind(me.id).all<{ id: string }>()
  ).results.map((r) => r.id);
  await emit(c.env, c.executionCtx, "list", { kind: "shopping", to: others, actorId: me.id });
  return c.json({ shopping: { member_id: me.id, name: me.name, since } });
});

items.delete("/shopping", requireMember, async (c) => {
  await c.env.DB.prepare("DELETE FROM config WHERE k = 'shopping'").run();
  await emit(c.env, c.executionCtx, "list");
  return c.json({ shopping: null });
});

export default items;
