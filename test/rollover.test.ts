import { createExecutionContext, createScheduledController, env, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runCleanup } from "../src/lib/cleanup";
import { addDays, todayIn, weekdayOf } from "../src/lib/recur";
import { rollRoutines } from "../src/lib/rollover";
import worker from "../src/worker";
import { api, makeHousehold, resetDb, type TestMember } from "./helpers";

const DAY = 86_400_000;

beforeEach(async () => {
  await resetDb();
  await runInDurableObject(stub(), (_i, state) => state.storage.deleteAlarm());
});

const stub = () => env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName("home"));
const getAlarm = () => runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());

const mk = async (m: TestMember, body: Record<string, unknown>) => {
  const r = await api("/api/tasks", { token: m.token, body });
  expect(r.status).toBe(200);
  return r.json.task as { id: string; due_on: string; series_id: string };
};
const routine = (m: TestMember, due_on: string, extra: Record<string, unknown> = {}) =>
  mk(m, { title: "Pack school bags", recur: { freq: "daily" }, slot: "morning", due_on, ...extra });
const row = (id: string) => env.DB.prepare("SELECT * FROM tasks WHERE id = ?1").bind(id).first<any>();
const misses = async () => (await env.DB.prepare("SELECT * FROM task_misses ORDER BY due_on").all<any>()).results;
const roll = async (t?: number) => {
  const ctx = createExecutionContext();
  const n = await rollRoutines(env, ctx, t);
  await waitOnExecutionContext(ctx);
  return n;
};

describe("routine rollover", () => {
  it("moves an unticked daily routine to today, records each missed day, clears seen/blocked", async () => {
    const { dad, nanny } = await makeHousehold();
    const today = todayIn("UTC");
    const t = await routine(dad, addDays(today, -3), { assignee_id: nanny.id });
    await env.DB.prepare(
      "UPDATE tasks SET seen_at = 1, seen_by = ?1, blocked_at = 2, blocked_by = ?1, blocked_reason = 'no bags' WHERE id = ?2",
    )
      .bind(nanny.id, t.id)
      .run();

    const l = await api("/api/tasks", { token: nanny.token });
    expect(l.json.open).toHaveLength(1);
    const o = l.json.open[0];
    expect(o.id).toBe(t.id);
    expect(o.due_on).toBe(today);
    for (const k of ["seen_at", "seen_by", "blocked_at", "blocked_by", "blocked_reason"]) expect(o[k]).toBeNull();

    const m = await misses();
    expect(m.map((x) => x.due_on)).toEqual([addDays(today, -3), addDays(today, -2), addDays(today, -1)]);
    for (const x of m) {
      expect(x).toMatchObject({ series_id: t.series_id, task_id: t.id, title: "Pack school bags", assignee_id: nanny.id, slot: "morning" });
      expect(x.created_at).toBeGreaterThan(0);
    }
    expect(new Set(m.map((x) => x.id)).size).toBe(3);
  });

  it("keeps the weekday cadence of a weekly routine", async () => {
    const { dad } = await makeHousehold();
    const today = todayIn("UTC");
    const days = [1, 4];
    let due = addDays(today, -10);
    while (!days.includes(weekdayOf(due))) due = addDays(due, -1);
    const t = await mk(dad, { title: "Bins", recur: { freq: "weekly", weekdays: days }, slot: "evening", due_on: due });
    const expected: string[] = [];
    for (let d = due; d < today; d = addDays(d, 1)) if (days.includes(weekdayOf(d))) expected.push(d);
    let next = today;
    while (!days.includes(weekdayOf(next))) next = addDays(next, 1);

    await api("/api/tasks", { token: dad.token });
    expect((await row(t.id)).due_on).toBe(next);
    expect((await misses()).map((x) => x.due_on)).toEqual(expected);
  });

  it("keeps the interval of an every-N-days routine", async () => {
    const { dad } = await makeHousehold();
    const today = todayIn("UTC");
    const t = await mk(dad, { title: "Water plants", recur: { freq: "every", days: 3 }, slot: "afternoon", due_on: addDays(today, -7) });
    await api("/api/tasks", { token: dad.token });
    // -7, -4, -1 are missed; +2 is the first step landing on or after today
    expect((await row(t.id)).due_on).toBe(addDays(today, 2));
    expect((await misses()).map((x) => x.due_on)).toEqual([addDays(today, -7), addDays(today, -4), addDays(today, -1)]);
  });

  it("is a no-op the second time", async () => {
    const { dad } = await makeHousehold();
    const today = todayIn("UTC");
    const t = await routine(dad, addDays(today, -2));
    await api("/api/tasks", { token: dad.token });
    const before = { task: await row(t.id), misses: await misses() };
    expect(await roll()).toBe(0);
    await api("/api/tasks", { token: dad.token });
    expect(await row(t.id)).toEqual(before.task);
    expect(await misses()).toEqual(before.misses);
  });

  it("leaves done tasks, non-slot recurring tasks, plain tasks and current/future routines alone", async () => {
    const { dad } = await makeHousehold();
    const today = todayIn("UTC");
    const old = addDays(today, -4);
    const done = await routine(dad, old);
    await env.DB.prepare("UPDATE tasks SET done_at = ?1, done_by = ?2 WHERE id = ?3").bind(Date.now(), dad.id, done.id).run();
    const noSlot = await mk(dad, { title: "Water plants", recur: { freq: "daily" }, due_on: old });
    const plain = await mk(dad, { title: "Call plumber", due_on: old });
    const todays = await routine(dad, today);
    const future = await routine(dad, addDays(today, 2));
    await api("/api/tasks", { token: dad.token });
    expect((await row(done.id)).due_on).toBe(old);
    expect((await row(noSlot.id)).due_on).toBe(old);
    expect((await row(plain.id)).due_on).toBe(old);
    expect((await row(todays.id)).due_on).toBe(today);
    expect((await row(future.id)).due_on).toBe(addDays(today, 2));
    expect(await misses()).toHaveLength(0);
  });

  it("gives a rolled task with a time a fresh reminder for today and arms the alarm", async () => {
    const { dad } = await makeHousehold();
    const t = Date.UTC(2030, 5, 10, 6, 0);
    const later = await routine(dad, "2030-06-07", { due_time: "09:00" });
    const earlier = await routine(dad, "2030-06-07", { due_time: "05:00" });
    expect(await roll(t)).toBe(2);
    const a = await row(later.id);
    expect(a.due_on).toBe("2030-06-10");
    expect(a.remind_at).toBe(Date.UTC(2030, 5, 10, 8, 45));
    expect(a.reminded_at).toBeNull();
    // 05:00 today has already passed at 06:00: marked reminded so it never fires late
    const b = await row(earlier.id);
    expect(b.remind_at).toBe(Date.UTC(2030, 5, 10, 4, 45));
    expect(b.reminded_at).toBe(t);
    expect(await getAlarm()).toBe(Date.UTC(2030, 5, 10, 8, 45));
  });

  it("uses the household's day, not UTC's", async () => {
    const { dad } = await makeHousehold();
    expect((await api("/api/household", { method: "PUT", token: dad.token, body: { tz: "Asia/Riyadh" } })).status).toBe(200);
    const t = await routine(dad, "2030-06-09");
    // 22:00 UTC on the 9th is already 01:00 on the 10th in Riyadh
    expect(await roll(Date.UTC(2030, 5, 9, 20, 0))).toBe(0);
    expect(await roll(Date.UTC(2030, 5, 9, 22, 0))).toBe(1);
    expect((await row(t.id)).due_on).toBe("2030-06-10");
    expect((await misses()).map((x) => x.due_on)).toEqual(["2030-06-09"]);
  });

  it("drops a stale item when its series already has an open one on the target day, but still records the misses", async () => {
    const { dad } = await makeHousehold();
    const today = todayIn("UTC");
    const stale = await routine(dad, addDays(today, -2));
    const current = await mk(dad, {
      title: "Pack school bags",
      recur: { freq: "daily" },
      slot: "morning",
      due_on: today,
    });
    await env.DB.prepare("UPDATE tasks SET series_id = ?1 WHERE id = ?2").bind(stale.series_id, current.id).run();
    await api("/api/tasks", { token: dad.token });
    expect(await row(stale.id)).toBeNull();
    expect((await row(current.id)).due_on).toBe(today);
    expect((await misses()).map((x) => x.due_on)).toEqual([addDays(today, -2), addDays(today, -1)]);
  });

  it("ticking a rolled item schedules the next one for tomorrow", async () => {
    const { dad, nanny } = await makeHousehold();
    const today = todayIn("UTC");
    const t = await routine(dad, addDays(today, -2));
    await api("/api/tasks", { token: nanny.token });
    expect((await api(`/api/tasks/${t.id}`, { method: "PATCH", token: nanny.token, body: { done: true } })).status).toBe(200);
    const l = await api("/api/tasks", { token: nanny.token });
    expect(l.json.open.map((x: any) => x.due_on)).toEqual([addDays(today, 1)]);
    expect(await misses()).toHaveLength(2);
  });
});

describe("GET /api/tasks/misses", () => {
  it("lists recent misses newest first for a parent, with the assignee name", async () => {
    const { dad, mom, nanny } = await makeHousehold();
    const today = todayIn("UTC");
    await routine(dad, addDays(today, -3), { assignee_id: nanny.id });
    await mk(dad, { title: "Tidy room", recur: { freq: "daily" }, slot: "evening", due_on: addDays(today, -1) });
    await api("/api/tasks", { token: dad.token });
    // an old miss falls outside the default week
    await env.DB.prepare(
      "INSERT INTO task_misses(id, series_id, task_id, title, due_on, created_at) VALUES ('old','s','t','Ancient',?1,?2)",
    )
      .bind(addDays(today, -20), Date.now())
      .run();

    const r = await api("/api/tasks/misses", { token: mom.token });
    expect(r.status).toBe(200);
    expect(r.json.misses.map((x: any) => x.due_on)).toEqual([
      addDays(today, -1),
      addDays(today, -1),
      addDays(today, -2),
      addDays(today, -3),
    ]);
    const bags = r.json.misses.filter((x: any) => x.title === "Pack school bags");
    expect(bags.map((x: any) => x.due_on)).toEqual([addDays(today, -1), addDays(today, -2), addDays(today, -3)]);
    expect(bags.every((x: any) => x.assignee_name === "Nanny" && x.slot === "morning")).toBe(true);
    expect(r.json.misses.find((x: any) => x.title === "Tidy room").assignee_name).toBeNull();
    expect(r.json.misses.some((x: any) => x.title === "Ancient")).toBe(false);

    const wide = await api("/api/tasks/misses?days=30", { token: dad.token });
    expect(wide.json.misses.some((x: any) => x.title === "Ancient")).toBe(true);
    const one = await api("/api/tasks/misses?days=1", { token: dad.token });
    expect(one.json.misses.map((x: any) => x.due_on)).toEqual([addDays(today, -1), addDays(today, -1)]);
  });

  it("is parents-only and validates days", async () => {
    const { dad, nanny } = await makeHousehold();
    expect((await api("/api/tasks/misses", { token: nanny.token })).status).toBe(403);
    expect((await api("/api/tasks/misses")).status).toBe(401);
    expect((await api("/api/tasks/misses?days=0", { token: dad.token })).status).toBe(400);
    expect((await api("/api/tasks/misses?days=abc", { token: dad.token })).status).toBe(400);
    expect((await api("/api/tasks/misses?days=999", { token: dad.token })).status).toBe(200);
    expect((await api("/api/tasks/misses", { token: dad.token })).json).toEqual({ misses: [] });
  });
});

describe("scheduled handler and retention", () => {
  const run = async (cron: string) => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron, scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
  };

  it("hourly cron rolls routines without running the daily cleanup; the daily cron does both", async () => {
    const { dad } = await makeHousehold();
    const today = todayIn("UTC");
    const t = await routine(dad, addDays(today, -2));
    const oldDone = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO tasks(id, title, created_by, created_at, done_by, done_at) VALUES (?1,'old',?2,1,?2,?3)")
      .bind(oldDone, dad.id, Date.now() - 40 * DAY)
      .run();

    await run("7 * * * *");
    expect((await row(t.id)).due_on).toBe(today);
    expect(await misses()).toHaveLength(2);
    expect(await row(oldDone)).not.toBeNull();

    await env.DB.prepare("UPDATE tasks SET due_on = ?1 WHERE id = ?2").bind(addDays(today, -3), t.id).run(); // -2 and -1 are already recorded
    await run("17 3 * * *");
    expect((await row(t.id)).due_on).toBe(today);
    expect(await misses()).toHaveLength(3);
    expect(await row(oldDone)).toBeNull();
  });

  it("cleanup deletes misses recorded more than 60 days ago", async () => {
    const ins = (id: string, on: string, at: number) =>
      env.DB.prepare("INSERT INTO task_misses(id, series_id, task_id, title, due_on, created_at) VALUES (?1,'s','t','x',?2,?3)")
        .bind(id, on, at)
        .run();
    const t = Date.now();
    await ins("old", "2030-01-01", t - 61 * DAY);
    await ins("new", "2030-01-02", t - 59 * DAY);
    await runCleanup(env, t);
    expect((await misses()).map((x) => x.id)).toEqual(["new"]);
  });
});
