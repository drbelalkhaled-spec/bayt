import { Hono } from "hono";
import { requireMember, requireMemberOrQuery, type AppEnv } from "../lib/auth";
import { fail, newId, now } from "../lib/util";

export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
]);
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const media = new Hono<AppEnv>();

media.post("/media", requireMember, async (c) => {
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (!MEDIA_TYPES.has(type)) return fail(c, "bad_type", 400);
  const declared = Number(c.req.header("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_MEDIA_BYTES) return c.json({ error: "too_large" }, 413);
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) return fail(c, "empty", 400);
  if (buf.byteLength > MAX_MEDIA_BYTES) return c.json({ error: "too_large" }, 413);
  const key = newId();
  await c.env.MEDIA.put(key, buf, { httpMetadata: { contentType: type } });
  await c.env.DB.prepare(
    "INSERT INTO media(key, owner_id, content_type, size, created_at, attached) VALUES(?1, ?2, ?3, ?4, ?5, 0)",
  )
    .bind(key, c.get("me").id, type, buf.byteLength, now())
    .run();
  return c.json({ key, content_type: type, size: buf.byteLength });
});

// <img src>/<audio src> cannot send Authorization headers, so this GET alone also accepts `?t=<token>`.
// Trade-off: the token may appear in URLs/logs; every other route requires the header.
media.get("/media/:key", requireMemberOrQuery, async (c) => {
  const key = c.req.param("key");
  if (!KEY_RE.test(key)) return fail(c, "not_found", 404);
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return fail(c, "not_found", 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "content-length": String(obj.size),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
});

export default media;
