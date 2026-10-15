import { Hono } from "hono";
import { MAX_MEMBERS, publicMember, requireMember, requireParent, type AppEnv, type Member } from "../lib/auth";
import { emit, kick } from "../lib/events";
import { rateClear, rateFail, rateLimited } from "../lib/ratelimit";
import { badName, cleanName, fail, newId, nameKey, now, randHex, readJson, safeEqual, setTz, sha256hex, validTz, householdTz } from "../lib/util";

const INVITE_TTL = 24 * 3_600_000;
const MAX_OPEN_INVITES = 5;
const SECRET_RE = /^[0-9a-f]{32}$/;
const ip = (c: { req: { header(n: string): string | undefined } }) => c.req.header("cf-connecting-ip") ?? "unknown";

const auth = new Hono<AppEnv>();

const activeCount = async (db: D1Database) =>
  (await db.prepare("SELECT COUNT(*) AS c FROM members WHERE removed_at IS NULL").first<{ c: number }>())!.c;

auth.get("/status", async (c) => c.json({ setup: (await activeCount(c.env.DB)) === 0 }));

auth.post("/setup", async (c) => {
  const key = "rl:setup:" + ip(c);
  if (await rateLimited(c.env, key)) return fail(c, "rate_limited", 429);
  const b = await readJson(c);
  if (typeof b.code !== "string" || !c.env.SETUP_CODE || !safeEqual(b.code, c.env.SETUP_CODE)) {
    await rateFail(c.env, key);
    return fail(c, "forbidden", 403);
  }
  if (badName(b.name)) return fail(c, "bad_name", 400);
  const name = cleanName(b.name as string);
  const token = randHex(32);
  const member: Member = { id: newId(), name, role: "parent" };
  const r = await c.env.DB.prepare(
    `INSERT INTO members(id, name, name_key, role, token_hash, created_at)
     SELECT ?1, ?2, ?3, 'parent', ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM members WHERE removed_at IS NULL)`,
  )
    .bind(member.id, name, nameKey(name), await sha256hex(token), now())
    .run();
  if (!r.meta.changes) return fail(c, "already_setup", 403);
  if (validTz(b.tz)) await setTz(c.env, b.tz);
  await rateClear(c.env, key);
  await emit(c.env, c.executionCtx, "members");
  return c.json({ token, member });
});

auth.post("/invites", requireMember, requireParent, async (c) => {
  const b = await readJson(c);
  if (b.role !== "parent" && b.role !== "nanny") return fail(c, "bad_role", 400);
  if (badName(b.name)) return fail(c, "bad_name", 400);
  const name = cleanName(b.name as string);
  const taken = await c.env.DB.prepare("SELECT 1 FROM members WHERE removed_at IS NULL AND name_key = ?1")
    .bind(nameKey(name))
    .first();
  if (taken) return fail(c, "name_taken", 409);
  const me = c.get("me");
  const t = now();
  const secret = randHex(16);
  const expires_at = t + INVITE_TTL;
  const r = await c.env.DB.prepare(
    `INSERT INTO invites(id, secret_hash, role, name, created_by, created_at, expires_at)
     SELECT ?1, ?2, ?3, ?8, ?4, ?5, ?6
     WHERE (SELECT COUNT(*) FROM invites WHERE created_by = ?4 AND used_by IS NULL AND expires_at > ?5) < ?7`,
  )
    .bind(newId(), await sha256hex(secret), b.role, me.id, t, expires_at, MAX_OPEN_INVITES, name)
    .run();
  if (!r.meta.changes) return fail(c, "too_many_invites", 429);
  return c.json({ secret, role: b.role, name, expires_at });
});

interface InviteRow {
  id: string;
  role: string;
  name: string | null;
  created_by: string;
  expires_at: number;
  used_by: string | null;
  inviter_name: string | null;
}

async function findInvite(env: AppEnv["Bindings"], secret: unknown): Promise<InviteRow | null> {
  if (typeof secret !== "string" || !SECRET_RE.test(secret)) return null;
  const inv = await env.DB.prepare(
    `SELECT i.id, i.role, i.name, i.created_by, i.expires_at, i.used_by, m.name AS inviter_name
     FROM invites i LEFT JOIN members m ON m.id = i.created_by AND m.removed_at IS NULL
     WHERE i.secret_hash = ?1`,
  )
    .bind(await sha256hex(secret))
    .first<InviteRow>();
  if (!inv || inv.used_by || inv.expires_at <= now() || !inv.inviter_name) return null;
  return inv;
}

auth.get("/invites/peek", async (c) => {
  const key = "rl:invite:" + ip(c);
  if (await rateLimited(c.env, key)) return fail(c, "rate_limited", 429);
  const inv = await findInvite(c.env, c.req.query("s"));
  if (!inv) {
    await rateFail(c.env, key);
    return fail(c, "bad_invite", 404);
  }
  return c.json({ role: inv.role, name: inv.name, invited_by_name: inv.inviter_name });
});

auth.post("/join", async (c) => {
  const key = "rl:invite:" + ip(c);
  if (await rateLimited(c.env, key)) return fail(c, "rate_limited", 429);
  const b = await readJson(c);
  const inv = await findInvite(c.env, b.secret);
  if (!inv) {
    await rateFail(c.env, key);
    return fail(c, "bad_invite", 404);
  }
  // The inviter picked the name; older invites without one fall back to the joiner's own.
  const chosen = inv.name ?? b.name;
  if (badName(chosen)) return fail(c, "bad_name", 400);
  const name = cleanName(chosen as string);
  const nk = nameKey(name);
  const token = randHex(32);
  const id = newId();
  const t = now();
  const secretHash = await sha256hex(b.secret as string);
  // One batch = one transaction. The seat insert is conditional on a still-valid invite,
  // a free seat and a unique name; the claim is conditional on that member row existing,
  // so a failed insert never consumes the invite.
  const [ins] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO members(id, name, name_key, role, token_hash, created_at)
       SELECT ?1, ?2, ?3, i.role, ?4, ?5 FROM invites i
       WHERE i.secret_hash = ?6 AND i.used_by IS NULL AND i.expires_at > ?5
         AND (SELECT COUNT(*) FROM members WHERE removed_at IS NULL) < ?7
         AND NOT EXISTS (SELECT 1 FROM members WHERE removed_at IS NULL AND name_key = ?3)`,
    ).bind(id, name, nk, await sha256hex(token), t, secretHash, MAX_MEMBERS),
    c.env.DB.prepare(
      `UPDATE invites SET used_by = ?1, used_at = ?2
       WHERE secret_hash = ?3 AND used_by IS NULL AND expires_at > ?2
         AND EXISTS (SELECT 1 FROM members WHERE id = ?1)`,
    ).bind(id, t, secretHash),
  ]);
  if (!ins.meta.changes) {
    // Diagnose why: name clash, full household, or the invite was taken meanwhile.
    const dup = await c.env.DB.prepare("SELECT 1 FROM members WHERE removed_at IS NULL AND name_key = ?1")
      .bind(nk)
      .first();
    if (dup) return fail(c, "name_taken", 409);
    if ((await activeCount(c.env.DB)) >= MAX_MEMBERS) return fail(c, "household_full", 409);
    return fail(c, "bad_invite", 404);
  }
  await rateClear(c.env, key);
  await emit(c.env, c.executionCtx, "members");
  return c.json({ token, member: { id, name, role: inv.role } });
});

const listMembers = async (db: D1Database) =>
  (await db.prepare("SELECT id, name, role FROM members WHERE removed_at IS NULL ORDER BY created_at").all<Member>())
    .results;

auth.get("/me", requireMember, async (c) =>
  c.json({ member: publicMember(c.get("me")), members: await listMembers(c.env.DB) }),
);

auth.patch("/me", requireMember, async (c) => {
  const me = c.get("me");
  // Names of invited helpers are set by the parent who invited them.
  if (me.role !== "parent") return fail(c, "name_locked", 403);
  const b = await readJson(c);
  if (badName(b.name)) return fail(c, "bad_name", 400);
  const name = cleanName(b.name as string);
  const nk = nameKey(name);
  const r = await c.env.DB.prepare(
    `UPDATE members SET name = ?1, name_key = ?2 WHERE id = ?3 AND removed_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM members WHERE removed_at IS NULL AND name_key = ?2 AND id != ?3)`,
  )
    .bind(name, nk, me.id)
    .run();
  if (!r.meta.changes) return fail(c, "name_taken", 409);
  await emit(c.env, c.executionCtx, "members");
  return c.json({ member: { ...publicMember(me), name } });
});

auth.get("/household", requireMember, async (c) => c.json({ tz: await householdTz(c.env) }));

auth.put("/household", requireMember, requireParent, async (c) => {
  const b = await readJson(c);
  if (!validTz(b.tz)) return fail(c, "bad_tz", 400);
  await setTz(c.env, b.tz);
  return c.json({ tz: b.tz });
});

auth.delete("/members/:id", requireMember, requireParent, async (c) => {
  const id = c.req.param("id");
  if (id === c.get("me").id) return fail(c, "cannot_remove_self", 400);
  const r = await c.env.DB.prepare(
    "UPDATE members SET removed_at = ?1, push_sub = NULL WHERE id = ?2 AND removed_at IS NULL",
  )
    .bind(now(), id)
    .run();
  if (!r.meta.changes) return fail(c, "not_found", 404);
  await kick(c.env, c.executionCtx, id);
  await emit(c.env, c.executionCtx, "members");
  return c.json({ ok: true });
});

export default auth;
