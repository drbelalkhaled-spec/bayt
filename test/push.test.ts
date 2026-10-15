import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VAPID_SUBJECT, ensureVapid } from "../src/lib/push";
import { api, makeHousehold, resetDb } from "./helpers";

const EP = "https://push.example.test/send/abc123";
const sub = (endpoint = EP) => ({ endpoint, keys: { p256dh: "BPkey", auth: "authkey" } });

let pushCalls: { url: string; init: RequestInit }[] = [];
let pushStatus = 201;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await resetDb();
  pushCalls = [];
  pushStatus = 201;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://push.example.test/")) {
      pushCalls.push({ url, init: init ?? {} });
      return new Response(null, { status: pushStatus });
    }
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
};
const settle = () => new Promise((r) => setTimeout(r, 150));
const subscribe = (token: string, s: unknown = sub()) =>
  api("/api/push/subscribe", { token, body: { subscription: s } });
const say = (token: string, body: string) => api("/api/messages", { token, body: { body } });
const pushSub = (id: string) =>
  env.DB.prepare("SELECT push_sub FROM members WHERE id = ?1").bind(id).first<{ push_sub: string | null }>();

describe("vapid key", () => {
  it("is stable across calls and needs no auth", async () => {
    const a = await api("/api/push/key");
    const b = await api("/api/push/key");
    expect(a.status).toBe(200);
    expect(a.json.key).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(b.json.key).toBe(a.json.key);
    expect((await ensureVapid(env)).pub).toBe(a.json.key);
  });
});

describe("subscribe", () => {
  it("requires auth", async () => {
    expect((await api("/api/push/subscribe", { body: { subscription: sub() } })).status).toBe(401);
    expect((await api("/api/push/notice")).status).toBe(401);
    expect((await api("/api/push/test", { method: "POST" })).status).toBe(401);
  });

  it("validates the subscription", async () => {
    const { dad } = await makeHousehold();
    const bad: unknown[] = [
      null,
      "x",
      { endpoint: "http://push.example.test/x", keys: { p256dh: "a", auth: "b" } },
      { endpoint: "https://localhost/x", keys: { p256dh: "a", auth: "b" } },
      { endpoint: "not a url", keys: { p256dh: "a", auth: "b" } },
      { endpoint: EP },
      { endpoint: EP, keys: { p256dh: 1, auth: "b" } },
      { endpoint: EP, keys: { p256dh: "a" } },
      { endpoint: EP, keys: { p256dh: "a".repeat(3000), auth: "b" } },
    ];
    for (const s of bad) expect((await subscribe(dad.token, s)).status).toBe(400);
    expect((await pushSub(dad.id))!.push_sub).toBeNull();
    expect((await subscribe(dad.token)).status).toBe(200);
    expect(JSON.parse((await pushSub(dad.id))!.push_sub!).endpoint).toBe(EP);
  });

  it("DELETE clears", async () => {
    const { dad } = await makeHousehold();
    await subscribe(dad.token);
    expect((await api("/api/push/subscribe", { method: "DELETE", token: dad.token })).status).toBe(200);
    expect((await pushSub(dad.id))!.push_sub).toBeNull();
  });
});

describe("notice", () => {
  it("falls back to a generic notice", async () => {
    const { dad } = await makeHousehold();
    const r = await api("/api/push/notice", { token: dad.token });
    expect(r.json.notice).toEqual({ title: "Bayt", text: "Something changed at home" });
  });

  it("is stored after a message from another member, not consumed, and a vapid push is sent", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad.token);
    expect((await say(mom.token, "hello")).status).toBe(200);
    await waitFor(() => pushCalls.length === 1);
    const call = pushCalls[0]!;
    expect(call.url).toBe(EP);
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBeUndefined();
    const h = call.init.headers as Record<string, string>;
    expect(h.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    expect(h.TTL).toBeTruthy();
    const jwt = h.Authorization.slice(8, h.Authorization.indexOf(","));
    const claims = JSON.parse(atob(jwt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.aud).toBe("https://push.example.test");
    expect(claims.sub).toBe(VAPID_SUBJECT);
    expect(claims.exp - Date.now() / 1000).toBeLessThanOrEqual(12 * 3600);
    const n1 = await api("/api/push/notice", { token: dad.token });
    expect(n1.json.notice.text).toBe("New message from Mom");
    const n2 = await api("/api/push/notice", { token: dad.token });
    expect(n2.json.notice.text).toBe("New message from Mom");
  });
});

describe("delivery rules", () => {
  it("throttles chat to one push per 2 minutes but updates the notice", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad.token);
    await say(mom.token, "one");
    await waitFor(() => pushCalls.length === 1);
    await say(mom.token, "two");
    await settle();
    expect(pushCalls.length).toBe(1);
    const n = await api("/api/push/notice", { token: dad.token });
    expect(n.json.notice.text).toBe("New message from Mom");
    // after the window, pushes resume
    await env.DB.prepare("UPDATE push_log SET sent_at = sent_at - 121000").run();
    await say(mom.token, "three");
    await waitFor(() => pushCalls.length === 2);
  });

  it("clears the subscription on 410", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad.token);
    pushStatus = 410;
    await say(mom.token, "hi");
    await waitFor(() => pushCalls.length === 1);
    await waitFor(async () => (await pushSub(dad.id))!.push_sub === null);
  });

  it("never pushes the actor and skips removed members", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    await subscribe(mom.token);
    await subscribe(nanny.token, sub("https://push.example.test/nanny"));
    await env.DB.prepare("UPDATE members SET removed_at = 1 WHERE id = ?1").bind(nanny.id).run();
    await say(mom.token, "talking to myself");
    await settle();
    expect(pushCalls.length).toBe(0);
    // dad (no subscription) posts: only mom is pushed, removed nanny gets nothing
    await say(dad.token, "hey");
    await waitFor(() => pushCalls.length === 1);
    await settle();
    expect(pushCalls.map((c) => c.url)).toEqual([EP]);
  });

  it("test endpoint pushes to me", async () => {
    const { dad } = await makeHousehold();
    expect((await api("/api/push/test", { token: dad.token, method: "POST" })).status).toBe(400);
    await subscribe(dad.token);
    const r = await api("/api/push/test", { token: dad.token, method: "POST" });
    expect(r.json.sent).toBe(true);
    expect(pushCalls.length).toBe(1);
    expect((await api("/api/push/notice", { token: dad.token })).json.notice.text).toBe("Test notification");
  });
});
