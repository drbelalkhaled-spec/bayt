import { Hono } from "hono";
import type { Env } from "../env";
import type { AppEnv, Member } from "../lib/auth";
import { sha256hex } from "../lib/util";

const live = new Hono<AppEnv>();

/** Token from `Sec-WebSocket-Protocol: bayt, <token>`; never from the URL. */
export function tokenFromProtocol(header: string | null | undefined): string {
  const parts = (header ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts[0] === "bayt" && parts[1] ? parts[1] : "";
}

export async function memberFromToken(env: Env, token: string): Promise<Member | null> {
  if (!token) return null;
  return env.DB.prepare("SELECT id, name, role FROM members WHERE token_hash = ?1 AND removed_at IS NULL")
    .bind(await sha256hex(token))
    .first<Member>();
}

live.get("/live", async (c) => {
  if ((c.req.header("upgrade") ?? "").toLowerCase() !== "websocket") {
    return c.json({ error: "upgrade_required" }, 426);
  }
  const me = await memberFromToken(c.env, tokenFromProtocol(c.req.header("sec-websocket-protocol")));
  if (!me) return c.json({ error: "unauthorized" }, 401);
  const stub = c.env.HOUSEHOLD.get(c.env.HOUSEHOLD.idFromName("home"));
  return stub.fetch("https://do/connect", {
    headers: { upgrade: "websocket", "x-member-id": me.id },
  });
});

export default live;
