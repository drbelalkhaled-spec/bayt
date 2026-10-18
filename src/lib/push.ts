import type { Env } from "../env";
import { reportError } from "./errors";
import type { PushIntent } from "./events";
import { newId, now } from "./util";

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
  ref?: string | null;
}

export interface Device {
  id: string;
  endpoint: string;
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
 * Content-free push ("knock"): wakes the device; the service worker then fetches /api/push/notices.
 * On 404/410 that device's row is deleted. Best-effort; returns true when the push service accepted it.
 */
export async function sendPush(env: Env, device: Device, vapid?: Vapid, report = true): Promise<boolean> {
  try {
    const v = vapid ?? (await ensureVapid(env));
    const jwt = await vapidJwt(new URL(device.endpoint).origin, v);
    const r = await fetch(device.endpoint, {
      method: "POST",
      headers: { Authorization: `vapid t=${jwt}, k=${v.pub}`, TTL: "86400", Urgency: "high" },
    });
    await r.body?.cancel();
    if (r.status === 404 || r.status === 410) {
      await env.DB.prepare("DELETE FROM push_devices WHERE id = ?1").bind(device.id).run();
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

/** Adds one notice for a member. `at` is strictly increasing per member, so a device cursor never skips a notice. */
export async function storeNotice(env: Env, memberId: string, n: Notice): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO notices(id, member_id, kind, text, actor_name, ref, at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, MAX(?7, COALESCE(MAX(at), 0) + 1) FROM notices WHERE member_id = ?2`,
  )
    .bind(newId(), memberId, n.kind, n.text, n.actorName, n.ref ?? null, n.at)
    .run();
}

/** The member's latest notice (what old service workers ask for). */
export async function readNotice(env: Env, memberId: string): Promise<Notice | null> {
  const row = await env.DB.prepare(
    "SELECT kind, text, actor_name, ref, at FROM notices WHERE member_id = ?1 ORDER BY at DESC, rowid DESC LIMIT 1",
  )
    .bind(memberId)
    .first<{ kind: Notice["kind"]; text: string; actor_name: string; ref: string | null; at: number }>();
  return row ? { kind: row.kind, text: row.text, actorName: row.actor_name, ref: row.ref, at: row.at } : null;
}

/** Knocks every given device; true when at least one push service accepted it. */
export async function sendDevices(env: Env, devices: Device[], vapid?: Vapid, report = true): Promise<boolean> {
  const v = vapid ?? (devices.length ? await ensureVapid(env) : undefined);
  const sent = await Promise.all(devices.map((d) => sendPush(env, d, v, report)));
  return sent.some(Boolean);
}

/** Knocks all devices of one member. */
export async function pushMember(env: Env, memberId: string, vapid?: Vapid, report = true): Promise<boolean> {
  const { results } = await env.DB.prepare("SELECT id, endpoint FROM push_devices WHERE member_id = ?1")
    .bind(memberId)
    .all<Device>();
  return sendDevices(env, results, vapid, report);
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
    `SELECT d.id, d.member_id, d.endpoint FROM push_devices d JOIN members m ON m.id = d.member_id
     WHERE d.member_id IN (${ph}) AND m.removed_at IS NULL`,
  )
    .bind(...ids)
    .all<Device & { member_id: string }>();
  if (!results.length) return;
  const devices = new Map<string, Device[]>();
  for (const d of results) devices.set(d.member_id, [...(devices.get(d.member_id) ?? []), { id: d.id, endpoint: d.endpoint }]);
  const actor = await env.DB.prepare("SELECT name FROM members WHERE id = ?1")
    .bind(intent.actorId)
    .first<{ name: string }>();
  const actorName = actor?.name ?? "Someone";
  const text = intent.text || defaultText(intent.kind, actorName);
  const vapid = await ensureVapid(env);
  const t = now();
  const throttled = intent.kind === "item" || intent.kind === "shopping" || intent.kind === "chat" || intent.kind === "task_seen";
  await Promise.all(
    [...devices].map(async ([memberId, list]) => {
      try {
        await storeNotice(env, memberId, { kind: intent.kind, actorName, text, at: t, ref: intent.ref });
        if (throttled && !(await claim(env, memberId, intent.kind, t))) return;
        await sendDevices(env, list, vapid);
      } catch (e) {
        console.error("deliver failed", e);
      }
    }),
  );
}
