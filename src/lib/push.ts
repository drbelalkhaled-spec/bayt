import type { Env } from "../env";
import { reportError } from "./errors";
import type { PushIntent } from "./events";
import { now } from "./util";

/** Contact URI put in the VAPID JWT `sub` claim. CHANGE THIS to a real mailto:/https: contact before launch. */
export const VAPID_SUBJECT = "https://bayt.dr-belal-khaled.workers.dev";

const THROTTLE_MS = 120_000;
const te = new TextEncoder();

const b64uEnc = (buf: ArrayBuffer | Uint8Array): string => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export interface Vapid {
  pub: string;
  privJwk: JsonWebKey;
}

export interface Notice {
  kind: PushIntent["kind"] | "test" | "error";
  actorName: string;
  text: string;
  at: number;
}

/** Loads the VAPID key pair, generating and persisting it on first use (race-safe). */
export async function ensureVapid(env: Env): Promise<Vapid> {
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'vapid'").first<{ v: string }>();
  if (row) return JSON.parse(row.v) as Vapid;
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pub = b64uEnc((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const privJwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
  await env.DB.prepare("INSERT OR IGNORE INTO config(k, v) VALUES('vapid', ?1)")
    .bind(JSON.stringify({ pub, privJwk }))
    .run();
  const final = await env.DB.prepare("SELECT v FROM config WHERE k = 'vapid'").first<{ v: string }>();
  return JSON.parse(final!.v) as Vapid;
}

export async function vapidPublicKey(env: Env): Promise<string> {
  return (await ensureVapid(env)).pub;
}

export async function vapidJwt(aud: string, vapid: Vapid): Promise<string> {
  const j = (o: unknown) => b64uEnc(te.encode(JSON.stringify(o)));
  const data =
    j({ typ: "JWT", alg: "ES256" }) +
    "." +
    j({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUBJECT });
  const key = await crypto.subtle.importKey("jwk", vapid.privJwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(data));
  return data + "." + b64uEnc(sig); // raw r||s, as JWT ES256 requires
}

/**
 * Content-free push ("knock"): wakes the device; the service worker then fetches /api/push/notice.
 * On 404/410 the stored subscription is cleared. Best-effort; returns true when the push service accepted it.
 */
export async function sendPush(
  env: Env,
  recipient: { id: string; push_sub: string | null },
  vapid?: Vapid,
  report = true,
): Promise<boolean> {
  try {
    if (!recipient.push_sub) return false;
    const sub = JSON.parse(recipient.push_sub) as { endpoint?: string };
    if (!sub.endpoint) return false;
    const v = vapid ?? (await ensureVapid(env));
    const jwt = await vapidJwt(new URL(sub.endpoint).origin, v);
    const r = await fetch(sub.endpoint, {
      method: "POST",
      headers: { Authorization: `vapid t=${jwt}, k=${v.pub}`, TTL: "86400", Urgency: "high" },
    });
    await r.body?.cancel();
    if (r.status === 404 || r.status === 410) {
      await env.DB.prepare("UPDATE members SET push_sub = NULL WHERE id = ?1").bind(recipient.id).run();
      return false;
    }
    // Anything else means notifications are silently not arriving: worth telling a parent.
    if (!r.ok && report) await reportError(env, "notifications", `The push service refused a notification (HTTP ${r.status})`, null);
    return r.ok;
  } catch (e) {
    if (report) await reportError(env, "notifications", e);
    else console.error("sendPush failed", e);
    return false;
  }
}

export function defaultText(kind: PushIntent["kind"], actor: string): string {
  switch (kind) {
    case "chat":
      return `New message from ${actor}`;
    case "task_new":
      return `${actor} added a new task`;
    case "task_urgent":
      return `Urgent task from ${actor}`;
    case "item_urgent":
      return `${actor} needs something today`;
    case "task_comment":
      return `${actor} asked about a task`;
    case "task_seen":
      return `${actor} will do a task`;
    case "task_done":
      return `${actor} finished a task`;
    case "task_blocked":
      return `${actor} couldn't do a task`;
    case "reminder":
      return "Reminder: a task is due soon";
    case "msg_reminder":
      return "Reminder about a chat message";
    case "shopping":
      return `${actor} is going shopping`;
    default:
      return `${actor} updated the shopping list`;
  }
}

export async function storeNotice(env: Env, memberId: string, n: Notice): Promise<void> {
  await env.DB.prepare("INSERT INTO config(k, v) VALUES(?1, ?2) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind("notice:" + memberId, JSON.stringify(n))
    .run();
}

export async function readNotice(env: Env, memberId: string): Promise<Notice | null> {
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = ?1")
    .bind("notice:" + memberId)
    .first<{ v: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.v) as Notice;
  } catch {
    return null;
  }
}

/** Atomic throttle claim: true when this (member, kind) may send now (nothing sent in the last `every` ms). */
export async function claim(env: Env, memberId: string, kind: string, t: number, every = THROTTLE_MS): Promise<boolean> {
  const r = await env.DB.prepare(
    `INSERT INTO push_log(member_id, kind, sent_at) VALUES(?1, ?2, ?3)
     ON CONFLICT(member_id, kind) DO UPDATE SET sent_at = excluded.sent_at WHERE push_log.sent_at < ?4`,
  )
    .bind(memberId, kind, t, t - every)
    .run();
  return r.meta.changes > 0;
}

export async function deliver(env: Env, intent: PushIntent): Promise<void> {
  const ids = [...new Set(intent.to)].filter((id) => id !== intent.actorId);
  if (!ids.length) return;
  const ph = ids.map((_, i) => "?" + (i + 1)).join(",");
  const { results } = await env.DB.prepare(
    `SELECT id, push_sub FROM members WHERE id IN (${ph}) AND removed_at IS NULL AND push_sub IS NOT NULL`,
  )
    .bind(...ids)
    .all<{ id: string; push_sub: string }>();
  if (!results.length) return;
  const actor = await env.DB.prepare("SELECT name FROM members WHERE id = ?1")
    .bind(intent.actorId)
    .first<{ name: string }>();
  const actorName = actor?.name ?? "Someone";
  const text = intent.text || defaultText(intent.kind, actorName);
  const vapid = await ensureVapid(env);
  const t = now();
  const throttled = intent.kind === "item" || intent.kind === "shopping" || intent.kind === "chat" || intent.kind === "task_seen";
  await Promise.all(
    results.map(async (m) => {
      try {
        await storeNotice(env, m.id, { kind: intent.kind, actorName, text, at: t });
        if (throttled && !(await claim(env, m.id, intent.kind, t))) return;
        await sendPush(env, m, vapid);
      } catch (e) {
        console.error("deliver failed", e);
      }
    }),
  );
}
