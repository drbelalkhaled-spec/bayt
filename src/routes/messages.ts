import { Hono } from "hono";
import { requireMember, type AppEnv } from "../lib/auth";
import { emit } from "../lib/events";
import { attachMedia, deleteMedia } from "../lib/media";
import { clientId, fail, newId, now, readJson } from "../lib/util";

const messages = new Hono<AppEnv>();

const MAX_BODY = 2000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const RETENTION_MS = 90 * 86_400_000;

interface MessageRow {
  id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: number;
  kind: string;
  media_key: string | null;
  media_meta: string | null;
  pinned_at: number | null;
  pinned_by: string | null;
}

const SELECT = `SELECT m.id, m.author_id, COALESCE(a.name, '') AS author_name, m.body, m.created_at,
  m.kind, m.media_key, m.media_meta, m.pinned_at, m.pinned_by
  FROM messages m LEFT JOIN members a ON a.id = m.author_id`;

function parseMeta(raw: string | null): Record<string, number> | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/** Public shape of a message (media_meta parsed, pinned_by dropped). */
function shape(m: MessageRow) {
  const { pinned_by: _pb, media_meta, ...rest } = m;
  return { ...rest, media_meta: parseMeta(media_meta) };
}

async function extras(db: D1Database, meId: string) {
  const reads = (
    await db
      .prepare(
        "SELECT id AS member_id, name, chat_read_at AS read_at FROM members WHERE removed_at IS NULL AND id != ?1 AND chat_read_at IS NOT NULL ORDER BY name",
      )
      .bind(meId)
      .all<{ member_id: string; name: string; read_at: number }>()
  ).results;
  const pinned = (
    await db
      .prepare(
        `SELECT m.id, m.author_id, COALESCE(a.name, '') AS author_name, m.body, m.created_at,
           m.kind, m.media_key, m.media_meta, m.pinned_at, m.pinned_by, COALESCE(p.name, '') AS pinned_by_name
         FROM messages m LEFT JOIN members a ON a.id = m.author_id LEFT JOIN members p ON p.id = m.pinned_by
         WHERE m.pinned_at IS NOT NULL ORDER BY m.pinned_at DESC, m.id DESC LIMIT 20`,
      )
      .all<MessageRow & { pinned_by_name: string }>()
  ).results.map((m) => ({ ...shape(m), pinned_by_name: m.pinned_by_name }));
  return { reads, pinned };
}

const cursorOf = (m: MessageRow) => `${m.created_at}:${m.id}`;

/** Parses "<created_at>" or "<created_at>:<id>". Returns null when malformed. */
function parseCursor(raw: string): { t: number; id: string | null } | null {
  const i = raw.indexOf(":");
  const ts = i < 0 ? raw : raw.slice(0, i);
  const id = i < 0 ? null : raw.slice(i + 1);
  if (!/^\d{1,16}$/.test(ts) || id === "") return null;
  return { t: Number(ts), id };
}

messages.use("/messages", requireMember);
messages.use("/messages/*", requireMember);

messages.get("/messages", async (c) => {
  const db = c.env.DB;
  const meId = c.get("me").id;
  const afterRaw = c.req.query("after");
  const beforeRaw = c.req.query("before");
  const limRaw = c.req.query("limit");
  let limit = DEFAULT_LIMIT;
  if (limRaw !== undefined) {
    if (!/^\d+$/.test(limRaw) || Number(limRaw) < 1) return fail(c, "bad_limit", 400);
    limit = Math.min(Number(limRaw), MAX_LIMIT);
  }

  if (afterRaw !== undefined) {
    const cur = parseCursor(afterRaw);
    if (!cur) return fail(c, "bad_cursor", 400);
    const { results } = await db
      .prepare(
        `${SELECT} WHERE m.created_at > ?1 OR (m.created_at = ?1 AND m.id > ?2)
         ORDER BY m.created_at ASC, m.id ASC LIMIT ?3`,
      )
      .bind(cur.t, cur.id ?? "￿", MAX_LIMIT + 1)
      .all<MessageRow>();
    const more = results.length > MAX_LIMIT;
    const page = more ? results.slice(0, MAX_LIMIT) : results;
    return c.json({
      messages: page.map(shape),
      more,
      cursor: page.length ? cursorOf(page[page.length - 1]!) : null,
      ...(await extras(db, meId)),
    });
  }

  let rows: MessageRow[];
  if (beforeRaw !== undefined) {
    const cur = parseCursor(beforeRaw);
    if (!cur) return fail(c, "bad_cursor", 400);
    rows = (
      await db
        .prepare(
          `${SELECT} WHERE m.created_at < ?1 OR (m.created_at = ?1 AND m.id < ?2)
           ORDER BY m.created_at DESC, m.id DESC LIMIT ?3`,
        )
        .bind(cur.t, cur.id ?? "", limit + 1)
        .all<MessageRow>()
    ).results;
  } else {
    rows = (
      await db
        .prepare(`${SELECT} ORDER BY m.created_at DESC, m.id DESC LIMIT ?1`)
        .bind(limit + 1)
        .all<MessageRow>()
    ).results;
  }
  const more = rows.length > limit;
  const page = (more ? rows.slice(0, limit) : rows).reverse();
  return c.json({
    messages: page.map(shape),
    more,
    cursor: more ? cursorOf(page[0]!) : null,
    ...(await extras(db, meId)),
  });
});

const META_KEYS: Record<"photo" | "voice", string[]> = { photo: ["w", "h"], voice: ["durationMs"] };

/** Returns the cleaned meta object (or null when empty) or undefined when invalid. */
function cleanMeta(kind: "photo" | "voice", raw: unknown): Record<string, number> | null | undefined {
  if (raw === undefined || raw === null) return kind === "voice" ? undefined : null;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!META_KEYS[kind].includes(k)) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
    if (k === "durationMs" ? v < 1 || v > 120_000 : v < 1 || v > 20_000) return undefined;
    out[k] = v;
  }
  if (kind === "voice" && out.durationMs === undefined) return undefined;
  if (JSON.stringify(out).length > 200) return undefined;
  return Object.keys(out).length ? out : null;
}

messages.post("/messages", async (c) => {
  const b = await readJson(c);
  const me = c.get("me");
  const kind = b.kind === undefined || b.kind === null ? "text" : b.kind;
  if (kind !== "text" && kind !== "photo" && kind !== "voice") return fail(c, "bad_kind", 400);
  if (b.body !== undefined && b.body !== null && typeof b.body !== "string") return fail(c, "bad_body", 400);
  const cid = clientId(b.id);
  if (cid === false) return fail(c, "bad_id", 400);
  if (cid) {
    // Idempotent replay: same id + same author = the earlier request succeeded; return it without a new emit/push.
    const prior = await c.env.DB.prepare(`${SELECT} WHERE m.id = ?1`).bind(cid).first<MessageRow>();
    if (prior) return prior.author_id === me.id ? c.json({ message: shape(prior) }) : fail(c, "id_taken", 409);
  }
  const body = typeof b.body === "string" ? b.body.trim() : "";
  if (body.length > MAX_BODY) return fail(c, "bad_body", 400);
  let mediaKey: string | null = null;
  let meta: Record<string, number> | null = null;
  if (kind === "text") {
    if (!body) return fail(c, "bad_body", 400);
  } else {
    if (kind === "voice" && body) return fail(c, "bad_body", 400);
    if (typeof b.media_key !== "string" || !b.media_key || b.media_key.length > 64) return fail(c, "bad_media", 400);
    const m = cleanMeta(kind, b.media_meta);
    if (m === undefined) return fail(c, "bad_meta", 400);
    meta = m;
    const row = await c.env.DB.prepare("SELECT content_type, attached FROM media WHERE key = ?1 AND owner_id = ?2")
      .bind(b.media_key, me.id)
      .first<{ content_type: string; attached: number }>();
    const want = kind === "photo" ? "image/" : "audio/";
    if (!row || row.attached || !row.content_type.startsWith(want)) return fail(c, "bad_media", 400);
    if (!(await attachMedia(c.env, b.media_key, me.id))) return fail(c, "bad_media", 400);
    mediaKey = b.media_key;
  }
  const message: MessageRow = {
    id: cid ?? newId(),
    author_id: me.id,
    author_name: me.name,
    body,
    created_at: now(),
    kind,
    media_key: mediaKey,
    media_meta: meta ? JSON.stringify(meta) : null,
    pinned_at: null,
    pinned_by: null,
  };
  await c.env.DB.prepare(
    "INSERT INTO messages(id, author_id, body, created_at, kind, media_key, media_meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(message.id, me.id, body, message.created_at, kind, mediaKey, message.media_meta)
    .run();
  const { results } = await c.env.DB.prepare("SELECT id FROM members WHERE removed_at IS NULL AND id != ?1")
    .bind(me.id)
    .all<{ id: string }>();
  const text = kind === "photo" ? `${me.name} sent a photo` : kind === "voice" ? `${me.name} sent a voice note` : undefined;
  await emit(c.env, c.executionCtx, "chat", {
    kind: "chat",
    to: results.map((r) => r.id),
    actorId: me.id,
    ...(text ? { text } : {}),
  });
  return c.json({ message: shape(message) });
});

messages.post("/messages/read", async (c) => {
  const b = await readJson(c);
  const me = c.get("me");
  if (typeof b.at !== "number" || !Number.isInteger(b.at) || b.at < 0) return fail(c, "bad_at", 400);
  const at = Math.min(b.at, now());
  const r = await c.env.DB.prepare(
    "UPDATE members SET chat_read_at = ?1 WHERE id = ?2 AND (chat_read_at IS NULL OR chat_read_at < ?1)",
  )
    .bind(at, me.id)
    .run();
  const changed = r.meta.changes > 0;
  if (changed) await emit(c.env, c.executionCtx, "chat");
  return c.json({ ok: true, changed });
});

messages.patch("/messages/:id", async (c) => {
  const id = c.req.param("id");
  const me = c.get("me");
  const b = await readJson(c);
  if (typeof b.pinned !== "boolean") return fail(c, "bad_pinned", 400);
  const r = b.pinned
    ? await c.env.DB.prepare("UPDATE messages SET pinned_at = ?1, pinned_by = ?2 WHERE id = ?3").bind(now(), me.id, id).run()
    : await c.env.DB.prepare("UPDATE messages SET pinned_at = NULL, pinned_by = NULL WHERE id = ?1").bind(id).run();
  if (r.meta.changes === 0) return fail(c, "not_found", 404);
  await emit(c.env, c.executionCtx, "chat");
  return c.json({ ok: true, pinned: b.pinned });
});

messages.delete("/messages/:id", async (c) => {
  const id = c.req.param("id");
  const me = c.get("me");
  const row = await c.env.DB.prepare("SELECT author_id, media_key FROM messages WHERE id = ?1")
    .bind(id)
    .first<{ author_id: string; media_key: string | null }>();
  if (!row) return fail(c, "not_found", 404);
  if (row.author_id !== me.id) return fail(c, "forbidden", 403);
  await c.env.DB.prepare("DELETE FROM messages WHERE id = ?1 AND author_id = ?2").bind(id, me.id).run();
  if (row.media_key) await deleteMedia(c.env, row.media_key).catch((e) => console.error("deleteMedia failed", e));
  await emit(c.env, c.executionCtx, "chat");
  return c.json({ ok: true });
});

/** Retention deletes for runCleanup: [sql, ...bindings]. */
export function retention(now: number): [string, ...unknown[]][] {
  return [["DELETE FROM messages WHERE created_at < ?1", now - RETENTION_MS]];
}

export default messages;
