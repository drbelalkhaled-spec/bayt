import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportError } from "../src/lib/errors";
import type { PushIntent } from "../src/lib/events";
import { categoryOf, parsePrefs } from "../src/lib/prefs";
import { deliver } from "../src/lib/push";
import { inQuiet, timeIn } from "../src/lib/recur";
import { setTz } from "../src/lib/util";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const EP_DAD = "https://push.example.test/send/dad";
const EP_MOM = "https://push.example.test/send/mom";
const EP_NANNY = "https://push.example.test/send/nanny";
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: "BPkey", auth: "authkey" } });
const HOUR = 3_600_000;
const DEFAULTS = { chat: true, tasks: true, list: true, quiet: null };

let pushCalls: string[] = [];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await resetDb();
  pushCalls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://push.example.test/")) {
      pushCalls.push(url);
      return new Response(null, { status: 201 });
    }
    return realFetch(input, init);
  });
});
afterEach(() => vi.restoreAllMocks());

const subscribe = (m: TestMember, endpoint: string) => api("/api/push/subscribe", { token: m.token, body: { subscription: sub(endpoint) } });
const setPrefs = (m: TestMember, prefs: unknown) => api("/api/push/prefs", { method: "PUT", token: m.token, body: { prefs } });
const getPrefs = async (m: TestMember) => (await api("/api/push/prefs", { token: m.token })).json.prefs;
const notices = async (m: TestMember) => (await api("/api/push/notices?after=0", { token: m.token })).json.notices as any[];
const send = (kind: PushIntent["kind"], to: TestMember[], from: TestMember) =>
  deliver(env, { kind, to: to.map((m) => m.id), actorId: from.id, ref: kind.startsWith("task") ? "task:t1" : undefined });
/** 'HH:MM' in tz, `h` hours from now. */
const at = (tz: string, h: number) => timeIn(tz, Date.now() + h * HOUR);
/** A quiet range around now in tz. */
const quietNow = (tz = "UTC") => ({ from: at(tz, -1), to: at(tz, 1) });

describe("inQuiet / timeIn", () => {
  it("a range within one day: from inclusive, to exclusive", () => {
    const q = { from: "13:00", to: "15:00" };
    expect([inQuiet(q, "12:59"), inQuiet(q, "13:00"), inQuiet(q, "14:59"), inQuiet(q, "15:00"), inQuiet(q, "23:00")]).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
  });

  it("a range that wraps midnight", () => {
    const q = { from: "22:00", to: "07:00" };
    const hits = ["21:59", "22:00", "23:59", "00:00", "03:30", "06:59", "07:00", "12:00"].map((t) => inQuiet(q, t));
    expect(hits).toEqual([false, true, true, true, true, true, false, false]);
    expect(inQuiet({ from: "23:00", to: "00:00" }, "23:30")).toBe(true);
    expect(inQuiet({ from: "23:00", to: "00:00" }, "00:00")).toBe(false);
  });

  it("no range, or from === to, is never quiet", () => {
    expect(inQuiet(null, "03:00")).toBe(false);
    expect(inQuiet({ from: "10:00", to: "10:00" }, "10:00")).toBe(false);
  });

  it("timeIn is the wall clock in a time zone", () => {
    const t = Date.UTC(2026, 0, 15, 22, 5);
    expect(timeIn("UTC", t)).toBe("22:05");
    expect(timeIn("Asia/Riyadh", t)).toBe("01:05");
    expect(timeIn("America/New_York", t)).toBe("17:05");
    expect(timeIn("UTC", Date.UTC(2026, 0, 15, 0, 0))).toBe("00:00");
    expect(timeIn("Asia/Riyadh", Date.UTC(2026, 0, 15, 21, 0))).toBe("00:00");
    expect(timeIn("UTC")).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  });
});

describe("categories", () => {
  it("maps kinds to the three switches; urgent and reminder kinds belong to none", () => {
    expect(categoryOf("chat")).toBe("chat");
    for (const k of ["task_new", "task_comment", "task_seen", "task_done", "task_blocked"] as const) expect(categoryOf(k)).toBe("tasks");
    for (const k of ["item", "shopping"] as const) expect(categoryOf(k)).toBe("list");
    for (const k of ["task_urgent", "item_urgent", "reminder", "msg_reminder", "test", "error"] as const) expect(categoryOf(k)).toBeNull();
  });
});

describe("prefs api", () => {
  it("needs a signed-in member", async () => {
    expect((await api("/api/push/prefs")).status).toBe(401);
    expect((await api("/api/push/prefs", { method: "PUT", body: { prefs: DEFAULTS } })).status).toBe(401);
  });

  it("returns the defaults until something is saved", async () => {
    const { dad } = await makeHousehold();
    const r = await api("/api/push/prefs", { token: dad.token });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ prefs: DEFAULTS });
  });

  it("saves, canonicalises, and keeps each person's choices separate", async () => {
    const { dad, mom } = await makeHousehold();
    const r = await setPrefs(dad, { quiet: { to: "07:00", from: "22:00" }, list: true, tasks: false, chat: true });
    expect(r.status).toBe(200);
    const want = { chat: true, tasks: false, list: true, quiet: { from: "22:00", to: "07:00" } };
    expect(r.json).toEqual({ prefs: want });
    expect(await getPrefs(dad)).toEqual(want);
    expect(await getPrefs(mom)).toEqual(DEFAULTS);
    const row = await env.DB.prepare("SELECT notify_prefs FROM members WHERE id = ?1").bind(dad.id).first<{ notify_prefs: string }>();
    expect(row!.notify_prefs).toBe('{"chat":true,"tasks":false,"list":true,"quiet":{"from":"22:00","to":"07:00"}}');
    expect((await setPrefs(dad, DEFAULTS)).status).toBe(200);
    expect(await getPrefs(dad)).toEqual(DEFAULTS);
  });

  it("helpers can set their own too", async () => {
    const { nanny } = await makeHousehold();
    expect((await setPrefs(nanny, { ...DEFAULTS, chat: false })).status).toBe(200);
    expect((await getPrefs(nanny)).chat).toBe(false);
  });

  it("refuses anything invalid with bad_prefs and keeps what was saved", async () => {
    const { dad } = await makeHousehold();
    const keep = { chat: false, tasks: true, list: true, quiet: null };
    await setPrefs(dad, keep);
    const q = (quiet: unknown) => ({ ...DEFAULTS, quiet });
    const bad: unknown[] = [
      undefined,
      null,
      "x",
      [],
      {},
      { chat: true, tasks: true, list: true }, // missing quiet
      { chat: true, tasks: true, quiet: null }, // missing list
      { ...DEFAULTS, extra: 1 },
      { ...DEFAULTS, chat: "true" },
      { ...DEFAULTS, tasks: 1 },
      { ...DEFAULTS, list: null },
      q(undefined),
      q("22:00"),
      q([]),
      q({}),
      q({ from: "22:00" }),
      q({ to: "07:00" }),
      q({ from: "22:00", to: "07:00", extra: true }),
      q({ from: "22:00", to: "22:00" }), // from === to
      q({ from: "24:00", to: "07:00" }),
      q({ from: "22:60", to: "07:00" }),
      q({ from: "7:00", to: "22:00" }),
      q({ from: "22:00", to: "07:00:00" }),
      q({ from: 2200, to: "07:00" }),
      q({ from: null, to: "07:00" }),
    ];
    for (const prefs of bad) {
      const r = await setPrefs(dad, prefs);
      expect([r.status, r.json]).toEqual([400, { error: "bad_prefs" }]);
    }
    expect(await getPrefs(dad)).toEqual(keep);
    expect(parsePrefs(q({ from: "00:00", to: "23:59" }))).toEqual(q({ from: "00:00", to: "23:59" }));
  });

  it("treats corrupt stored prefs as the defaults", async () => {
    const { dad } = await makeHousehold();
    await env.DB.prepare("UPDATE members SET notify_prefs = ?1 WHERE id = ?2").bind("{nope", dad.id).run();
    expect(await getPrefs(dad)).toEqual(DEFAULTS);
    await env.DB.prepare("UPDATE members SET notify_prefs = ?1 WHERE id = ?2").bind('{"chat":false}', dad.id).run();
    expect(await getPrefs(dad)).toEqual(DEFAULTS);
  });
});

describe("a category switched off", () => {
  it("chat: no notice and no push for that member, the others still get both", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    await subscribe(dad, EP_DAD);
    await subscribe(nanny, EP_NANNY);
    await setPrefs(dad, { ...DEFAULTS, chat: false });
    expect((await api("/api/messages", { token: mom.token, body: { body: "hello" } })).status).toBe(200);
    const end = Date.now() + 3000;
    while (!pushCalls.length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 150));
    expect(pushCalls).toEqual([EP_NANNY]);
    expect(await notices(dad)).toEqual([]);
    expect((await notices(nanny)).map((n) => n.kind)).toEqual(["chat"]);
  });

  it("each switch governs exactly its kinds", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad, EP_DAD);
    const tasks = ["task_new", "task_comment", "task_seen", "task_done", "task_blocked"] as const;
    const list = ["item", "shopping"] as const;
    const only = (on: "chat" | "tasks" | "list") => ({ chat: on === "chat", tasks: on === "tasks", list: on === "list", quiet: null });
    const run = async (on: "chat" | "tasks" | "list") => {
      await env.DB.batch([env.DB.prepare("DELETE FROM notices"), env.DB.prepare("DELETE FROM push_log")]);
      pushCalls = [];
      await setPrefs(dad, only(on));
      for (const k of ["chat", ...tasks, ...list] as const) {
        await send(k, [dad], mom);
        await env.DB.prepare("DELETE FROM push_log").run(); // the throttle is not what is under test
      }
      return (await notices(dad)).map((n) => n.kind).sort();
    };
    expect(await run("chat")).toEqual(["chat"]);
    expect(pushCalls.length).toBe(1);
    expect(await run("tasks")).toEqual([...tasks].sort());
    expect(pushCalls.length).toBe(tasks.length);
    expect(await run("list")).toEqual([...list].sort());
    expect(pushCalls.length).toBe(list.length);
  });

  it("urgent tasks, 'needed today' items, reminders, the test push and problem alerts ignore every switch and quiet hours", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad, EP_DAD);
    await setPrefs(dad, { chat: false, tasks: false, list: false, quiet: quietNow() });
    for (const k of ["task_urgent", "item_urgent", "reminder", "msg_reminder"] as const) await send(k, [dad], mom);
    expect((await notices(dad)).map((n) => n.kind).sort()).toEqual(["item_urgent", "msg_reminder", "reminder", "task_urgent"]);
    expect(pushCalls.length).toBe(4);

    pushCalls = [];
    const t = await api("/api/push/test", { method: "POST", token: dad.token, body: { endpoint: EP_DAD } });
    expect(t.json).toEqual({ ok: true, sent: true });
    expect(pushCalls).toEqual([EP_DAD]);

    pushCalls = [];
    await api("/api/errors/alerts", { method: "PUT", token: dad.token, body: { on: true } });
    await reportError(env, "notify-prefs-test", "boom");
    expect(pushCalls).toEqual([EP_DAD]);
    expect((await notices(dad)).map((n) => n.kind)).toContain("error");
  });
});

describe("quiet hours", () => {
  it("keeps the notice but sends no push", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad, EP_DAD);
    await setPrefs(dad, { ...DEFAULTS, quiet: quietNow() });
    await send("task_new", [dad], mom);
    await send("shopping", [dad], mom);
    await send("chat", [dad], mom);
    expect(pushCalls).toEqual([]);
    expect((await notices(dad)).map((n) => n.kind)).toEqual(["task_new", "shopping", "chat"]);
  });

  it("pushes as usual outside the range", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad, EP_DAD);
    await setPrefs(dad, { ...DEFAULTS, quiet: { from: at("UTC", 1), to: at("UTC", 2) } });
    await send("task_new", [dad], mom);
    expect(pushCalls).toEqual([EP_DAD]);
    expect(await notices(dad)).toHaveLength(1);
  });

  it("a range that wraps past midnight and covers now is quiet", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad, EP_DAD);
    // everything except the half hour that starts an hour from now: from is later than to unless midnight falls in between
    await setPrefs(dad, { ...DEFAULTS, quiet: { from: at("UTC", 1.5), to: at("UTC", 1) } });
    await send("task_done", [dad], mom);
    expect(pushCalls).toEqual([]);
    expect(await notices(dad)).toHaveLength(1);
  });

  it("is evaluated in the household time zone", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad, EP_DAD);
    const tz = "Pacific/Auckland"; // 12-13 hours from UTC, so the two clocks never agree
    await setTz(env, tz);
    await setPrefs(dad, { ...DEFAULTS, quiet: quietNow("UTC") });
    await send("task_new", [dad], mom);
    expect(pushCalls).toEqual([EP_DAD]); // 'now' in Auckland is nowhere near the UTC range

    pushCalls = [];
    await setPrefs(dad, { ...DEFAULTS, quiet: quietNow(tz) });
    await send("task_new", [dad], mom);
    expect(pushCalls).toEqual([]);
  });

  it("only silences the member who set it", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    await subscribe(dad, EP_DAD);
    await subscribe(nanny, EP_NANNY);
    await setPrefs(dad, { ...DEFAULTS, quiet: quietNow() });
    await send("task_new", [dad, nanny], mom);
    expect(pushCalls).toEqual([EP_NANNY]);
    expect(await notices(dad)).toHaveLength(1);
    expect(await notices(nanny)).toHaveLength(1);
  });

  it("does not use up the throttle: the first push after quiet hours goes straight out", async () => {
    const { dad, mom } = await makeHousehold();
    await subscribe(dad, EP_DAD);
    await setPrefs(dad, { ...DEFAULTS, quiet: quietNow() });
    await send("chat", [dad], mom);
    expect(pushCalls).toEqual([]);
    await setPrefs(dad, DEFAULTS);
    await send("chat", [dad], mom);
    expect(pushCalls).toEqual([EP_DAD]);
  });

  it("a category that is off stays silent for that member while the others still get the push", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    await subscribe(dad, EP_DAD);
    await subscribe(mom, EP_MOM);
    await setPrefs(dad, { chat: false, tasks: true, list: true, quiet: quietNow() });
    await send("chat", [dad, mom], nanny);
    expect(pushCalls).toEqual([EP_MOM]);
    expect(await notices(dad)).toEqual([]);
  });
});
