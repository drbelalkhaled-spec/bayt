import { SELF, env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { emit } from "../src/lib/events";
import { makeHousehold, resetDb, type TestMember } from "./helpers";

async function open(token: string): Promise<{ ws: WebSocket; msgs: any[]; res: Response }> {
  const res = await SELF.fetch("http://x/api/live", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `bayt, ${token}` },
  });
  if (!res.webSocket) throw new Error("no ws: " + res.status + " " + (await res.text()));
  const ws = res.webSocket;
  const msgs: any[] = [];
  ws.addEventListener("message", (e) => {
    msgs.push(JSON.parse(e.data as string));
  });
  ws.accept();
  return { ws, msgs, res };
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const t = Date.now();
  while (!fn()) {
    if (Date.now() - t > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("live", () => {
  let dad: TestMember, mom: TestMember;
  beforeEach(async () => {
    await resetDb();
    ({ dad, mom } = await makeHousehold());
  });

  it("rejects non-upgrade requests", async () => {
    const res = await SELF.fetch("http://x/api/live");
    expect([400, 426]).toContain(res.status);
  });

  it("rejects bad token and URL tokens", async () => {
    const bad = await SELF.fetch("http://x/api/live", {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "bayt, nope" },
    });
    expect(bad.status).toBe(401);
    const inUrl = await SELF.fetch(`http://x/api/live?token=${dad.token}`, { headers: { Upgrade: "websocket" } });
    expect(inUrl.status).toBe(401);
  });

  it("connects with bayt subprotocol and gets hello", async () => {
    const { ws, msgs, res } = await open(dad.token);
    expect(res.status).toBe(101);
    expect(res.headers.get("sec-websocket-protocol")).toBe("bayt");
    await until(() => msgs.some((m) => m.type === "hello"));
    expect(msgs.find((m) => m.type === "hello").online).toEqual([dad.id]);
    ws.close();
  });

  it("emit broadcasts changed", async () => {
    const { ws, msgs } = await open(dad.token);
    await until(() => msgs.some((m) => m.type === "hello"));
    const ctx = createExecutionContext();
    await emit(env, ctx, "list");
    await waitOnExecutionContext(ctx);
    await until(() => msgs.some((m) => m.type === "changed"));
    expect(msgs.find((m) => m.type === "changed")).toEqual({ type: "changed", scope: "list" });
    ws.close();
  });

  it("typing relays to others, not sender; presence updates", async () => {
    const a = await open(dad.token);
    const b = await open(mom.token);
    await until(() => b.msgs.some((m) => m.type === "hello"));
    await until(() => a.msgs.some((m) => m.type === "presence" && m.online.length === 2));
    a.ws.send(JSON.stringify({ type: "typing" }));
    await until(() => b.msgs.some((m) => m.type === "typing"));
    expect(b.msgs.find((m) => m.type === "typing")).toEqual({ type: "typing", memberId: dad.id });
    await new Promise((r) => setTimeout(r, 100));
    expect(a.msgs.some((m) => m.type === "typing")).toBe(false);
    a.ws.close();
    b.ws.close();
  });
});
