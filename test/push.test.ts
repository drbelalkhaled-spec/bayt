import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCleanup } from "../src/lib/cleanup";
import { VAPID_SUBJECT, ensureVapid, storeNotice } from "../src/lib/push";
import { api, makeHousehold, resetDb } from "./helpers";

const EP = "https://push.example.test/send/abc123";
const EP2 = "https://push.example.test/send/tablet456";
const sub = (endpoint = EP) => ({ endpoint, keys: { p256dh: "BPkey", auth: "authkey" } });

let pushCalls: { url: string; init: RequestInit }[] = [];
let pushStatus = 201;
let pushStatusFor: Record<string, number> = {};
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await resetDb();
  pushCalls = [];
  pushStatus = 201;
  pushStatusFor = {};
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://push.example.test/")) {
      pushCalls.push({ url, init: init ?? {} });
      return new Response(null, { status: pushStatusFor[url] ?? pushStatus });
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
const endpoints = async (id: string) =>
  (await env.DB.prepare("SELECT endpoint FROM push_devices WHERE member_id = ?1 ORDER BY endpoint").bind(id).all<{ endpoint: string }>()).results.map(
    (r) => r.endpoint,
  );
const notices = async (token: string, after = 0) => (await api("/api/push/notices?after=" + after, { token })).json.notices as any[];

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
    expect((await api("/api/push/notices")).status).toBe(401);
    expect((await api("/api/push/status?endpoint=" + encodeURIComponent(EP))).status).toBe(401);
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
    expect(await endpoints(dad.id)).toEqual([]);
    expect((await subscribe(dad.token)).status).toBe(200);
    expect(await endpoints(dad.id)).toEqual([EP]);
  });

  it("keeps every device of a member and upserts by endpoint", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad.token);
    await subscribe(dad.token, sub(EP2));
    await subscribe(dad.token); // the phone re-registers: still two rows
    expect(await endpoints(dad.id)).toEqual([EP, EP2]);
    // the same endpoint is now Mom's: it moves
    await subscribe(mom.token);
    expect(await endpoints(dad.id)).toEqual([EP2]);
    expect(await endpoints(mom.id)).toEqual([EP]);
  });

  it("keeps at most 10 devices per member, newest first", async () => {
    const { dad } = await makeHousehold();
    for (let i = 0; i < 12; i++) {
      await subscribe(dad.token, sub(`https://push.example.test/d/${i}`));
      await new Promise((r) => setTimeout(r, 2));
    }
    const eps = await endpoints(dad.id);
    expect(eps.length).toBe(10);
    expect(eps).not.toContain("https://push.example.test/d/0");
    expect(eps).toContain("https://push.example.test/d/11");
  });

  it("DELETE removes the named device only; without one it removes all of mine", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad.token);
    await subscribe(dad.token, sub(EP2));
    await subscribe(mom.token, sub("https://push.example.test/mom"));
    expect((await api("/api/push/subscribe", { method: "DELETE", token: dad.token, body: { endpoint: EP } })).status).toBe(200);
    expect(await endpoints(dad.id)).toEqual([EP2]);
    // someone else's endpoint is not mine to remove
    await api("/api/push/subscribe", { method: "DELETE", token: dad.token, body: { endpoint: "https://push.example.test/mom" } });
    expect(await endpoints(mom.id)).toEqual(["https://push.example.test/mom"]);
    await subscribe(dad.token);
    await api("/api/push/subscribe?endpoint=" + encodeURIComponent(EP2), { method: "DELETE", token: dad.token });
    expect(await endpoints(dad.id)).toEqual([EP]);
    expect((await api("/api/push/subscribe", { method: "DELETE", token: dad.token })).status).toBe(200);
    expect(await endpoints(dad.id)).toEqual([]);
    expect(await endpoints(mom.id)).toEqual(["https://push.example.test/mom"]);
  });

  it("status says whether this device is registered for me", async () => {
    const { dad, mom } = await makeHousehold();
    const status = async (token: string, ep: string) =>
      (await api("/api/push/status?endpoint=" + encodeURIComponent(ep), { token })).json.subscribed;
    expect(await status(dad.token, EP)).toBe(false);
    await subscribe(dad.token);
    expect(await status(dad.token, EP)).toBe(true);
    expect(await status(dad.token, EP2)).toBe(false);
    expect(await status(mom.token, EP)).toBe(false);
    expect((await api("/api/push/status", { token: dad.token })).json.subscribed).toBe(false);
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

describe("notices", () => {
  it("lists two quick notices in order, each with its own ref", async () => {
    const { dad, nanny } = await makeHousehold();
    await subscribe(nanny.token);
    const a = await api("/api/tasks", { token: dad.token, body: { title: "Mop", assignee_id: nanny.id } });
    const b = await api("/api/tasks", { token: dad.token, body: { title: "Dust", assignee_id: nanny.id, urgent: true } });
    await waitFor(async () => (await notices(nanny.token)).length === 2);
    const list = await notices(nanny.token);
    const byRef = new Map(list.map((n) => [n.ref, n]));
    expect(byRef.get(`task:${a.json.task.id}`)).toMatchObject({ kind: "task_new", text: "Dad added a new task", actorName: "Dad" });
    expect(byRef.get(`task:${b.json.task.id}`)).toMatchObject({ kind: "task_urgent", text: "Urgent from Dad: Dust" });
    expect(list[0].id).toBeTruthy();
    expect(list[1].at).toBeGreaterThan(list[0].at); // oldest first
    // the latest-notice endpoint (old service workers) shows the newest one
    expect((await api("/api/push/notice", { token: nanny.token })).json.notice).toMatchObject({ kind: list[1].kind, ref: list[1].ref });
  });

  it("filters by after, never older than an hour, and returns at most 10", async () => {
    const { dad, mom } = await makeHousehold();
    const t = Date.now();
    const add = (i: number, at: number) =>
      env.DB.prepare("INSERT INTO notices(id, member_id, kind, text, actor_name, ref, at) VALUES (?1, ?2, 'chat', ?3, 'Mom', NULL, ?4)")
        .bind(`n${i}`, dad.id, `m${i}`, at)
        .run();
    await add(0, t - 2 * 3_600_000);
    for (let i = 1; i <= 12; i++) await add(i, t - 60_000 + i);
    const all = await notices(dad.token);
    expect(all.map((n) => n.text)).toEqual(Array.from({ length: 10 }, (_, i) => `m${i + 1}`));
    expect(all[0].ref).toBeNull();
    const rest = await notices(dad.token, all[9].at);
    expect(rest.map((n) => n.text)).toEqual(["m11", "m12"]);
    expect(await notices(dad.token, t)).toEqual([]);
    expect((await api("/api/push/notices?after=junk", { token: dad.token })).json.notices.length).toBe(10);
    // notices are private to the member
    expect(await notices(mom.token)).toEqual([]);
  });

  it("at is strictly increasing even for notices created in the same millisecond", async () => {
    const { dad } = await makeHousehold();
    const t = Date.now();
    for (let i = 0; i < 3; i++) await storeNotice(env, dad.id, { kind: "chat", actorName: "Mom", text: "x" + i, at: t });
    const list = await notices(dad.token, t - 1);
    expect(list.map((n) => n.text)).toEqual(["x0", "x1", "x2"]);
    expect(new Set(list.map((n) => n.at)).size).toBe(3);
  });

  it("carries the thing they are about: task, message and item refs", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    await subscribe(dad.token);
    await subscribe(nanny.token, sub(EP2));
    const seen = async (token: string, n: number) => waitFor(async () => (await notices(token)).length === n);
    const m = await say(mom.token, "hello");
    await seen(dad.token, 1);
    const it = await api("/api/items", { token: mom.token, body: { name: "Milk" } });
    await seen(dad.token, 2);
    const t = await api("/api/tasks", { token: mom.token, body: { title: "Mop" } });
    await seen(nanny.token, 3);
    const c = await api(`/api/tasks/${t.json.task.id}/comments`, { token: nanny.token, body: { body: "where is the mop?" } });
    expect(c.status).toBe(200);
    await seen(dad.token, 3);
    const tag = (l: any[]) => l.map((n) => [n.kind, n.ref]);
    expect(tag(await notices(dad.token))).toEqual([
      ["chat", `msg:${m.json.message.id}`],
      ["item", `item:${it.json.item.id}`],
      ["task_comment", `task:${t.json.task.id}`],
    ]);
    expect(tag(await notices(nanny.token))).toEqual([
      ["chat", `msg:${m.json.message.id}`],
      ["item", `item:${it.json.item.id}`],
      ["task_new", `task:${t.json.task.id}`],
    ]);
  });
});

describe("delivery rules", () => {
  it("throttles chat to one push per 2 minutes but keeps every notice", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad.token);
    await say(mom.token, "one");
    await waitFor(() => pushCalls.length === 1);
    await say(mom.token, "two");
    await waitFor(async () => (await notices(dad.token)).length === 2);
    await settle();
    expect(pushCalls.length).toBe(1);
    expect((await api("/api/push/notice", { token: dad.token })).json.notice.text).toBe("New message from Mom");
    // after the window, pushes resume
    await env.DB.prepare("UPDATE push_log SET sent_at = sent_at - 121000").run();
    await say(mom.token, "three");
    await waitFor(() => pushCalls.length === 2);
  });

  it("sends to every device of the recipient", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad.token);
    await subscribe(dad.token, sub(EP2));
    await say(mom.token, "hi");
    await waitFor(() => pushCalls.length === 2);
    expect(pushCalls.map((c) => c.url).sort()).toEqual([EP, EP2]);
    expect((await notices(dad.token)).length).toBe(1); // one notice, however many devices
  });

  it("removes only the device whose push service says gone (404/410)", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad.token);
    await subscribe(dad.token, sub(EP2));
    pushStatusFor[EP] = 410;
    await say(mom.token, "hi");
    await waitFor(() => pushCalls.length === 2);
    await waitFor(async () => (await endpoints(dad.id)).length === 1);
    expect(await endpoints(dad.id)).toEqual([EP2]);
    pushStatusFor[EP2] = 404;
    await env.DB.prepare("UPDATE push_log SET sent_at = sent_at - 121000").run();
    await say(mom.token, "again");
    await waitFor(async () => (await endpoints(dad.id)).length === 0);
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

  it("test endpoint targets the named device, else all of mine", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad.token);
    await subscribe(dad.token, sub(EP2));
    await subscribe(mom.token, sub("https://push.example.test/mom"));
    const one = await api("/api/push/test", { token: dad.token, body: { endpoint: EP2 } });
    expect(one.json.sent).toBe(true);
    expect(pushCalls.map((c) => c.url)).toEqual([EP2]);
    expect((await api("/api/push/test", { token: dad.token, body: { endpoint: "https://push.example.test/mom" } })).status).toBe(400);
    pushCalls = [];
    await api("/api/push/test", { token: dad.token, method: "POST" });
    expect(pushCalls.map((c) => c.url).sort()).toEqual([EP, EP2]);
  });
});

describe("retention", () => {
  it("drops notices older than 3 days and devices of removed members", async () => {
    const { dad, nanny } = await makeHousehold();
    await subscribe(nanny.token);
    await subscribe(dad.token, sub(EP2));
    const t = Date.now();
    await storeNotice(env, dad.id, { kind: "chat", actorName: "Mom", text: "old", at: t - 4 * 86_400_000 });
    await storeNotice(env, dad.id, { kind: "chat", actorName: "Mom", text: "new", at: t - 1000 });
    // a removed member whose rows survived somehow
    await env.DB.prepare("UPDATE members SET removed_at = ?1 WHERE id = ?2").bind(t, nanny.id).run();
    await runCleanup(env);
    expect((await env.DB.prepare("SELECT text FROM notices").all<{ text: string }>()).results.map((r) => r.text)).toEqual(["new"]);
    expect(await endpoints(nanny.id)).toEqual([]);
    expect(await endpoints(dad.id)).toEqual([EP2]);
  });
});
