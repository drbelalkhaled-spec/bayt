import { Hono, type Context } from "hono";
import { requireMember, type AppEnv } from "../lib/auth";
import { readNotice, sendDevices, storeNotice, vapidPublicKey, type Device } from "../lib/push";
import { fail, newId, now, readJson } from "../lib/util";

const push = new Hono<AppEnv>();

const MAX_SUB_BYTES = 2048;
/** A member's phones and tablets; the oldest go first when someone registers more. */
const MAX_DEVICES = 10;
const DAY = 86_400_000;
const NOTICE_WINDOW_MS = 3_600_000;
const NOTICE_PAGE = 10;

/** Retention deletes for runCleanup: [sql, ...bindings]. */
export function retention(t: number): [string, ...unknown[]][] {
  return [
    ["DELETE FROM notices WHERE at < ?1", t - 3 * DAY],
    ["DELETE FROM push_devices WHERE member_id IN (SELECT id FROM members WHERE removed_at IS NOT NULL)"],
  ];
}

function validSubscription(s: unknown): s is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (!s || typeof s !== "object") return false;
  const o = s as Record<string, any>;
  if (typeof o.endpoint !== "string" || o.endpoint.length > 1024) return false;
  let u: URL;
  try {
    u = new URL(o.endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  const h = u.hostname;
  if (h === "localhost" || h.endsWith(".localhost") || /^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) {
    return false;
  }
  const k = o.keys;
  if (!k || typeof k !== "object" || typeof k.p256dh !== "string" || typeof k.auth !== "string") return false;
  if (!k.p256dh || !k.auth) return false;
  return JSON.stringify(s).length <= MAX_SUB_BYTES;
}

/** The device endpoint a request names (JSON body or ?endpoint=), or null. */
async function endpointOf(c: Context): Promise<string | null> {
  const e = (await readJson(c)).endpoint ?? c.req.query("endpoint");
  return typeof e === "string" && e ? e : null;
}

push.get("/push/key", async (c) => c.json({ key: await vapidPublicKey(c.env) }));

push.post("/push/subscribe", requireMember, async (c) => {
  const b = await readJson(c);
  if (!validSubscription(b.subscription)) return fail(c, "bad_subscription", 400);
  const { endpoint, keys } = b.subscription;
  const clean = JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  const me = c.get("me").id;
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO push_devices(id, member_id, endpoint, sub, created_at) VALUES(?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(endpoint) DO UPDATE SET member_id = excluded.member_id, sub = excluded.sub`,
    ).bind(newId(), me, endpoint, clean, now()),
    c.env.DB.prepare(
      `DELETE FROM push_devices WHERE member_id = ?1
         AND id NOT IN (SELECT id FROM push_devices WHERE member_id = ?1 ORDER BY created_at DESC, id LIMIT ?2)`,
    ).bind(me, MAX_DEVICES),
  ]);
  return c.json({ ok: true });
});

push.delete("/push/subscribe", requireMember, async (c) => {
  const endpoint = await endpointOf(c);
  const me = c.get("me").id;
  if (endpoint) await c.env.DB.prepare("DELETE FROM push_devices WHERE member_id = ?1 AND endpoint = ?2").bind(me, endpoint).run();
  else await c.env.DB.prepare("DELETE FROM push_devices WHERE member_id = ?1").bind(me).run();
  return c.json({ ok: true });
});

/** Is this device (by its push endpoint) registered for me? */
push.get("/push/status", requireMember, async (c) => {
  const endpoint = c.req.query("endpoint");
  const row = endpoint
    ? await c.env.DB.prepare("SELECT 1 AS x FROM push_devices WHERE member_id = ?1 AND endpoint = ?2")
        .bind(c.get("me").id, endpoint)
        .first()
    : null;
  c.header("cache-control", "no-store");
  return c.json({ subscribed: !!row });
});

/** The latest notice. Old service workers (before /push/notices) ask for this; it does not consume anything. */
push.get("/push/notice", requireMember, async (c) => {
  const n = await readNotice(c.env, c.get("me").id);
  c.header("cache-control", "no-store");
  if (!n) return c.json({ notice: { title: "Bayt", text: "Something changed at home" } });
  return c.json({ notice: { title: "Bayt", text: n.text, kind: n.kind, actorName: n.actorName, ref: n.ref ?? null, at: n.at } });
});

/** What a device has not shown yet: my notices after its cursor (at most the last hour), oldest first. */
push.get("/push/notices", requireMember, async (c) => {
  const after = Number(c.req.query("after"));
  const since = Math.max(Number.isFinite(after) ? after : 0, now() - NOTICE_WINDOW_MS);
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, text, actor_name, ref, at FROM notices WHERE member_id = ?1 AND at > ?2
     ORDER BY at, rowid LIMIT ?3`,
  )
    .bind(c.get("me").id, since, NOTICE_PAGE)
    .all<{ id: string; kind: string; text: string; actor_name: string; ref: string | null; at: number }>();
  c.header("cache-control", "no-store");
  return c.json({
    notices: results.map((r) => ({ id: r.id, kind: r.kind, text: r.text, actorName: r.actor_name, ref: r.ref, at: r.at })),
  });
});

push.post("/push/test", requireMember, async (c) => {
  const me = c.get("me");
  const endpoint = await endpointOf(c);
  const { results } = await c.env.DB.prepare(
    `SELECT id, endpoint FROM push_devices WHERE member_id = ?1 AND (?2 IS NULL OR endpoint = ?2)`,
  )
    .bind(me.id, endpoint)
    .all<Device>();
  if (!results.length) return fail(c, "no_subscription", 400);
  await storeNotice(c.env, me.id, { kind: "test", actorName: "Bayt", text: "Test notification", at: now() });
  const sent = await sendDevices(c.env, results);
  return c.json({ ok: true, sent });
});

export default push;
