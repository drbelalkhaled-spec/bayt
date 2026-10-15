import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleReminders } from "../src/lib/reminders";
import { api, makeHousehold, resetDb } from "./helpers";

const realFetch = globalThis.fetch;
let pushCalls: string[] = [];

const stub = () => env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName("home"));
const getAlarm = () => runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());

const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
};

beforeEach(async () => {
  await resetDb();
  await runInDurableObject(stub(), (_i, state) => state.storage.deleteAlarm());
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

const subscribe = (token: string, who: string) =>
  api("/api/push/subscribe", {
    token,
    body: { subscription: { endpoint: `https://push.example.test/${who}`, keys: { p256dh: "BPkey", auth: "authkey" } } },
  });

async function insertTask(createdBy: string, fields: Record<string, unknown>): Promise<string> {
  const id = crypto.randomUUID();
  const { title = "Task", ...rest } = fields;
  const cols = ["id", "title", "created_by", "created_at", ...Object.keys(rest)];
  const vals = [id, title, createdBy, Date.now(), ...Object.values(rest)];
  await env.DB.prepare(`INSERT INTO tasks(${cols.join(",")}) VALUES (${cols.map((_, i) => "?" + (i + 1)).join(",")})`)
    .bind(...vals)
    .run();
  return id;
}
const reminded = async (id: string) =>
  (await env.DB.prepare("SELECT reminded_at FROM tasks WHERE id = ?1").bind(id).first<{ reminded_at: number | null }>())!
    .reminded_at;

describe("reminders", () => {
  it("schedule arms the alarm at the earliest pending remind_at, or clears it", async () => {
    const { dad, nanny } = await makeHousehold();
    const later = Date.now() + 3 * 3_600_000;
    const sooner = Date.now() + 3_600_000;
    await insertTask(dad.id, { assignee_id: nanny.id, due_on: "2099-01-01", due_time: "10:00", remind_at: later });
    await insertTask(dad.id, { assignee_id: nanny.id, due_on: "2099-01-01", due_time: "09:00", remind_at: sooner });
    await insertTask(dad.id, { remind_at: Date.now() + 60_000, done_at: Date.now(), done_by: dad.id }); // done: ignored
    await insertTask(dad.id, { remind_at: Date.now() + 60_000, blocked_at: Date.now(), blocked_by: nanny.id }); // blocked
    await scheduleReminders(env);
    expect(await getAlarm()).toBe(sooner);
    await env.DB.prepare("DELETE FROM tasks").run();
    await scheduleReminders(env);
    expect(await getAlarm()).toBeNull();
  });

  it("creating a timed task via the API arms the alarm", async () => {
    const { dad } = await makeHousehold();
    const r = await api("/api/tasks", { token: dad.token, body: { title: "Later", due_on: "2099-05-05", due_time: "08:00" } });
    await waitFor(async () => (await getAlarm()) === r.json.task.remind_at);
  });

  it("alarm pushes the assignee once, sets reminded_at, skips done/blocked, reschedules", async () => {
    const { dad, nanny } = await makeHousehold();
    await subscribe(nanny.token, "nanny");
    await subscribe(dad.token, "dad");
    const due = await insertTask(dad.id, { title: "Bath", assignee_id: nanny.id, due_on: "2026-01-01", due_time: "18:00", remind_at: Date.now() - 1000 });
    const done = await insertTask(dad.id, { assignee_id: nanny.id, remind_at: Date.now() - 1000, done_at: Date.now(), done_by: nanny.id });
    const blocked = await insertTask(dad.id, { assignee_id: nanny.id, remind_at: Date.now() - 1000, blocked_at: Date.now(), blocked_by: nanny.id });
    const future = Date.now() + 2 * 3_600_000;
    const fut = await insertTask(dad.id, { assignee_id: nanny.id, remind_at: future });

    await scheduleReminders(env); // alarm at ~now: may fire by itself
    await runDurableObjectAlarm(stub());
    await waitFor(async () => (await reminded(due)) !== null);
    await waitFor(() => pushCalls.length >= 1);
    expect(pushCalls).toEqual(["https://push.example.test/nanny"]);
    const notice = await api("/api/push/notice", { token: nanny.token });
    expect(notice.json.notice.text).toBe("Reminder: Bath at 18:00");
    expect(notice.json.notice.kind).toBe("reminder");
    expect(await reminded(done)).toBeNull();
    expect(await reminded(blocked)).toBeNull();
    expect(await reminded(fut)).toBeNull();
    expect(await getAlarm()).toBe(future);

    // running again sends nothing more
    await env.DB.prepare("UPDATE tasks SET remind_at = ?1 WHERE id = ?2").bind(Date.now() + 3_600_000, fut).run();
    await runDurableObjectAlarm(stub());
    expect(pushCalls).toHaveLength(1);
  });

  it("unassigned tasks remind every active nanny; self-assigned parent still gets it", async () => {
    const { dad, nanny } = await makeHousehold();
    await subscribe(nanny.token, "nanny");
    await subscribe(dad.token, "dad");
    await insertTask(dad.id, { title: "Anyone", due_time: "07:00", due_on: "2026-01-01", remind_at: Date.now() - 1000 });
    await insertTask(dad.id, { title: "Mine", assignee_id: dad.id, due_time: "07:00", due_on: "2026-01-01", remind_at: Date.now() - 1000 });
    await scheduleReminders(env);
    await runDurableObjectAlarm(stub());
    await waitFor(() => pushCalls.length >= 2);
    expect(pushCalls.sort()).toEqual(["https://push.example.test/dad", "https://push.example.test/nanny"]);
    expect(await getAlarm()).toBeNull();
  });
});
