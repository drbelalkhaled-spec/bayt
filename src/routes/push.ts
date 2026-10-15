import { Hono } from "hono";
import { requireMember, type AppEnv } from "../lib/auth";
import { readNotice, sendPush, storeNotice, vapidPublicKey } from "../lib/push";
import { fail, now, readJson } from "../lib/util";

const push = new Hono<AppEnv>();

const MAX_SUB_BYTES = 2048;

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

push.get("/push/key", async (c) => c.json({ key: await vapidPublicKey(c.env) }));

push.post("/push/subscribe", requireMember, async (c) => {
  const b = await readJson(c);
  if (!validSubscription(b.subscription)) return fail(c, "bad_subscription", 400);
  const { endpoint, keys } = b.subscription;
  const clean = JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
  await c.env.DB.prepare("UPDATE members SET push_sub = ?1 WHERE id = ?2").bind(clean, c.get("me").id).run();
  return c.json({ ok: true });
});

push.delete("/push/subscribe", requireMember, async (c) => {
  await c.env.DB.prepare("UPDATE members SET push_sub = NULL WHERE id = ?1").bind(c.get("me").id).run();
  return c.json({ ok: true });
});

/** Called by the service worker after a content-free push. Does not consume the notice. */
push.get("/push/notice", requireMember, async (c) => {
  const n = await readNotice(c.env, c.get("me").id);
  c.header("cache-control", "no-store");
  if (!n) return c.json({ notice: { title: "Bayt", text: "Something changed at home" } });
  return c.json({ notice: { title: "Bayt", text: n.text, kind: n.kind, actorName: n.actorName, at: n.at } });
});

push.post("/push/test", requireMember, async (c) => {
  const me = c.get("me");
  const row = await c.env.DB.prepare("SELECT push_sub FROM members WHERE id = ?1")
    .bind(me.id)
    .first<{ push_sub: string | null }>();
  if (!row?.push_sub) return fail(c, "no_subscription", 400);
  await storeNotice(c.env, me.id, { kind: "test", actorName: "Bayt", text: "Test notification", at: now() });
  const sent = await sendPush(c.env, { id: me.id, push_sub: row.push_sub });
  return c.json({ ok: true, sent });
});

export default push;
