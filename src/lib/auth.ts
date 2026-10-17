import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { Env } from "../env";
import { sha256hex } from "./util";

/** Seat cap for the household. */
export const MAX_MEMBERS = 3;

/** The cap in force: MAX_MEMBERS unless the environment raises it (local dev test accounts). */
export function maxMembers(env: Pick<Env, "MAX_MEMBERS">): number {
  const n = Number(env.MAX_MEMBERS);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : MAX_MEMBERS;
}

export type Role = "parent" | "nanny";
export interface Member {
  id: string;
  name: string;
  role: Role;
}
export type AppEnv = { Bindings: Env; Variables: { me: Member } };

export const publicMember = (m: Member): Member => ({ id: m.id, name: m.name, role: m.role });

async function memberByToken(c: Context<AppEnv>, token: string): Promise<Member | null> {
  if (!token) return null;
  return await c.env.DB.prepare("SELECT id, name, role FROM members WHERE token_hash = ?1 AND removed_at IS NULL")
    .bind(await sha256hex(token))
    .first<Member>();
}

export const requireMember = createMiddleware<AppEnv>(async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const row = await memberByToken(c, h.startsWith("Bearer ") ? h.slice(7).trim() : "");
  if (row) {
    c.set("me", row);
    return next();
  }
  return c.json({ error: "unauthorized" }, 401);
});

/**
 * Like requireMember but ALSO accepts the token as a `?t=` query param. Use ONLY on routes consumed by
 * <img>/<audio> elements, which cannot send Authorization headers. Trade-off: the token can leak via
 * logs/history (Referrer-Policy: no-referrer mitigates Referer leaks); never use on any other route.
 */
export const requireMemberOrQuery = createMiddleware<AppEnv>(async (c, next) => {
  const h = c.req.header("authorization") ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : (c.req.query("t") ?? "");
  const row = await memberByToken(c, token);
  if (row) {
    c.set("me", row);
    return next();
  }
  return c.json({ error: "unauthorized" }, 401);
});

export const requireParent = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("me").role !== "parent") return c.json({ error: "forbidden" }, 403);
  return next();
});
