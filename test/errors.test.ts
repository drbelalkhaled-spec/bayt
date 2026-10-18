import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCleanup } from "../src/lib/cleanup";
import { MAX_ROWS, reportError } from "../src/lib/errors";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const EP = "https://push.example.test/send/errors";
const BAD = "https://push.example.test/fail/errors";
const realFetch = globalThis.fetch;

let dad: TestMember, mom: TestMember, nanny: TestMember;
beforeEach(async () => {
  await resetDb();
  ({ dad, mom, nanny } = await makeHousehold());
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://push.example.test/fail/")) return new Response(null, { status: 403 });
    if (url.startsWith("https://push.example.test/")) return new Response(null, { status: 201 });
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const subscribe = (m: TestMember, endpoint = EP + "/" + m.id) =>
  api("/api/push/subscribe", { token: m.token, body: { subscription: { endpoint, keys: { p256dh: "a", auth: "b" } } } });
const notice = async (m: TestMember) => (await api("/api/push/notice", { token: m.token })).json.notice;
const rows = async () =>
  (await env.DB.prepare("SELECT source, message, detail FROM error_log ORDER BY at").all<{ source: string; message: string; detail: string | null }>())
    .results;

describe("reportError", () => {
  it("logs, and alerts only parents who opted in, at most once an hour", async () => {
    await subscribe(dad);
    await subscribe(mom);
    expect((await api("/api/errors/alerts", { method: "PUT", token: dad.token, body: { on: true } })).json.alerts).toBe(true);
    await reportError(env, "GET /api/x", new Error("boom"));
    expect((await rows()).map((r) => [r.source, r.message])).toEqual([["GET /api/x", "boom"]]);
    expect((await rows())[0]!.detail).toContain("Error: boom");
    expect(await notice(dad)).toMatchObject({ kind: "error", text: "Bayt had a problem (GET /api/x): boom" });
    expect((await notice(mom)).kind).not.toBe("error"); // mom did not opt in
    await reportError(env, "daily cleanup", "second");
    expect(await rows()).toHaveLength(2);
    expect((await notice(dad)).text).toContain("boom"); // throttled: still the first alert
  });

  it("records refused notifications without looping", async () => {
    await subscribe(dad, BAD);
    await api("/api/errors/alerts", { method: "PUT", token: dad.token, body: { on: true } });
    await api("/api/push/test", { token: dad.token, body: {} });
    const r = await rows();
    expect(r.map((x) => x.source)).toEqual(["notifications"]);
    expect(r[0]!.message).toContain("HTTP 403");
  });
});

describe("/api/errors", () => {
  it("takes screen errors from members, with a per-person hourly cap", async () => {
    expect((await api("/api/errors", { body: { message: "x" } })).status).toBe(401);
    expect((await api("/api/errors", { token: nanny.token, body: { message: " " } })).status).toBe(400);
    const ok = await api("/api/errors", { token: nanny.token, body: { message: "TypeError: x is undefined", stack: "at a.js:1", where: "#/tasks" } });
    expect(ok.status).toBe(200);
    expect(await rows()).toEqual([{ source: "app · Nanny", message: "TypeError: x is undefined", detail: "on #/tasks\nat a.js:1" }]);
    for (let i = 0; i < 19; i++) await api("/api/errors", { token: nanny.token, body: { message: "e" + i } });
    expect((await api("/api/errors", { token: nanny.token, body: { message: "one too many" } })).status).toBe(429);
    expect((await api("/api/errors", { token: mom.token, body: { message: "mom's own cap" } })).status).toBe(200);
  });

  it("the hourly cap survives a rename", async () => {
    for (let i = 0; i < 20; i++) await api("/api/errors", { token: dad.token, body: { message: "d" + i } });
    expect((await api("/api/errors", { token: dad.token, body: { message: "blocked" } })).status).toBe(429);
    expect((await api("/api/me", { method: "PATCH", token: dad.token, body: { name: "Daddy" } })).status).toBe(200);
    expect((await api("/api/errors", { token: dad.token, body: { message: "still blocked" } })).status).toBe(429);
  });

  it("keeps at most MAX_ROWS rows, dropping the oldest", async () => {
    const t = Date.now() - 1000;
    await env.DB.batch(
      Array.from({ length: MAX_ROWS }, (_, i) =>
        env.DB.prepare("INSERT INTO error_log(id, at, source, message) VALUES (?1, ?2, 'old', ?3)").bind("r" + i, t + i, "m" + i),
      ),
    );
    await reportError(env, "new", "newest");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM error_log").first<{ n: number }>();
    expect(n!.n).toBe(MAX_ROWS);
    expect(await env.DB.prepare("SELECT 1 FROM error_log WHERE id = 'r0'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM error_log WHERE message = 'newest'").first()).not.toBeNull();
  });

  it("parents list, clear and toggle; helpers cannot", async () => {
    await reportError(env, "s1", "first");
    await reportError(env, "s2", "second");
    expect((await api("/api/errors", { token: nanny.token })).status).toBe(403);
    expect((await api("/api/errors", { method: "DELETE", token: nanny.token })).status).toBe(403);
    expect((await api("/api/errors/alerts", { method: "PUT", token: nanny.token, body: { on: true } })).status).toBe(403);
    expect((await api("/api/errors/alerts", { method: "PUT", token: dad.token, body: { on: "yes" } })).status).toBe(400);
    const l = await api("/api/errors", { token: dad.token });
    expect(l.json.alerts).toBe(false);
    expect(l.json.errors.map((e: any) => e.message)).toEqual(["second", "first"]);
    await api("/api/errors", { method: "DELETE", token: dad.token });
    expect((await api("/api/errors", { token: dad.token })).json.errors).toEqual([]);
  });

  it("forgets problems after 30 days", async () => {
    await reportError(env, "old", "old one");
    await env.DB.prepare("UPDATE error_log SET at = ?1").bind(Date.now() - 31 * 86_400_000).run();
    await reportError(env, "new", "new one");
    await runCleanup(env);
    expect((await rows()).map((r) => r.message)).toEqual(["new one"]);
  });
});
