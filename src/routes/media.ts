import { Hono, type Context } from "hono";
import { requireMember, requireMemberOrQuery, type AppEnv } from "../lib/auth";
import { canSeeTrash, type TrashRow } from "../lib/trash";
import { fail, newId, now } from "../lib/util";

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
/** Videos are streamed into R2 instead of buffered, so they get a bigger limit. */
export const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
export const MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const media = new Hono<AppEnv>();

media.post("/media", requireMember, async (c) => {
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!MEDIA_TYPES.has(type)) return fail(c, "bad_type", 400);
  if (type.startsWith("video/")) return uploadVideo(c, type);
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) return c.json({ error: "too_large" }, 413);
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) return fail(c, "empty", 400);
  if (buf.byteLength > MAX_MEDIA_BYTES) return c.json({ error: "too_large" }, 413);
  const key = newId();
  await c.env.MEDIA.put(key, buf, { httpMetadata: { contentType: type } });
  await recordMedia(c, key, type, buf.byteLength);
  return c.json({ key, content_type: type, size: buf.byteLength });
});

async function recordMedia(c: Context<AppEnv>, key: string, type: string, size: number): Promise<void> {
  await c.env.DB.prepare(
    "INSERT INTO media(key, owner_id, content_type, size, created_at, attached) VALUES(?1, ?2, ?3, ?4, ?5, 0)",
  )
    .bind(key, c.get("me").id, type, size, now())
    .run();
}

/** Streams the body straight into R2 (never held in memory); R2 needs the length up front, so Content-Length is required. */
async function uploadVideo(c: Context<AppEnv>, type: string): Promise<Response> {
  const raw = c.req.header("content-length");
  if (raw === undefined || !/^\d{1,12}$/.test(raw)) return c.json({ error: "length_required" }, 411);
  const size = Number(raw);
  if (size > MAX_VIDEO_BYTES) return c.json({ error: "too_large" }, 413);
  const body = c.req.raw.body;
  if (size === 0 || !body) return fail(c, "empty", 400);
  const key = newId();
  const fixed = new FixedLengthStream(size);
  const piped = body.pipeTo(fixed.writable).catch(() => undefined);
  try {
    await c.env.MEDIA.put(key, fixed.readable, { httpMetadata: { contentType: type } });
  } catch {
    // The body was shorter or longer than Content-Length, or the connection dropped.
    await c.env.MEDIA.delete(key).catch(() => undefined);
    return fail(c, "bad_length", 400);
  }
  await piped;
  await recordMedia(c, key, type, size);
  return c.json({ key, content_type: type, size });
}

// <img src>/<audio src> cannot send Authorization headers, so this GET alone also accepts `?t=<token>`.
// Trade-off: the token may appear in URLs/logs; every other route requires the header.
media.get("/media/:key", requireMemberOrQuery, async (c) => {
  const key = c.req.param("key");
  if (!KEY_RE.test(key)) return fail(c, "not_found", 404);
  // A photo/voice note whose message, item or task is in the trash is kept only so it can be restored:
  // serve it to those who may see that trash entry (a deleted message: only its author), nobody else.
  const db = c.env.DB;
  const trashed = (
    await db.prepare("SELECT kind, deleted_by FROM trash WHERE media_key = ?1").bind(key).all<Pick<TrashRow, "kind" | "deleted_by">>()
  ).results;
  if (trashed.length) {
    const live = await db
      .prepare(
        `SELECT 1 FROM items WHERE photo_key = ?1 UNION ALL SELECT 1 FROM tasks WHERE done_photo_key = ?1
         UNION ALL SELECT 1 FROM messages WHERE media_key = ?1 LIMIT 1`,
      )
      .bind(key)
      .first();
    if (!live && !trashed.some((t) => canSeeTrash(t, c.get("me")))) return fail(c, "not_found", 404);
  }
  const headers: Record<string, string> = {
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
  };
  const rangeHeader = c.req.header("range");
  if (rangeHeader === undefined) {
    const obj = await c.env.MEDIA.get(key);
    if (!obj) return fail(c, "not_found", 404);
    return new Response(obj.body, {
      headers: { ...headers, "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "content-length": String(obj.size) },
    });
  }
  // Video players (iPhone Safari above all) fetch bytes=N-M slices.
  const head = await c.env.MEDIA.head(key);
  if (!head) return fail(c, "not_found", 404);
  const range = parseRange(rangeHeader, head.size);
  if (!range) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${head.size}` } });
  const obj = await c.env.MEDIA.get(key, { range: { offset: range.start, length: range.end - range.start + 1 } });
  if (!obj || !("body" in obj)) return fail(c, "not_found", 404);
  return new Response(obj.body, {
    status: 206,
    headers: {
      ...headers,
      "content-type": head.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(range.end - range.start + 1),
      "content-range": `bytes ${range.start}-${range.end}/${head.size}`,
    },
  });
});

/** "bytes=a-b", "bytes=a-" or "bytes=-n" against an object of `size` bytes; null when malformed or unsatisfiable. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n > 0 && size > 0 ? { start: Math.max(0, size - n), end: size - 1 } : null;
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start < size && start <= end ? { start, end } : null;
}

export default media;
